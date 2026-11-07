import { randomUUID } from 'node:crypto'
import type {
  BenchConfig, BenchResult, BenchRun, BenchRunFilter, DecodeLevelResult, DecodePromptType, Engine, PrefillSizeResult, QualityCategory,
  QualityCategoryResult, StartBenchInput, ToolEvalScenarioResult,
} from '../../src/api/types.ts'
import type { FleetDb } from '../fleet/db.ts'
import { median, streamChat, thinkingFlags, type BenchTarget, type StreamResult } from './client.ts'
import {
  REQUEST_SEED, buildLongPrompt, generateSuite, longSizesForContext, scoreItem, type SuiteCategory, type SuiteItem,
} from './vendor/sparkdash/qualitySuite.js'

/** Where a bench sends its requests and what it records about the copy under test. */
export interface ResolvedTarget extends BenchTarget {
  deploymentId: string
  model: string
  engine: Engine
  quant: string
  contextLength: number
  /** head node, or 'gateway' */
  nodeId: string
  /** every node the run occupies */
  nodeIds: string[]
}

export interface BenchHost {
  resolve(input: StartBenchInput): ResolvedTarget
  changed(): void
  activity(text: string, nodeId: string | null): void
  /** run tool-eval-bench against the target */
  toolEval?(target: ResolvedTarget, suite: 'quick' | 'full', runId: string, signal: AbortSignal, onProgress: (p: number, stage: string, scenarios: ToolEvalScenarioResult[]) => void): Promise<ToolEvalScenarioResult[]>
}

const PROMPTS: Record<DecodePromptType, string> = {
  structured: 'Write a detailed, well-organised technical overview of how a GPU executes a matrix multiplication, with headings and bullet points.',
  prose: 'Write a long, flowing short story about a lighthouse keeper who discovers something unexpected washed up on the shore.',
  code: 'Write a complete, well-commented Python implementation of an LRU cache with tests, then explain its complexity.',
  json: 'Produce a large JSON document describing 30 fictional employees: name, role, team, skills (array), start date and a short bio each. Output only JSON.',
}

/** UI quality categories → sparkDash suite categories. */
const SUITE_CATEGORY: Record<QualityCategory, SuiteCategory> = {
  qa: 'qa', reasoning: 'reason', arithmetic: 'arith', state: 'track', gsm8k: 'gsm8k', mmlu: 'mmlu', instruction: 'follow', 'long-recall': 'long',
}
const FILLER = 'the of and to in is you that it he was for on are as with his they at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if will up other about out many then them these so some her would make like him into time'.split(' ')

function filler(tokens: number): string {
  let state = 0x2545f491
  const words: string[] = []
  for (let i = 0; i < tokens; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    words.push(FILLER[(state >>> 8) % FILLER.length])
  }
  return words.join(' ')
}

const QUALITY_CONCURRENCY = 4

export class BenchManager {
  private db: FleetDb
  private host: BenchHost
  private now: () => number
  private aborts = new Map<string, AbortController>()

  constructor(host: BenchHost, db: FleetDb, now: () => number = Date.now) {
    this.host = host
    this.db = db
    this.now = now
    db.db.exec('CREATE TABLE IF NOT EXISTS bench_runs (id TEXT PRIMARY KEY, started INTEGER NOT NULL, data TEXT NOT NULL)')
    // runs cut off by a restart can't resume
    for (const r of this.all().filter((x) => x.status === 'running')) {
      this.save({ ...r, status: 'failed', stage: null, finishedAt: this.now(), error: 'SparkMan restarted during the run' })
    }
  }

  private all(): BenchRun[] {
    return (this.db.db.prepare('SELECT data FROM bench_runs ORDER BY started DESC').all() as { data: string }[]).map((r) => JSON.parse(r.data) as BenchRun)
  }

  private save(r: BenchRun): void {
    this.db.db.prepare('INSERT OR REPLACE INTO bench_runs (id, started, data) VALUES (?, ?, ?)').run(r.id, r.startedAt, JSON.stringify(r))
    this.host.changed()
  }

