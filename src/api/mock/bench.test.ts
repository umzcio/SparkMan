import { describe, expect, it } from 'vitest'
import { DEFAULT_CONCURRENCY, DEFAULT_QUALITY_CATEGORIES, QUALITY_CATEGORIES } from '@/lib/bench'
import type { BenchConfig, BenchRun, SimEvent } from '../types'
import { MODEL_CATALOG } from './fixtures'
import { BENCH_STAGE_MS, planBench, type BenchTarget } from './bench'
import { BENCH_HISTORY_LIMIT, REBOOT_MS, SimError, Simulator } from './simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()

const DECODE: BenchConfig = { kind: 'decode', concurrency: DEFAULT_CONCURRENCY, maxTokens: 500, promptType: 'structured' }
const QUALITY: BenchConfig = { kind: 'quality', categories: DEFAULT_QUALITY_CATEGORIES }

function setup(seed = 1729) {
  let t = START
  const sim = new Simulator({ seed, now: () => t })
  const advance = (ms: number) => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 500)
      sim.tick()
    }
  }
  return { sim, advance }
}

const expectSimError = (fn: () => unknown, code: SimError['code']) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SimError)
    expect((e as SimError).code).toBe(code)
    return
  }
  throw new Error(`expected SimError(${code})`)
}

const finish = (sim: Simulator, advance: (ms: number) => void, nodeId: string, deploymentId: string, config: BenchConfig): BenchRun => {
  const run = sim.startBench({ nodeId, deploymentId, config })
  advance(20_000)
  return sim.getBenchRun(run.id)!
}

