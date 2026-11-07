// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { GatewayDb } from '../gateway/store.ts'
import { FleetDb } from './db.ts'
import { DeploymentManager, type DeployHost } from './deployments.ts'

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })

function setup(opts: { drained?: string[] } = {}) {
  const nodes = [
    { id: 'spark-01', ip: '10.0.0.11', status: 'online', drained: false, memoryGB: 128, memUsedGB: 110 },
    { id: 'spark-02', ip: '10.0.0.12', status: 'online', drained: false, memoryGB: 128, memUsedGB: 108 },
    { id: 'spark-03', ip: '10.0.0.13', status: 'online', drained: false, memoryGB: 128, memUsedGB: 4 },
  ].map((n) => ({ ...n, drained: opts.drained?.includes(n.id) ?? false }))
  const sh = vi.fn(async () => ({ code: 0, stdout: '' }))
  const host: DeployHost = {
    nodes: () => nodes,
    groups: () => [{ id: 'ring', nodeIds: ['spark-01', 'spark-02'] }, { id: 'pair', nodeIds: ['spark-03', 'spark-04'] }],
    sh,
    activity: vi.fn(),
    changed: vi.fn(),
  }
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === 'http://10.0.0.11:9090/v1/models') return json({ data: [{ id: 'glm' }, { id: 'nemotron' }] })
    if (url === 'http://10.0.0.11:9090/running') return json({ running: [{ model: 'glm', state: 'ready' }] })
    if (url === 'http://10.0.0.13:11434/api/tags') return json({ models: [{ name: 'nomic-embed-text:latest', details: { quantization_level: 'F16' } }, { name: 'qwen3:8b', digest: 'abc' }] })
    if (url === 'http://10.0.0.13:11434/api/show') {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model
      return model === 'qwen3:8b'
        ? json({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'qwen3.context_length': 40960 } })
        : json({ capabilities: ['embedding'], model_info: { 'nomic-bert.context_length': 2048 } })
    }
    throw new Error('ECONNREFUSED')
  })
  const gw = new GatewayDb(':memory:')
  const m = new DeploymentManager(host, new FleetDb(':memory:'), gw, { fetch: fetchMock as unknown as typeof fetch })
  return { m, gw, sh, host }
}

