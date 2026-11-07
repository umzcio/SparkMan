import {
  QUALITY_CATEGORIES, QUALITY_LABEL, TOOL_EVAL_CATEGORIES, fittingContextSizes, formatContextSize, toolEvalScenarioCount,
} from '@/lib/bench'
import type {
  BenchConfig, BenchResult, CatalogModel, DecodeBenchConfig, DecodeLevelResult, DecodePromptType, Engine, PrefillBenchConfig, PrefillBenchResult,
  PrefillSizeResult, QualityBenchConfig, QualityCategory, QualityCategoryResult, ScenarioStatus, ToolEvalBenchConfig,
  ToolEvalCategory, ToolEvalCategoryResult, ToolEvalScenarioResult,
} from '../types'
import { clamp, noise } from './rng'

/**
 * Deterministic bench model for the simulator. Numbers are shaped by what drives them on a GB10:
 * decode is memory-bandwidth bound (active parameter bytes per token), prefill is compute bound,
 * quality / tool-calling track model capability. Live load and thermal throttling slow a run down.
 */

/** wall-clock per stage, so a default run finishes in a few seconds */
export const BENCH_STAGE_MS: Record<BenchConfig['kind'], number> = { decode: 900, prefill: 700, quality: 1100, 'tool-eval': 450 }

const GB10_BANDWIDTH_GBS = 273
const BANDWIDTH_EFFICIENCY = 0.62

/** active parameters (billions) per token; MoE models activate a fraction of their weights */
const ACTIVE_PARAMS_B: Record<string, number> = {
  'qwen3-235b-a22b': 22, 'gpt-oss-120b': 5.1, 'gpt-oss-20b': 3.6, 'qwen3-coder-30b-a3b': 3.3, 'qwen3.6-35b-a3b': 3,
  'llama-3.1-8b-instruct': 8, 'mistral-small-3.2-24b': 24, 'nemotron-nano-9b-v2': 9, 'deepseek-v3.1': 37,
}

/** rough benchmark-suite strength, 0..1 */
const CAPABILITY: Record<string, number> = {
  'qwen3-235b-a22b': 0.88, 'gpt-oss-120b': 0.86, 'gpt-oss-20b': 0.78, 'qwen3-coder-30b-a3b': 0.74, 'qwen3.6-35b-a3b': 0.82,
  'llama-3.1-8b-instruct': 0.6, 'mistral-small-3.2-24b': 0.71, 'nemotron-nano-9b-v2': 0.69, 'deepseek-v3.1': 0.9,
}

const BYTES_PER_PARAM: Record<string, number> = { NVFP4: 0.56, MXFP4: 0.53, Q4_K_M: 0.6, FP8: 1, FP16: 2, BF16: 2 }
const QUANT_PENALTY: Record<string, number> = { NVFP4: 0.01, MXFP4: 0, Q4_K_M: 0.025, FP8: 0.005, FP16: 0, BF16: 0 }

const DECODE_ENGINE: Record<Engine, { speed: number; contention: number; slots: number }> = {
  vLLM: { speed: 1, contention: 0.12, slots: Infinity },
  SGLang: { speed: 1.04, contention: 0.1, slots: Infinity },
  NIM: { speed: 1.08, contention: 0.11, slots: Infinity },
  // Ollama serves OLLAMA_NUM_PARALLEL=4 requests at once; the rest queue
  Ollama: { speed: 0.9, contention: 0.3, slots: 4 },
  // the simulator never deploys these; they exist on real fleets
  'llama-swap': { speed: 1, contention: 0.12, slots: Infinity },
  TensorFold: { speed: 1.1, contention: 0.1, slots: Infinity },
  'llama.cpp': { speed: 0.85, contention: 0.3, slots: 4 },
  Script: { speed: 1, contention: 0.12, slots: Infinity },
}
const PREFILL_ENGINE: Record<Engine, number> = { vLLM: 1, SGLang: 1.08, NIM: 1.1, Ollama: 0.55, 'llama-swap': 1, TensorFold: 1.05, 'llama.cpp': 0.5, Script: 1 }
const PROMPT: Record<DecodePromptType, { tokens: number; speed: number }> = {
  structured: { tokens: 180, speed: 1 },
  prose: { tokens: 120, speed: 0.98 },
  code: { tokens: 260, speed: 0.96 },
  json: { tokens: 200, speed: 1.02 },
}
const QUALITY_OFFSET: Record<QualityCategory, number> = {
  qa: 0.08, reasoning: -0.06, arithmetic: -0.14, state: -0.1, gsm8k: 0.04, mmlu: -0.05, instruction: -0.08, 'long-recall': -0.12,
}
const TOOL_OFFSET: Record<ToolEvalCategory, number> = {
  A: 0.1, B: 0.04, C: -0.06, D: -0.04, E: -0.08, F: 0.02, G: -0.03, H: 0.03, I: -0.05, J: 0, K: 0.02, L: -0.1, M: -0.14, N: -0.02, O: 0.05,
}