  list(filter: BenchRunFilter = {}): BenchRun[] {
    return this.all().filter((r) => (!filter.nodeId || r.nodeId === filter.nodeId) && (!filter.model || r.model === filter.model) && (!filter.kind || r.kind === filter.kind))
  }

  get(id: string): BenchRun | null {
    return this.all().find((r) => r.id === id) ?? null
  }

  start(input: StartBenchInput): BenchRun {
    const t = this.host.resolve(input)
    const busy = this.all().find((r) => r.status === 'running' && r.nodeIds.some((n) => t.nodeIds.includes(n)))
    if (busy) throw new Error(`A ${busy.kind} bench is already running on ${busy.nodeIds.join(', ')}`)
    const config = input.config
    const empty: BenchResult =
      config.kind === 'decode' ? { kind: 'decode', levels: [] }
        : config.kind === 'prefill' ? { kind: 'prefill', sizes: [], skipped: [] }
          : config.kind === 'quality' ? { kind: 'quality', categories: [], overall: null }
            : { kind: 'tool-eval', categories: [], scenarios: [], score: null }
    const run: BenchRun = {
      id: `bench-${this.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      kind: config.kind, scope: input.scope === 'gateway' ? 'gateway' : 'replica', nodeId: t.nodeId, nodeIds: t.nodeIds,
      deploymentId: t.deploymentId, model: t.model, engine: t.engine, quant: t.quant, contextLength: t.contextLength, config,
      status: 'running', progress: 0, stage: 'Starting', startedAt: this.now(), finishedAt: null, error: null, result: empty,
    }
    this.save(run)
    this.host.activity(`${config.kind} bench started on ${t.model} (${t.nodeId})`, t.nodeId === 'gateway' ? null : t.nodeId)
    const ctrl = new AbortController()
    this.aborts.set(run.id, ctrl)
    void this.execute(run, t, ctrl.signal).finally(() => this.aborts.delete(run.id))
    return run
  }

  cancel(id: string): void {
    const r = this.get(id)
    if (!r || r.status !== 'running') throw new Error('That bench is not running')
    this.aborts.get(id)?.abort()
    this.save({ ...r, status: 'cancelled', stage: null, finishedAt: this.now() })
  }

  delete(id: string): void {
    const r = this.get(id)
    if (!r) throw new Error('Bench run not found')
    if (r.status === 'running') throw new Error('Stop the bench before deleting it')
    this.db.db.prepare('DELETE FROM bench_runs WHERE id = ?').run(id)
    this.host.changed()
  }

  /** Persist progress unless the run was cancelled meanwhile. */
  private update(id: string, patch: Partial<BenchRun>): BenchRun | null {
    const cur = this.get(id)
    if (!cur || cur.status !== 'running') return null
    const next = { ...cur, ...patch }
    this.save(next)
    return next
  }

  private async execute(run: BenchRun, t: ResolvedTarget, signal: AbortSignal): Promise<void> {
    try {
      const cfg: BenchConfig = run.config
      if (cfg.kind === 'decode' || cfg.kind === 'prefill') {
        // the first request after a load compiles kernels / CUDA graphs; keep it out of the numbers
        this.update(run.id, { stage: 'Warming up' })
        const w = await streamChat(t, { messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 8, temperature: 0, ...thinkingFlags(false) }, signal, this.now)
        if (signal.aborted) return
        if (!w.ok) throw new Error(`Warm-up request failed: ${w.error}`)
      }
      if (cfg.kind === 'decode') await this.decode(run.id, t, cfg.concurrency, cfg.maxTokens, cfg.promptType, signal)
      else if (cfg.kind === 'prefill') await this.prefill(run.id, t, cfg.contextSizes, signal)
      else if (cfg.kind === 'quality') await this.quality(run.id, t, cfg.categories, signal)
      else await this.toolEval(run.id, t, cfg.suite, signal)
      const done = this.update(run.id, { status: 'completed', progress: 1, stage: null, finishedAt: this.now() })
      if (done) this.host.activity(`${run.kind} bench finished on ${t.model}`, t.nodeId === 'gateway' ? null : t.nodeId)
    } catch (e) {
      if (signal.aborted) return
      this.update(run.id, { status: 'failed', stage: null, finishedAt: this.now(), error: e instanceof Error ? e.message : String(e) })
    }
  }

  private async decode(id: string, t: ResolvedTarget, levels: number[], maxTokens: number, type: DecodePromptType, signal: AbortSignal): Promise<void> {
    const results: DecodeLevelResult[] = []
    const sorted = [...levels].sort((a, b) => a - b)
    for (const [i, c] of sorted.entries()) {
      this.update(id, { stage: `Concurrency ${c} · ${i + 1} of ${sorted.length}`, progress: i / sorted.length })
      const streams = await Promise.all(Array.from({ length: c }, (_, k) =>
        streamChat(t, { messages: [{ role: 'user', content: `${PROMPTS[type]} (variant ${k + 1})` }], max_tokens: maxTokens, temperature: 0, ...thinkingFlags(false) }, signal, this.now)))
      if (signal.aborted) return
      const ok = streams.filter((s) => s.ok && s.firstTokenAt !== null)
      if (!ok.length) throw new Error(`No stream produced tokens at concurrency ${c}: ${streams.find((s) => s.error)?.error ?? 'empty replies'}`)
      const begin = Math.min(...ok.map((s) => s.firstTokenAt!))
      const end = Math.max(...ok.map((s) => s.endedAt))
      const tokens = ok.reduce((a, s) => a + s.completionTokens, 0)
      const perStream = ok.map((s) => s.completionTokens / Math.max(0.001, (s.endedAt - s.firstTokenAt!) / 1000))
      results.push({
        concurrency: c,
        aggregateTokS: tokens / Math.max(0.001, (end - begin) / 1000),
        perStreamTokS: perStream.reduce((a, b) => a + b, 0) / perStream.length,
        ttftP50Ms: median(ok.map((s) => s.firstTokenAt! - s.startedAt)),
        completionTokens: tokens,
        durationMs: Math.max(...streams.map((s) => s.endedAt)) - Math.min(...streams.map((s) => s.startedAt)),
      })
      this.update(id, { result: { kind: 'decode', levels: [...results] }, progress: (i + 1) / sorted.length })
    }
  }

  private async prefill(id: string, t: ResolvedTarget, sizes: number[], signal: AbortSignal): Promise<void> {
    const sizesSorted = [...sizes].sort((a, b) => a - b)
    const limit = t.contextLength || Number.MAX_SAFE_INTEGER
    const fit = sizesSorted.filter((s) => s + 256 <= limit)
    const skipped = sizesSorted.filter((s) => !fit.includes(s))
    const results: PrefillSizeResult[] = []
    this.update(id, { result: { kind: 'prefill', sizes: [], skipped } })
    for (const [i, size] of fit.entries()) {
      this.update(id, { stage: `${Math.round(size / 1024)}k tokens · ${i + 1} of ${fit.length}`, progress: i / fit.length })
      // a fresh salt up front so no earlier prompt is a prefix-cache hit
      const prompt = `[prefill-bench ${randomUUID()}]\nIgnore the filler below. Reply with the single word OK.\n${filler(Math.max(16, size - 40))}\nReply OK.`
      const s: StreamResult = await streamChat(t, { messages: [{ role: 'user', content: prompt }], max_tokens: 1, temperature: 0, ...thinkingFlags(false) }, signal, this.now)
      if (signal.aborted) return
      if (!s.ok) throw new Error(`Prefill at ${size} tokens failed: ${s.error}`)
      const ttft = (s.firstTokenAt ?? s.endedAt) - s.startedAt
      const computed = Math.max(1, (s.promptTokens || size) - s.cachedTokens)
      results.push({ contextTokens: s.promptTokens || size, prefillTokS: computed / Math.max(0.001, ttft / 1000), ttftMs: ttft })
      this.update(id, { result: { kind: 'prefill', sizes: [...results], skipped }, progress: (i + 1) / fit.length })
    }
  }

  private async quality(id: string, t: ResolvedTarget, cats: QualityCategory[], signal: AbortSignal): Promise<void> {
    const suiteCats = cats.map((c) => SUITE_CATEGORY[c])
    const longSizes = suiteCats.includes('long') ? longSizesForContext([32768], t.contextLength || 32768) : []
    const items: SuiteItem[] = generateSuite({ categories: suiteCats, longSizes, longItems: 2 })
    const byCat = new Map<QualityCategory, { items: SuiteItem[]; passed: boolean[]; scored: boolean[]; errors: number; tokens: number; hitMax: number }>()
    for (const c of cats) byCat.set(c, { items: items.filter((it) => it.category === SUITE_CATEGORY[c]), passed: [], scored: [], errors: 0, tokens: 0, hitMax: 0 })
    let lastError = ''
    const total = items.length
    let doneCount = 0
    const results = (): QualityCategoryResult[] =>
      cats.flatMap((c) => {
        const s = byCat.get(c)!
        // a request error says nothing about the model: it is neither a pass nor in the denominator (as in sparkDash)
        const scored = s.scored.filter(Boolean).length
        if (!scored) return []
        const correct = s.passed.filter((p, i) => p && s.scored[i]).length
        return [{ category: c, items: s.items.length, correct, percent: Math.round((correct / scored) * 1000) / 10, meanCompletionTokens: Math.round(s.tokens / scored), hitMaxTokens: s.hitMax, passed: [...s.passed] }]
      })
    for (const c of cats) {
      const s = byCat.get(c)!
      let next = 0
      const worker = async () => {
        while (next < s.items.length && !signal.aborted) {
          const idx = next++
          const item = s.items[idx]
          const prompt = item.category === 'long' ? buildLongPrompt(item) : (item.prompt ?? '')
          const r = await streamChat(t, { messages: [{ role: 'user', content: prompt }], max_tokens: item.maxTokens, temperature: 0, top_p: 1, seed: REQUEST_SEED, ...thinkingFlags(item.thinking) }, signal, this.now)
          s.scored[idx] = r.ok
          s.passed[idx] = r.ok && scoreItem(item, r.text).ok
          if (!r.ok) {
            s.errors++
            lastError = r.error ?? 'request failed'
          }
          s.tokens += r.completionTokens
          if (r.finishReason === 'length') s.hitMax++
          doneCount++
        }
      }
      this.update(id, { stage: `${c} · ${s.items.length} items` })
      await Promise.all(Array.from({ length: QUALITY_CONCURRENCY }, worker))
      if (signal.aborted) return
      if (s.errors === s.items.length) throw new Error(`Every ${c} request failed: ${lastError}`)
      const cr = results()
      this.update(id, { result: { kind: 'quality', categories: cr, overall: cr.length ? Math.round((cr.reduce((a, x) => a + x.percent, 0) / cr.length) * 10) / 10 : null }, progress: doneCount / total })
    }
  }

  private async toolEval(id: string, t: ResolvedTarget, suite: 'quick' | 'full', signal: AbortSignal): Promise<void> {
    if (!this.host.toolEval) throw new Error('tool-eval-bench is not installed on the SparkMan host')
    const rows = await this.host.toolEval(t, suite, id, signal, (p, stage, scenarios) => this.update(id, { progress: p, stage, result: toolEvalResult(scenarios) }))
    if (signal.aborted) return
    this.update(id, { result: toolEvalResult(rows) })
  }
}

/** Scenario rows → per-category pass/partial/fail and the 0–100 score (2 points per scenario). */
export function toolEvalResult(rows: ToolEvalScenarioResult[]): BenchResult {
  const cats = [...new Set(rows.map((x) => x.category))].sort()
  const categories = cats.map((c) => {
    const xs = rows.filter((x) => x.category === c)
    const pass = xs.filter((x) => x.status === 'pass').length
    const partial = xs.filter((x) => x.status === 'partial').length
    return { category: c, pass, partial, fail: xs.length - pass - partial, percent: Math.round(((pass * 2 + partial) / (xs.length * 2)) * 1000) / 10 }
  })
  const score = rows.length ? Math.round((rows.reduce((a, x) => a + x.points, 0) / (rows.length * 2)) * 1000) / 10 : null
  return { kind: 'tool-eval', categories, scenarios: rows, score }
}