describe('DeploymentManager', () => {
  it('discovers llama-swap across its group and Ollama, and routes every swap model', async () => {
    const { m, gw } = setup()
    await m.refresh()
    const deps = m.list()
    expect(deps.map((d) => [d.model, d.engine, d.status, d.replicas[0].nodeIds])).toEqual([
      ['glm', 'llama-swap', 'serving', ['spark-01', 'spark-02']],
      ['nomic-embed-text:latest', 'Ollama', 'serving', ['spark-03']],
      ['qwen3:8b', 'Ollama', 'serving', ['spark-03']],
    ])
    const routes = gw.routes().models
    expect(Object.keys(routes).sort()).toEqual(['glm', 'nemotron', 'nomic-embed-text:latest', 'qwen3:8b'])
    // Ollama says what each model is: its window, what it can do, and which are embedding-only
    expect(routes['qwen3:8b'][0]).toMatchObject({ contextLength: 40960, caps: ['tools', 'thinking'], embedding: false })
    expect(routes['nomic-embed-text:latest'][0]).toMatchObject({ contextLength: 2048, caps: [], embedding: true })
    expect(routes.glm[0]).toMatchObject({ baseUrl: 'http://10.0.0.11:9090/v1', upstreamModel: 'glm' })
    expect(m.nodeDeployment('spark-02')).toMatchObject({ groupId: expect.stringContaining('glm') })
    expect(m.nodeDeployment('spark-03').groupId).toBeNull()
    // Ollama on a pair's head doesn't claim the idle other half
    expect(m.nodeDeployment('spark-04').deploymentId).toBeNull()
  })

  it('keeps drained nodes out of the routes', async () => {
    const { m, gw } = setup({ drained: ['spark-02'] })
    await m.refresh()
    expect(Object.keys(gw.routes().models).sort()).toEqual(['nomic-embed-text:latest', 'qwen3:8b'])
  })

  it('validates new deployments before touching a node', async () => {
    const { m, sh } = setup()
    await m.refresh()
    await expect(m.create({ catalogId: 'nope', engine: 'vLLM', nodeIds: ['spark-03'] })).rejects.toThrow('Unknown catalog')
    await expect(m.create({ catalogId: 'qwen3-0.6b', engine: 'vLLM', nodeIds: ['spark-01'] })).rejects.toThrow('already serves')
    await expect(m.create({ catalogId: 'qwen3-0.6b', engine: 'vLLM', nodeIds: ['spark-01', 'spark-02'] })).rejects.toThrow('one node')
    await expect(m.create({ catalogId: 'qwen3-0.6b', engine: 'vLLM', nodeIds: ['spark-03'] })).rejects.toThrow('already serves')
    expect(sh).not.toHaveBeenCalled()
  })

  it('starts a vLLM container detached and tracks it', async () => {
    const { m, sh, host } = setup()
    ;(host.nodes() as { id: string; memUsedGB: number }[]).push({ id: 'spark-04', ip: '10.0.0.14', status: 'online', drained: false, memoryGB: 128, memUsedGB: 3 } as never)
    await m.refresh()
    const d = await m.create({ catalogId: 'qwen3-0.6b', engine: 'vLLM', nodeIds: ['spark-04'] })
    expect(d).toMatchObject({ model: 'qwen3-0.6b', engine: 'vLLM', status: 'pending', port: 8100 })
    const script = (sh.mock.calls[0] as unknown as [string, string, { input: string }])[2].input
    expect(script).toContain('docker pull vllm/vllm-openai@sha256:')
    expect(script).toContain("'Qwen/Qwen3-0.6B'")
    expect(script).toContain('setsid nohup')
  })

  it('takes tok/s from the engine’s own counter, falls back to the gateway, and reports single-request speed', async () => {
    let t = 1_000_000
    let generated = 5000
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://10.0.0.11:8000/v1/models') return json({ data: [{ id: 'qwen', max_model_len: 262144 }] })
      if (url === 'http://10.0.0.11:8000/metrics') return new Response(`vllm:generation_tokens_total{engine="0",model_name="qwen"} ${generated}\n`)
      if (url === 'http://10.0.0.13:11434/api/tags') return json({ models: [{ name: 'qwen3:8b', digest: 'abc' }] })
      if (url === 'http://10.0.0.13:11434/api/show') return json({ capabilities: ['completion'], model_info: {} })
      throw new Error('ECONNREFUSED')
    })
    const nodes = [
      { id: 'spark-01', ip: '10.0.0.11', status: 'online', drained: false, memoryGB: 128, memUsedGB: 110 },
      { id: 'spark-03', ip: '10.0.0.13', status: 'online', drained: false, memoryGB: 128, memUsedGB: 4 },
    ]
    const host: DeployHost = { nodes: () => nodes, groups: () => [], sh: vi.fn(), activity: vi.fn(), changed: vi.fn() }
    const gw = new GatewayDb(':memory:')
    const rates = () => new Map([['ollama-spark-03-qwen3-8b', { tokensPerSec: 2, requestsPerSec: 0.1 }]])
    const m = new DeploymentManager(host, new FleetDb(':memory:'), gw, { fetch: fetchMock as unknown as typeof fetch, now: () => t, rates })
    const req = { keyId: 'k', model: 'qwen', nodeId: 'spark-01', path: '/v1/chat/completions', promptTokens: 10, cachedTokens: 0, error: null }
    // 401 tokens in 10 s after the first → 40 tok/s; too-short, failed and non-streamed requests don't count
    gw.addRequest({ ...req, ts: t - 5000, deploymentId: 'vllm-spark-01-qwen', status: 200, latencyMs: 10_500, ttftMs: 500, completionTokens: 401 })
    gw.addRequest({ ...req, ts: t - 4000, deploymentId: 'vllm-spark-01-qwen', status: 200, latencyMs: 600, ttftMs: 500, completionTokens: 5 })
    gw.addRequest({ ...req, ts: t - 3000, deploymentId: 'vllm-spark-01-qwen', status: 500, latencyMs: 9000, ttftMs: 100, completionTokens: 900 })
    gw.addRequest({ ...req, ts: t - 2000, deploymentId: 'vllm-spark-01-qwen', status: 200, latencyMs: 3000, ttftMs: 3000, completionTokens: 900 })
    await m.refresh()
    const qwen = () => m.list().find((d) => d.model === 'qwen')!
    expect(qwen()).toMatchObject({ tokensPerSec: 0, tokensPerSecFrom: 'gateway', decodeTokensPerSec: 40 })
    t += 15_000
    generated += 900
    await m.refresh()
    expect(qwen()).toMatchObject({ tokensPerSec: 60, tokensPerSecFrom: 'engine' })
    // Ollama keeps no counter: gateway traffic it is
    expect(m.list().find((d) => d.engine === 'Ollama')).toMatchObject({ tokensPerSec: 2, tokensPerSecFrom: 'gateway', decodeTokensPerSec: null })
  })
})