export interface BenchTarget {
  nodeId: string
  model: CatalogModel
  engine: Engine
  /** nodes in the replica serving this model (tensor parallel over ConnectX-7) */
  nodesPerReplica: number
  /** 0..1 GPU busy from live traffic when the run starts */
  load: number
  thermal: boolean
}

export interface BenchPlan {
  stageMs: number
  stages: string[]
  /** result once every stage is done; stage i lands after (i + 1) · stageMs */
  result: BenchResult
}

const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits
const activeParams = (m: CatalogModel) => ACTIVE_PARAMS_B[m.id] ?? m.sizeGB / (BYTES_PER_PARAM[m.quant] ?? 1)
const capability = (m: CatalogModel) => (CAPABILITY[m.id] ?? 0.7) - (QUANT_PENALTY[m.quant] ?? 0.01)
const envFactor = (t: BenchTarget, loadWeight: number) => (1 - loadWeight * clamp(t.load, 0, 1)) * (t.thermal ? 0.82 : 1)
/** ±spread/2 multiplicative run-to-run jitter */
const jitter = (spread: number, ...parts: (string | number)[]) => 1 + (noise(...parts) - 0.5) * spread

function prefillBase(t: BenchTarget): number {
  const tp = t.nodesPerReplica ** 0.8
  return (18_000 / activeParams(t.model)) * PREFILL_ENGINE[t.engine] * tp * envFactor(t, 0.3)
}

function prefillRate(t: BenchTarget, ctx: number): number {
  const warm = ctx < 2048 ? 0.8 : 1 // short prompts under-fill the GPU
  return (prefillBase(t) / (1 + ctx / 90_000)) * warm
}

function planDecode(seed: number, runKey: string, t: BenchTarget, c: DecodeBenchConfig): BenchPlan {
  const n = t.nodesPerReplica
  const bytesPerNode = (activeParams(t.model) * (BYTES_PER_PARAM[t.model.quant] ?? 1)) / n
  const eng = DECODE_ENGINE[t.engine]
  const prompt = PROMPT[c.promptType]
  const kvSlowdown = 1 - 0.04 * (c.maxTokens / 2048)
  const single = ((GB10_BANDWIDTH_GBS * BANDWIDTH_EFFICIENCY) / bytesPerNode / (1 + 0.3 * (n - 1))) * eng.speed * prompt.speed * kvSlowdown * envFactor(t, 0.35)
  const levels: DecodeLevelResult[] = c.concurrency.map((conc) => {
    const active = Math.min(conc, eng.slots)
    const activeAgg = (single * active) / (1 + (active - 1) * eng.contention)
    const aggregate = activeAgg * jitter(0.06, seed, runKey, 'decode', conc)
    const perStreamActive = aggregate / active
    const queueWaitMs = conc > eng.slots ? (Math.ceil(conc / eng.slots) - 1) * (c.maxTokens / perStreamActive) * 1000 * 0.5 : 0
    const ttft = 25 + ((prompt.tokens * active) / prefillRate(t, prompt.tokens)) * 1000 + queueWaitMs
    const completionTokens = Math.round(conc * c.maxTokens * (0.92 + noise(seed, runKey, 'stop', conc) * 0.08))
    return {
      concurrency: conc,
      aggregateTokS: round(aggregate),
      perStreamTokS: round(aggregate / conc),
      ttftP50Ms: Math.round(ttft * jitter(0.08, seed, runKey, 'ttft', conc)),
      completionTokens,
      durationMs: Math.round((completionTokens / aggregate) * 1000),
    }
  })
  return {
    stageMs: BENCH_STAGE_MS.decode,
    stages: c.concurrency.map((conc, i) => `Concurrency ${conc} · ${i + 1} of ${c.concurrency.length}`),
    result: { kind: 'decode', levels },
  }
}

function planPrefill(seed: number, runKey: string, t: BenchTarget, c: PrefillBenchConfig): BenchPlan {
  const { fit, skipped } = fittingContextSizes(c.contextSizes, t.model.contextLength)
  const sizes: PrefillSizeResult[] = fit.map((ctx) => {
    const rate = prefillRate(t, ctx) * jitter(0.05, seed, runKey, 'prefill', ctx)
    return { contextTokens: ctx, prefillTokS: Math.round(rate), ttftMs: Math.round((ctx / rate) * 1000 + 20) }
  })
  return {
    stageMs: BENCH_STAGE_MS.prefill,
    stages: fit.map((ctx, i) => `${formatContextSize(ctx)} context · ${i + 1} of ${fit.length}`),
    result: { kind: 'prefill', sizes, skipped },
  }
}

