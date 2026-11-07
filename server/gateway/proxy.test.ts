// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createGatewayApp, opencodeManifest, SseUsageTap, usageOf } from './proxy.ts'
import { GatewayDb, type RouteTarget } from './store.ts'

const target = (id: string, base: string): RouteTarget => ({ deploymentId: id, engine: 'vLLM', baseUrl: base, nodeIds: [`node-${id}`], upstreamModel: 'up/model' })

function setup(fetchImpl: typeof fetch, targets = [target('a', 'http://a/v1')]) {
  const db = new GatewayDb(':memory:')
  db.setRoutes({ updatedAt: Date.now(), models: { qwen: targets } })
  const { secret, key } = db.createKey('laptop', 60)
  const logs: string[] = []
  const app = createGatewayApp(db, { fetch: fetchImpl, log: (l) => logs.push(l.message) })
  const post = (path: string, body: unknown, auth = `Bearer ${secret}`) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) })
  return { db, app, secret, key, post, logs }
}

describe('usage parsing', () => {
  it('reads OpenAI and Anthropic usage', () => {
    expect(usageOf({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } })).toEqual({ promptTokens: 100, cachedTokens: 64, completionTokens: 20 })
    expect(usageOf({ usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } })).toEqual({ promptTokens: 100, cachedTokens: 90, completionTokens: 5 })
    expect(usageOf({})).toBeNull()
  })

  it('follows a stream across chunk boundaries', () => {
    let t = 0
    const tap = new SseUsageTap(() => t)
    const enc = new TextEncoder()
    tap.push(enc.encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choi'))
    t = 50
    tap.push(enc.encode('ces":[{"delta":{"content":"Hi"}}]}\n\n'))
    tap.push(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'))
    expect(tap.firstContentAt).toBe(50)
    expect(tap.usage).toEqual({ promptTokens: 12, cachedTokens: 0, completionTokens: 3 })
  })

  it('merges Anthropic message_start and message_delta usage', () => {
    const tap = new SseUsageTap()
    const enc = new TextEncoder()
    tap.push(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"output_tokens":1}}}\n\n'))
    tap.push(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"x"}}\n\n'))
    tap.push(enc.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n'))
    expect(tap.usage).toEqual({ promptTokens: 7, cachedTokens: 0, completionTokens: 42 })
  })
})

