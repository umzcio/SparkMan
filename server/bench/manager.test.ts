// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BenchRun, DecodeBenchResult, PrefillBenchResult, QualityBenchResult } from '../../src/api/types.ts'
import { FleetDb } from '../fleet/db.ts'
import { BenchManager, toolEvalResult, type BenchHost, type ResolvedTarget } from './manager.ts'

afterEach(() => vi.unstubAllGlobals())

const target: ResolvedTarget = {
  baseUrl: 'http://up/v1', model: 'm', deploymentId: 'd1', engine: 'vLLM', quant: 'BF16', contextLength: 20_000, nodeId: 'spark-01', nodeIds: ['spark-01'],
}

/** An OpenAI streaming server that answers every request with `reply`. */
function fakeServer(reply: (body: Record<string, unknown>) => string) {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    const text = reply(body)
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  }))
}

function setup(t = target) {
  const host: BenchHost = { resolve: () => t, changed: vi.fn(), activity: vi.fn() }
  return new BenchManager(host, new FleetDb(':memory:'))
}

async function waitDone(m: BenchManager, id: string): Promise<BenchRun> {
  for (let i = 0; i < 400; i++) {
    const r = m.get(id)!
    if (r.status !== 'running') return r
    await new Promise((res) => setTimeout(res, 5))
  }
  throw new Error('bench did not finish')
}

describe('BenchManager', () => {
  it('runs decode levels with aggregate and per-stream tok/s', async () => {
    fakeServer(() => 'hello world')
    const m = setup()
    const run = m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'decode', concurrency: [2, 1], maxTokens: 64, promptType: 'prose' } })
    const done = await waitDone(m, run.id)
    expect(done.status).toBe('completed')
    const r = done.result as DecodeBenchResult
    expect(r.levels.map((l) => l.concurrency)).toEqual([1, 2])
    expect(r.levels[1].completionTokens).toBe(100)
    expect(r.levels[0].aggregateTokS).toBeGreaterThan(0)
  })

  it('skips prefill sizes beyond the context and salts every prompt', async () => {
    const prompts: string[] = []
    fakeServer((b) => {
      prompts.push((b.messages as { content: string }[])[0].content.slice(0, 60))
      return 'OK'
    })
    const m = setup()
    const run = m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'prefill', contextSizes: [1024, 4096, 65536] } })
    const r = (await waitDone(m, run.id)).result as PrefillBenchResult
    expect(r.skipped).toEqual([65536])
    expect(r.sizes).toHaveLength(2)
    const measured = prompts.filter((p) => p.startsWith('[prefill-bench'))
    expect(new Set(measured).size).toBe(2)
    expect(prompts[0]).toBe('Say OK.')
  })

  it('scores quality items with the vendored suite', async () => {
    fakeServer(() => 'Answer: B')
    const m = setup()
    const run = m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'quality', categories: ['mmlu'] } })
    const r = (await waitDone(m, run.id)).result as QualityBenchResult
    expect(r.categories[0]).toMatchObject({ category: 'mmlu', items: 285 })
    expect(r.categories[0].passed).toHaveLength(285)
    // always answering B gets roughly a quarter right
    expect(r.categories[0].percent).toBeGreaterThan(10)
    expect(r.categories[0].percent).toBeLessThan(45)
  })

  it('fails a quality run whose requests all error instead of scoring it 0 %', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('EHOSTUNREACH') }))
    const m = setup()
    const run = m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'quality', categories: ['arithmetic'] } })
    const done = await waitDone(m, run.id)
    expect(done.status).toBe('failed')
    expect(done.error).toContain('EHOSTUNREACH')
  })

  it('refuses a second run on the same node, cancels, and deletes finished runs only', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))))
    const m = setup()
    const run = m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'decode', concurrency: [1], maxTokens: 8, promptType: 'code' } })
    expect(() => m.start({ nodeId: 'spark-01', deploymentId: 'd1', config: { kind: 'prefill', contextSizes: [1024] } })).toThrow('already running')
    expect(() => m.delete(run.id)).toThrow('Stop the bench')
    m.cancel(run.id)
    expect(m.get(run.id)!.status).toBe('cancelled')
    m.delete(run.id)
    expect(m.get(run.id)).toBeNull()
  })

  it('summarises tool-eval scenarios', () => {
    const r = toolEvalResult([
      { id: 'TC-01', category: 'A', status: 'pass', points: 2 },
      { id: 'TC-02', category: 'A', status: 'partial', points: 1 },
      { id: 'TC-03', category: 'B', status: 'fail', points: 0 },
    ])
    expect(r).toMatchObject({ kind: 'tool-eval', score: 50, categories: [{ category: 'A', pass: 1, partial: 1, fail: 0, percent: 75 }, { category: 'B', percent: 0 }] })
  })
})