function planQuality(seed: number, runKey: string, t: BenchTarget, c: QualityBenchConfig): BenchPlan {
  const cap = capability(t.model)
  const infos = QUALITY_CATEGORIES.filter((q) => c.categories.includes(q.id))
  const categories: QualityCategoryResult[] = infos.map((info) => {
    const p = clamp(cap + QUALITY_OFFSET[info.id], 0.05, 0.98)
    // item difficulty is fixed per item id (shared by every run); a small per-run wobble flips borderline items
    const passed = Array.from({ length: info.items }, (_, i) => noise(seed, 'quality-item', info.id, i) + (noise(seed, runKey, info.id, i) - 0.5) * 0.1 < p)
    const correct = passed.filter(Boolean).length
    const meanTokens = info.thinking ? (700 + (1 - cap) * 4000) * jitter(0.1, seed, runKey, info.id, 'tok') : 12 + noise(seed, info.id, 'tok') * 40
    const hitMax = info.thinking ? Math.round((info.items - correct) * (0.08 + (1 - cap) * 0.3) * noise(seed, runKey, info.id, 'max')) : 0
    return {
      category: info.id,
      items: info.items,
      correct,
      percent: round((correct / info.items) * 100),
      meanCompletionTokens: Math.round(meanTokens),
      hitMaxTokens: hitMax,
      passed,
    }
  })
  return {
    stageMs: BENCH_STAGE_MS.quality,
    stages: infos.map((info, i) => `${QUALITY_LABEL[info.id]} · ${info.items} items · ${i + 1} of ${infos.length}`),
    result: { kind: 'quality', categories, overall: meanOf(categories.map((x) => x.percent)) },
  }
}

function planToolEval(seed: number, runKey: string, t: BenchTarget, c: ToolEvalBenchConfig): BenchPlan {
  const cap = capability(t.model) - (t.engine === 'Ollama' ? 0.06 : 0)
  const scenarios: ToolEvalScenarioResult[] = TOOL_EVAL_CATEGORIES.flatMap((cat) =>
    Array.from({ length: toolEvalScenarioCount(cat.id, c.suite) }, (_, j) => {
      const r = noise(seed, 'tool-scenario', cat.id, j) + (noise(seed, runKey, cat.id, j) - 0.5) * 0.12
      const p = cap + TOOL_OFFSET[cat.id]
      const status: ScenarioStatus = r < p - 0.1 ? 'pass' : r < p + 0.08 ? 'partial' : 'fail'
      return { id: `TC-${cat.id}-${String(j + 1).padStart(2, '0')}`, category: cat.id, status, points: status === 'pass' ? 2 : status === 'partial' ? 1 : 0 }
    }),
  )
  const categories = TOOL_EVAL_CATEGORIES.map((cat) => toolCategory(cat.id, scenarios))
  return {
    stageMs: BENCH_STAGE_MS['tool-eval'],
    stages: TOOL_EVAL_CATEGORIES.map((cat, i) => `${cat.id} · ${cat.label} · ${i + 1} of ${TOOL_EVAL_CATEGORIES.length}`),
    result: { kind: 'tool-eval', categories, scenarios, score: toolScore(scenarios) },
  }
}

function toolCategory(id: ToolEvalCategory, scenarios: ToolEvalScenarioResult[]): ToolEvalCategoryResult {
  const own = scenarios.filter((s) => s.category === id)
  const count = (st: ScenarioStatus) => own.filter((s) => s.status === st).length
  return { category: id, pass: count('pass'), partial: count('partial'), fail: count('fail'), percent: toolScore(own) ?? 0 }
}

function toolScore(scenarios: ToolEvalScenarioResult[]): number | null {
  if (scenarios.length === 0) return null
  return round((scenarios.reduce((s, x) => s + x.points, 0) / (2 * scenarios.length)) * 100)
}

function meanOf(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((s, v) => s + v, 0) / values.length)
}

export function planBench(seed: number, runKey: string, target: BenchTarget, config: BenchConfig): BenchPlan {
  switch (config.kind) {
    case 'decode':
      return planDecode(seed, runKey, target, config)
    case 'prefill':
      return planPrefill(seed, runKey, target, config)
    case 'quality':
      return planQuality(seed, runKey, target, config)
    case 'tool-eval':
      return planToolEval(seed, runKey, target, config)
  }
}

/** Streams per copy when `total` streams are spread round-robin over `copies` copies. */
export function spreadStreams(total: number, copies: number): number[] {
  return Array.from({ length: copies }, (_, i) => Math.floor(total / copies) + (i < total % copies ? 1 : 0))
}