describe('gateway', () => {
  it('requires a key and lists served models', async () => {
    const { app, secret } = setup(vi.fn())
    expect((await app.request('/v1/models')).status).toBe(401)
    const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${secret}` } })
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(['qwen'])
    expect((await app.request('/models', { headers: { 'x-api-key': secret } })).status).toBe(200)
  })

  it('serves a Kimi Code registry with each model\'s limits and capabilities, behind the key', async () => {
    const glm: RouteTarget = { ...target('glm', 'http://h/v1'), contextLength: 1048576, maxOutput: 32768, caps: ['tools', 'thinking'], label: 'GLM ring' }
    const { app, db, secret } = setup(vi.fn() as unknown as typeof fetch)
    db.setRoutes({ updatedAt: Date.now(), models: { qwen: [target('a', 'http://a/v1')], 'GLM-5.3-Flash-EXL3': [glm], 'nomic-embed-text:latest': [target('e', 'http://e/v1')] } })
    expect((await app.request('/v1/registry/api.json')).status).toBe(401)
    const res = await app.request('/v1/registry/api.json', { headers: { authorization: `Bearer ${secret}`, host: 'orb.example.ts.net' } })
    const reg = (await res.json()) as { sparkman: { api: string; type: string; models: Record<string, unknown> } }
    expect(reg.sparkman).toMatchObject({ id: 'sparkman', type: 'openai', api: 'https://orb.example.ts.net/v1' })
    expect(reg.sparkman.models['GLM-5.3-Flash-EXL3']).toEqual({
      id: 'GLM-5.3-Flash-EXL3', name: 'GLM ring', limit: { context: 1048576, output: 32768 }, tool_call: true, reasoning: true, modalities: { input: ['text'], output: ['text'] },
    })
    expect(Object.keys(reg.sparkman.models)).toEqual(['GLM-5.3-Flash-EXL3', 'qwen'])
    // nothing known: no limit, tools assumed
    expect(reg.sparkman.models.qwen).toEqual({ id: 'qwen', name: 'qwen', tool_call: true, reasoning: false, modalities: { input: ['text'], output: ['text'] } })
    const models = (await (await app.request('/v1/models', { headers: { authorization: `Bearer ${secret}` } })).json()) as { data: { id: string; max_model_len?: number }[] }
    expect(models.data.find((m) => m.id === 'GLM-5.3-Flash-EXL3')?.max_model_len).toBe(1048576)
  })

  it('proxies a request with the upstream model name and records usage', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).model).toBe('up/model')
      return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
    })
    const { post, db, logs } = setup(fetchMock as unknown as typeof fetch)
    const res = await post('/v1/chat/completions', { model: 'qwen', messages: [] })
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('http://a/v1/chat/completions')
    const [row] = db.requestsBetween(0, Date.now() + 1)
    expect(row).toMatchObject({ model: 'qwen', status: 200, promptTokens: 5, completionTokens: 2, nodeId: 'node-a', deploymentId: 'a' })
    expect(logs[0]).toContain('POST /v1/chat/completions 200')
  })

  it('streams through untouched, asks for usage, and records it at the end', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).stream_options).toEqual({ include_usage: true })
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    })
    const { post, db } = setup(fetchMock as unknown as typeof fetch)
    const res = await post('/chat/completions', { model: 'qwen', stream: true, messages: [] })
    expect(await res.text()).toBe(sse)
    expect(db.requestsBetween(0, Date.now() + 1)[0]).toMatchObject({ promptTokens: 9, completionTokens: 1, status: 200 })
  })

  it('fails over to the next copy when the first is unreachable, and 502s when none answer', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('http://a/')) throw new Error('ECONNREFUSED')
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    const ok = setup(fetchMock as unknown as typeof fetch, [target('a', 'http://a/v1'), target('b', 'http://b/v1')])
    expect((await ok.post('/v1/chat/completions', { model: 'qwen' })).status).toBe(200)
    const down = setup(vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    const res = await down.post('/v1/chat/completions', { model: 'qwen' })
    expect(res.status).toBe(502)
    expect(down.db.requestsBetween(0, Date.now() + 1)[0]).toMatchObject({ status: 502, error: 'ECONNREFUSED' })
  })

  it('404s unknown models, rejects revoked keys and rate-limits', async () => {
    const { post, db, key, secret } = setup(vi.fn(async () => new Response('{}')) as unknown as typeof fetch)
    expect((await post('/v1/chat/completions', { model: 'nope' })).status).toBe(404)
    const limited = db.createKey('tiny', 1)
    expect((await post('/v1/chat/completions', { model: 'qwen' }, `Bearer ${limited.secret}`)).status).toBe(200)
    expect((await post('/v1/chat/completions', { model: 'qwen' }, `Bearer ${limited.secret}`)).status).toBe(429)
    db.revokeKey(key.id)
    expect((await post('/v1/chat/completions', { model: 'qwen' }, `Bearer ${secret}`)).status).toBe(401)
  })

  it('refuses to route on a stale table', async () => {
    const { post, db } = setup(vi.fn(async () => new Response('{}')) as unknown as typeof fetch)
    db.setRoutes({ updatedAt: Date.now() - 10 * 60_000, models: { qwen: [target('a', 'http://a/v1')] } })
    expect((await post('/v1/chat/completions', { model: 'qwen' })).status).toBe(404)
  })
})

describe('opencode discovery', () => {
  const glm: RouteTarget = { ...target('glm', 'http://h/v1'), contextLength: 1048576, maxOutput: 32768, caps: ['tools', 'thinking'], label: 'GLM ring' }
  const glmT: RouteTarget = { ...glm, engine: 'TensorFold' }
  const m = opencodeManifest('https://orb.example.ts.net', { 'GLM-5.3-Flash-EXL3': [glmT], qwen: [target('a', 'http://a/v1')], 'qwen3.8-flash-next': [{ ...target('q', 'http://q/v1'), caps: ['tools', 'thinking'] }], 'nomic-embed-text:latest': [{ ...target('e', 'http://e/v1'), embedding: true }] })

  it('lists the chat models as an OpenAI-compatible provider keyed by the login token', () => {
    const p = m.config.provider.sparkman
    expect(p.options).toEqual({ baseURL: 'https://orb.example.ts.net/v1', apiKey: '{env:SPARKMAN_API_KEY}' })
    expect(Object.keys(p.models)).toEqual(['GLM-5.3-Flash-EXL3', 'qwen', 'qwen3.8-flash-next'])
    // vLLM streams reasoning under its own name
    expect(p.models['qwen3.8-flash-next']).toMatchObject({ interleaved: { field: 'reasoning' } })
    expect(p.models['GLM-5.3-Flash-EXL3']).toEqual({
      name: 'GLM ring', tool_call: true, interleaved: { field: 'reasoning_content' }, modalities: { input: ['text'], output: ['text'] }, limit: { context: 1048576, output: 32768 },
    })
    // nothing known: a window to plan around, no reasoning field
    expect(p.models.qwen).toMatchObject({ limit: { context: 131072, output: 32768 } })
    expect(p.models.qwen).not.toHaveProperty('interleaved')
    expect(m.auth.env).toBe('SPARKMAN_API_KEY')
  })

  it('logs in with the key from the shell, and says what to do without one', () => {
    const [cmd, ...args] = m.auth.command
    expect(execFileSync(cmd, args, { env: { PATH: process.env.PATH, SPARKMAN_API_KEY: 'sk-spark-abc' } }).toString()).toBe('sk-spark-abc')
    let err = ''
    try {
      execFileSync(cmd, args, { env: { PATH: process.env.PATH }, stdio: 'pipe' })
    } catch (e) {
      err = String((e as { stderr: Buffer }).stderr)
    }
    expect(err).toContain('SPARKMAN_API_KEY=<key> opencode auth login https://orb.example.ts.net')
  })
})