describe('bench simulation', () => {
  it('runs asynchronously: partial results, progress, then completion', () => {
    const { sim, advance } = setup()
    const run = sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: DECODE })
    expect(run).toMatchObject({ status: 'running', progress: 0, model: 'gpt-oss-120b', engine: 'vLLM', quant: 'MXFP4' })
    expect(run.stage).toMatch(/Concurrency 1/)
    advance(BENCH_STAGE_MS.decode * 2 + 100)
    const mid = sim.getBenchRun(run.id)!
    expect(mid.status).toBe('running')
    expect(mid.progress).toBeGreaterThan(0.3)
    expect(mid.result.kind === 'decode' && mid.result.levels.map((l) => l.concurrency)).toEqual([1, 2])
    advance(BENCH_STAGE_MS.decode * DEFAULT_CONCURRENCY.length)
    const done = sim.getBenchRun(run.id)!
    expect(done.status).toBe('completed')
    expect(done.progress).toBe(1)
    expect(done.stage).toBeNull()
    expect(done.finishedAt).toBe(START + BENCH_STAGE_MS.decode * DEFAULT_CONCURRENCY.length)
    if (done.result.kind !== 'decode') throw new Error('wrong kind')
    expect(done.result.levels).toHaveLength(DEFAULT_CONCURRENCY.length)
    // aggregate throughput rises with concurrency, per-stream throughput falls
    const [first, last] = [done.result.levels[0], done.result.levels.at(-1)!]
    expect(last.aggregateTokS).toBeGreaterThan(first.aggregateTokS * 2)
    expect(last.perStreamTokS).toBeLessThan(first.perStreamTokS)
    expect(first.aggregateTokS).toBeGreaterThan(30)
    expect(first.aggregateTokS).toBeLessThan(90)
  })

  it('is deterministic for the same seed and sequence of actions', () => {
    const a = setup()
    const b = setup()
    const ra = finish(a.sim, a.advance, 'dell-01', 'dep-qwen36', QUALITY)
    const rb = finish(b.sim, b.advance, 'dell-01', 'dep-qwen36', QUALITY)
    expect(ra.result).toEqual(rb.result)
    const other = setup(7)
    expect(finish(other.sim, other.advance, 'dell-01', 'dep-qwen36', QUALITY).result).not.toEqual(ra.result)
  })

  it('repeat quality runs pair item by item and differ only a little', () => {
    const { sim, advance } = setup()
    const a = finish(sim, advance, 'spark-03', 'dep-gptoss120', QUALITY)
    const b = finish(sim, advance, 'spark-03', 'dep-gptoss120', QUALITY)
    if (a.result.kind !== 'quality' || b.result.kind !== 'quality') throw new Error('wrong kind')
    expect(a.result.categories.map((c) => c.items)).toEqual(QUALITY_CATEGORIES.filter((q) => q.defaultOn).map((q) => q.items))
    expect(a.result.overall).not.toBeNull()
    const flatA = a.result.categories.flatMap((c) => c.passed)
    const flatB = b.result.categories.flatMap((c) => c.passed)
    const discordant = flatA.filter((v, i) => v !== flatB[i]).length
    expect(discordant).toBeGreaterThan(0)
    expect(discordant / flatA.length).toBeLessThan(0.15)
  })

  it('bigger models decode slower; Ollama queues beyond four streams', () => {
    const target = (id: string, engine: BenchTarget['engine'], nodes = 1): BenchTarget => ({
      nodeId: 'x', model: MODEL_CATALOG.find((m) => m.id === id)!, engine, nodesPerReplica: nodes, load: 0.2, thermal: false,
    })
    const single = (t: BenchTarget) => {
      const r = planBench(1729, 'k', t, { ...DECODE, concurrency: [1] }).result
      return r.kind === 'decode' ? r.levels[0].aggregateTokS : 0
    }
    expect(single(target('gpt-oss-20b', 'vLLM'))).toBeGreaterThan(single(target('gpt-oss-120b', 'vLLM')))
    expect(single(target('gpt-oss-120b', 'vLLM'))).toBeGreaterThan(single(target('mistral-small-3.2-24b', 'vLLM')))
    expect(single(target('gpt-oss-120b', 'vLLM'))).toBeGreaterThan(single({ ...target('gpt-oss-120b', 'vLLM'), load: 0.9 }))

    const ollama = planBench(1729, 'k', target('qwen3-coder-30b-a3b', 'Ollama'), { ...DECODE, concurrency: [4, 16] }).result
    if (ollama.kind !== 'decode') throw new Error('wrong kind')
    const [four, sixteen] = ollama.levels
    expect(sixteen.aggregateTokS / four.aggregateTokS).toBeLessThan(1.1)
    expect(sixteen.ttftP50Ms).toBeGreaterThan(four.ttftP50Ms * 5)
  })

  it('prefill skips sizes beyond the model context and slows down with context', () => {
    const { sim, advance } = setup()
    const run = finish(sim, advance, 'spark-03', 'dep-gptoss120', { kind: 'prefill', contextSizes: [4096, 32768, 131072, 262144] })
    if (run.result.kind !== 'prefill') throw new Error('wrong kind')
    expect(run.result.sizes.map((s) => s.contextTokens)).toEqual([4096, 32768])
    expect(run.result.skipped).toEqual([131072, 262144])
    const [small, big] = run.result.sizes
    expect(big.prefillTokS).toBeLessThan(small.prefillTokS)
    expect(big.ttftMs).toBeGreaterThan(small.ttftMs)
  })

  it('tool eval scores scenarios pass / partial / fail per category', () => {
    const { sim, advance } = setup()
    const run = finish(sim, advance, 'spark-03', 'dep-gptoss120', { kind: 'tool-eval', suite: 'full' })
    if (run.result.kind !== 'tool-eval') throw new Error('wrong kind')
    expect(run.result.scenarios).toHaveLength(69)
    expect(run.result.categories).toHaveLength(15)
    expect(run.result.categories.reduce((s, c) => s + c.pass + c.partial + c.fail, 0)).toBe(69)
    expect(run.result.score).toBeGreaterThan(0)
    expect(run.result.score).toBeLessThanOrEqual(100)
    expect(new Set(run.result.scenarios.map((s) => s.status)).size).toBeGreaterThan(1)
  })

  it('allows one bench per node (and per multi-node replica) at a time', () => {
    const { sim } = setup()
    sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: DECODE })
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: QUALITY }), 'conflict')
    // the other replica of the same deployment lives on another node and is free
    expect(sim.startBench({ nodeId: 'spark-06', deploymentId: 'dep-gptoss120', config: QUALITY }).status).toBe('running')
    sim.startBench({ nodeId: 'spark-01', deploymentId: 'dep-qwen235', config: DECODE })
    expectSimError(() => sim.startBench({ nodeId: 'spark-02', deploymentId: 'dep-qwen235', config: DECODE }), 'conflict')
  })

  it('validates the target and the config', () => {
    const { sim } = setup()
    expectSimError(() => sim.startBench({ nodeId: 'nope', deploymentId: 'dep-gptoss120', config: DECODE }), 'not_found')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-missing', config: DECODE }), 'not_found')
    expectSimError(() => sim.startBench({ nodeId: 'spark-04', deploymentId: 'dep-gptoss120', config: DECODE }), 'invalid')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { ...DECODE, concurrency: [] } }), 'invalid')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { ...DECODE, concurrency: [5] } }), 'invalid')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { ...DECODE, maxTokens: 4096 } }), 'invalid')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { kind: 'prefill', contextSizes: [262144] } }), 'invalid')
    expectSimError(() => sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { kind: 'quality', categories: [] } }), 'invalid')
    sim.rebootNode('spark-04')
    expectSimError(() => sim.startBench({ nodeId: 'spark-04', deploymentId: 'dep-qwencoder', config: DECODE }), 'conflict')
  })

  it('cancel keeps finished stages and frees the node', () => {
    const { sim, advance } = setup()
    const run = sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: DECODE })
    advance(BENCH_STAGE_MS.decode * 3 + 100)
    sim.cancelBench(run.id)
    const cancelled = sim.getBenchRun(run.id)!
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.result.kind === 'decode' && cancelled.result.levels).toHaveLength(3)
    expect(cancelled.progress).toBeCloseTo(3 / DEFAULT_CONCURRENCY.length)
    advance(20_000)
    expect(sim.getBenchRun(run.id)!.status).toBe('cancelled')
    expectSimError(() => sim.cancelBench(run.id), 'conflict')
    expectSimError(() => sim.cancelBench('bench-missing'), 'not_found')
    expect(sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: DECODE }).status).toBe('running')
  })

  it('fails a run when its node goes away', () => {
    const { sim, advance } = setup()
    const run = sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: QUALITY })
    advance(1500)
    sim.rebootNode('spark-03')
    advance(500)
    const failed = sim.getBenchRun(run.id)!
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/spark-03/)
    advance(REBOOT_MS)
    expect(sim.getBenchRun(run.id)!.status).toBe('failed')
  })

  it('keeps history per node + model, newest first; delete and prune', () => {
    const { sim, advance } = setup()
    const first = finish(sim, advance, 'spark-03', 'dep-gptoss120', { ...DECODE, concurrency: [1] })
    const second = finish(sim, advance, 'spark-03', 'dep-gptoss120', QUALITY)
    finish(sim, advance, 'dell-01', 'dep-qwen36', QUALITY)
    const mine = sim.getBenchRuns({ nodeId: 'spark-03', model: 'gpt-oss-120b' })
    expect(mine.map((r) => r.id)).toEqual([second.id, first.id])
    expect(sim.getBenchRuns({ kind: 'quality' })).toHaveLength(2)

    const running = sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: DECODE })
    expectSimError(() => sim.deleteBenchRun(running.id), 'conflict')
    sim.deleteBenchRun(first.id)
    expect(sim.getBenchRun(first.id)).toBeNull()
    expectSimError(() => sim.deleteBenchRun(first.id), 'not_found')
    sim.cancelBench(running.id)

    for (let i = 0; i < BENCH_HISTORY_LIMIT + 2; i++) finish(sim, advance, 'spark-03', 'dep-gptoss120', { ...DECODE, concurrency: [1] })
    expect(sim.getBenchRuns({ nodeId: 'spark-03', kind: 'decode' })).toHaveLength(BENCH_HISTORY_LIMIT)
    expect(sim.getBenchRun(second.id)).not.toBeNull()
  })

  it('emits benchmarks change events and returns copies', () => {
    const { sim, advance } = setup()
    const seen: SimEvent[] = []
    sim.subscribe((e) => seen.push(e))
    const run = sim.startBench({ nodeId: 'spark-03', deploymentId: 'dep-gptoss120', config: { ...DECODE, concurrency: [1] } })
    expect(seen).toContainEqual({ type: 'changed', topic: 'benchmarks' })
    seen.length = 0
    advance(BENCH_STAGE_MS.decode + 500)
    expect(seen).toContainEqual({ type: 'changed', topic: 'benchmarks' })
    expect(sim.getActivity(5).some((a) => a.kind === 'bench' && a.text.includes('finished'))).toBe(true)
    const copy = sim.getBenchRun(run.id)!
    if (copy.result.kind === 'decode') copy.result.levels.length = 0
    const again = sim.getBenchRun(run.id)!
    expect(again.result.kind === 'decode' && again.result.levels).toHaveLength(1)
  })
})