/** Extra latency the gateway adds per request (routing + proxy). */
const GATEWAY_HOP_MS = 8

/**
 * A decode or prefill bench through the gateway across every copy of a model. Each copy is planned
 * as if benched alone (its own load, thermals and group size) and the shares are combined.
 */
export function planGatewayBench(seed: number, runKey: string, copies: { target: BenchTarget; nodeIds: string[] }[], config: BenchConfig): BenchPlan {
  if (config.kind === 'decode') {
    const perCopy = copies.map(({ target }, i) => {
      const shares = [...new Set(config.concurrency.flatMap((c) => spreadStreams(c, copies.length)).filter((n) => n > 0))].sort((a, b) => a - b)
      const plan = planDecode(seed, `${runKey}|copy${i}`, target, { ...config, concurrency: shares })
      return new Map((plan.result as { levels: DecodeLevelResult[] }).levels.map((l) => [l.concurrency, l]))
    })
    const levels: DecodeLevelResult[] = config.concurrency.map((conc) => {
      const shares = spreadStreams(conc, copies.length)
      const replicas = copies.flatMap(({ nodeIds }, i) => {
        if (shares[i] === 0) return []
        const l = perCopy[i].get(shares[i])!
        return [{ nodeIds, streams: shares[i], aggregateTokS: l.aggregateTokS, perStreamTokS: l.perStreamTokS, ttftP50Ms: l.ttftP50Ms + GATEWAY_HOP_MS }]
      })
      const aggregate = replicas.reduce((sum, r) => sum + r.aggregateTokS, 0)
      const sorted = replicas.map((r) => r.ttftP50Ms).sort((a, b) => a - b)
      const shareLevels = copies.flatMap((_, i) => (shares[i] > 0 ? [perCopy[i].get(shares[i])!] : []))
      return {
        concurrency: conc,
        aggregateTokS: round(aggregate),
        perStreamTokS: round(aggregate / conc),
        ttftP50Ms: sorted[Math.floor((sorted.length - 1) / 2)],
        completionTokens: shareLevels.reduce((sum, l) => sum + l.completionTokens, 0),
        durationMs: Math.max(...shareLevels.map((l) => l.durationMs)),
        replicas,
      }
    })
    return {
      stageMs: BENCH_STAGE_MS.decode,
      stages: config.concurrency.map((conc, i) => `Concurrency ${conc} over ${copies.length} copies · ${i + 1} of ${config.concurrency.length}`),
      result: { kind: 'decode', levels },
    }
  }
  if (config.kind === 'prefill') {
    const plans = copies.map(({ target }, i) => planPrefill(seed, `${runKey}|copy${i}`, target, config))
    const first = plans[0].result as PrefillBenchResult
    const sizes: PrefillSizeResult[] = first.sizes.map((size, j) => {
      const replicas = copies.map(({ nodeIds }, i) => {
        const r = (plans[i].result as PrefillBenchResult).sizes[j]
        return { nodeIds, prefillTokS: r.prefillTokS, ttftMs: r.ttftMs + GATEWAY_HOP_MS }
      })
      return {
        contextTokens: size.contextTokens,
        prefillTokS: Math.round(replicas.reduce((sum, r) => sum + r.prefillTokS, 0) / replicas.length),
        ttftMs: Math.round(replicas.reduce((sum, r) => sum + r.ttftMs, 0) / replicas.length),
        replicas,
      }
    })
    return {
      stageMs: BENCH_STAGE_MS.prefill * copies.length,
      stages: first.sizes.map((s, i) => `${formatContextSize(s.contextTokens)} context on ${copies.length} copies · ${i + 1} of ${first.sizes.length}`),
      result: { kind: 'prefill', sizes, skipped: [...first.skipped] },
    }
  }
  throw new Error('Gateway runs cover decode and prefill only')
}

/** The result as it stands after `done` stages. */
export function partialResult(full: BenchResult, done: number): BenchResult {
  switch (full.kind) {
    case 'decode':
      return { kind: 'decode', levels: full.levels.slice(0, done) }
    case 'prefill':
      return { kind: 'prefill', sizes: full.sizes.slice(0, done), skipped: [...full.skipped] }
    case 'quality': {
      const categories = full.categories.slice(0, done)
      return { kind: 'quality', categories, overall: meanOf(categories.map((c) => c.percent)) }
    }
    case 'tool-eval': {
      const ids = new Set(TOOL_EVAL_CATEGORIES.slice(0, done).map((c) => c.id))
      const scenarios = full.scenarios.filter((s) => ids.has(s.category))
      return { kind: 'tool-eval', categories: full.categories.filter((c) => ids.has(c.category)), scenarios, score: toolScore(scenarios) }
    }
  }
}