describe('groups and the gateway', () => {
  it('benches a tensor-parallel group through its head, whichever node you pick, and files it there', () => {
    const { sim, advance } = setup()
    // qwen3-235b runs as one group over spark-01 (head) + spark-02
    const fromWorker = finish(sim, advance, 'spark-02', 'dep-qwen235', DECODE)
    expect(fromWorker).toMatchObject({ scope: 'replica', nodeId: 'spark-01', nodeIds: ['spark-01', 'spark-02'], status: 'completed' })
    finish(sim, advance, 'spark-01', 'dep-qwen235', DECODE)
    expect(sim.getBenchRuns({ nodeId: 'spark-01', model: 'qwen3-235b-a22b' })).toHaveLength(2)
    expect(sim.getBenchRuns({ nodeId: 'spark-02' })).toHaveLength(0)
  })

  it('spreads gateway decode streams round-robin over every copy and sums their throughput', () => {
    const { sim, advance } = setup()
    // gpt-oss-120b has two single-node copies: spark-03 and spark-06
    const run = sim.startBench({ scope: 'gateway', deploymentId: 'dep-gptoss120', config: { ...DECODE, concurrency: [1, 3, 8] } as BenchConfig })
    expect(run).toMatchObject({ scope: 'gateway', nodeId: 'gateway', nodeIds: ['spark-03', 'spark-06'] })
    expectSimError(() => sim.startBench({ nodeId: 'spark-06', deploymentId: 'dep-gptoss120', config: DECODE }), 'conflict')
    advance(20_000)
    const done = sim.getBenchRun(run.id)!
    expect(done.status).toBe('completed')
    const levels = done.result.kind === 'decode' ? done.result.levels : []
    expect(levels.map((l) => l.replicas?.map((r) => r.streams))).toEqual([[1], [2, 1], [4, 4]])
    for (const l of levels) expect(l.aggregateTokS).toBeCloseTo(l.replicas!.reduce((s, r) => s + r.aggregateTokS, 0), 0)
    // two copies beat one at the same concurrency
    const single = finish(sim, advance, 'spark-03', 'dep-gptoss120', { ...DECODE, concurrency: [8] } as BenchConfig)
    expect(levels[2].aggregateTokS).toBeGreaterThan(single.result.kind === 'decode' ? single.result.levels[0].aggregateTokS : Infinity)
    expect(sim.getBenchRuns({ nodeId: 'gateway', model: 'gpt-oss-120b' })).toHaveLength(1)
  })

  it('sends each prefill size to every copy through the gateway', () => {
    const { sim, advance } = setup()
    const run = sim.startBench({ scope: 'gateway', deploymentId: 'dep-gptoss120', config: { kind: 'prefill', contextSizes: [4096, 32768] } })
    advance(60_000)
    const done = sim.getBenchRun(run.id)!
    const sizes = done.result.kind === 'prefill' ? done.result.sizes : []
    expect(sizes).toHaveLength(2)
    expect(sizes[0].replicas?.map((r) => r.nodeIds)).toEqual([['spark-03'], ['spark-06']])
  })

  it('refuses gateway runs that make no sense', () => {
    const { sim } = setup()
    expectSimError(() => sim.startBench({ scope: 'gateway', deploymentId: 'dep-gptoss120', config: QUALITY }), 'invalid')
    expectSimError(() => sim.startBench({ scope: 'gateway', deploymentId: 'dep-qwen235', config: DECODE }), 'invalid')
  })
})
