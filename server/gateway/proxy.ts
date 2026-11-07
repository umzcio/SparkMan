import { Hono, type Context } from 'hono'
import type { LogLine } from '../../src/api/types.ts'
import { patternOf } from '../fleet/logs.ts'
import type { GatewayDb, RequestRow, RouteTable, RouteTarget } from './store.ts'

export interface Usage {
  promptTokens: number
  cachedTokens: number
  completionTokens: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** usage from an OpenAI or Anthropic response body (or one streamed event). */
export function usageOf(v: unknown): Usage | null {
  const o = (v ?? {}) as Record<string, unknown>
  const u = (o.usage ?? (o.message as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  if ('input_tokens' in u || 'output_tokens' in u) {
    // Anthropic: input_tokens excludes cache reads and writes
    const cached = num(u.cache_read_input_tokens)
    return { promptTokens: num(u.input_tokens) + cached + num(u.cache_creation_input_tokens), cachedTokens: cached, completionTokens: num(u.output_tokens) }
  }
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined
  return { promptTokens: num(u.prompt_tokens), cachedTokens: num(details?.cached_tokens), completionTokens: num(u.completion_tokens) }
}

/** True for a streamed event that carries generated text (marks time to first token). */
export function isContentEvent(v: unknown): boolean {
  const o = (v ?? {}) as Record<string, unknown>
  if (o.type === 'content_block_delta') return true
  const choices = o.choices as { delta?: Record<string, unknown>; text?: string }[] | undefined
  return Array.isArray(choices) && choices.some((c) => Boolean(c.text) || Boolean(c.delta?.content) || Boolean(c.delta?.reasoning_content) || Boolean(c.delta?.reasoning) || Array.isArray(c.delta?.tool_calls))
}

/**
 * Follows an SSE stream byte for byte and keeps the running usage. Anthropic splits usage across
 * message_start (input) and message_delta (output); OpenAI sends it in the final chunk.
 */
export class SseUsageTap {
  private buf = ''
  private decoder = new TextDecoder()
  usage: Usage = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 }
  firstContentAt: number | null = null
  private now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  push(chunk: Uint8Array): void {
    this.buf += this.decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let v: unknown
      try {
        v = JSON.parse(data)
      } catch {
        continue
      }
      if (this.firstContentAt === null && isContentEvent(v)) this.firstContentAt = this.now()
      const u = usageOf(v)
      if (!u) continue
      const t = (v as { type?: string }).type
      if (t === 'message_delta') this.usage.completionTokens = Math.max(this.usage.completionTokens, u.completionTokens)
      else if (t === 'message_start') this.usage = { ...u, completionTokens: Math.max(this.usage.completionTokens, u.completionTokens) }
      else this.usage = u
    }
  }
}

export interface GatewayOptions {
  now?: () => number
  fetch?: typeof fetch
  /** request log lines (source "gateway") */
  log?: (line: LogLine) => void
  /** how stale the route table may be before the gateway refuses to route */
  maxRouteAgeMs?: number
}

const PROXIED = new Set(['chat/completions', 'completions', 'embeddings', 'messages'])

function oaiError(c: Context, status: number, message: string, type = 'invalid_request_error') {
  return c.json({ error: { message, type, code: status } }, status as 400)
}

/** The OpenAI- and Anthropic-compatible front door: keys, routing by model, usage capture. */
export function createGatewayApp(db: GatewayDb, opts: GatewayOptions = {}): Hono {
  const app = new Hono()
  const now = opts.now ?? Date.now
  const doFetch = opts.fetch ?? fetch
  const inflight = new Map<string, number>()
  const recent = new Map<string, number[]>()

  const keyOf = (c: Context) => {
    const auth = c.req.header('authorization')
    const bearer = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
    return db.authenticate(bearer ?? c.req.header('x-api-key')?.trim() ?? '')
  }

  const limited = (keyId: string, rpm: number) => {
    const t = now()
    const hits = (recent.get(keyId) ?? []).filter((x) => x > t - 60_000)
    if (hits.length >= rpm) {
      recent.set(keyId, hits)
      return true
    }
    hits.push(t)
    recent.set(keyId, hits)
    return false
  }

  const targetsFor = (model: string): RouteTarget[] => {
    const table = db.routes()
    if (now() - table.updatedAt > (opts.maxRouteAgeMs ?? 5 * 60_000)) return []
    return [...(table.models[model] ?? [])].sort((a, b) => (inflight.get(a.baseUrl) ?? 0) - (inflight.get(b.baseUrl) ?? 0))
  }

  const record = (row: RequestRow, keyName: string | null) => {
    db.addRequest(row)
    if (!opts.log) return
    const level = row.status >= 500 ? 'error' : row.status >= 400 ? 'warn' : 'info'
    const message = `POST /v1/${row.path} ${row.status} ${row.latencyMs}ms model=${row.model}${row.nodeId ? ` upstream=${row.nodeId}` : ''}${row.error ? ` ${row.error}` : ''}`
    opts.log({
      id: '', ts: row.ts, level, source: 'gateway', host: 'gateway', service: 'gateway', message, pattern: patternOf('gateway', `${row.path} ${row.status} ${level}`),
      attributes: { model: row.model, 'http.status_code': String(row.status), ...(row.nodeId ? { upstream: row.nodeId } : {}), ...(keyName ? { key: keyName } : {}) },
    })
  }

  const models = (c: Context) => {
    const key = keyOf(c)
    if (!key) return oaiError(c, 401, 'Invalid or missing API key', 'authentication_error')
    const created = Math.floor(now() / 1000)
    const data = Object.entries(db.routes().models).sort(([a], [b]) => a.localeCompare(b)).map(([id, targets]) => {
      const ctx = Math.max(0, ...targets.map((t) => t.contextLength ?? 0))
      // vLLM's field name, which most clients already read
      return { id, object: 'model', created, owned_by: 'sparkman', ...(ctx ? { max_model_len: ctx } : {}) }
    })
    return c.json({ object: 'list', data })
  }

  /**
   * Kimi Code's custom registry (/provider → Custom registry (api.json)): one OpenAI provider with every
   * routable model. Kimi Code sends the same Bearer key here and to the models, and refreshes on startup.
   */
  const registry = (c: Context) => {
    const key = keyOf(c)
    if (!key) return oaiError(c, 401, 'Invalid or missing API key', 'authentication_error')
    return c.json(registryJson(publicBase(c), db.routes().models))
  }

  const proxy = async (c: Context) => {
    const path = c.req.path.replace(/^\/v1\//, '').replace(/^\//, '')
    if (!PROXIED.has(path)) return oaiError(c, 404, `Unknown endpoint /v1/${path}`)
    const key = keyOf(c)
    if (!key) return oaiError(c, 401, 'Invalid or missing API key', 'authentication_error')
    if (limited(key.id, key.rpm)) return oaiError(c, 429, `Rate limit: ${key.rpm} requests per minute for this key`, 'rate_limit_error')
    db.touchKey(key.id, now())
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body.model !== 'string') return oaiError(c, 400, 'Request body must be JSON with a "model"')
    const model = body.model
    const targets = targetsFor(model)
    const started = now()
    if (!targets.length) {
      record({ ts: started, keyId: key.id, model, deploymentId: null, nodeId: null, path, status: 404, latencyMs: 0, ttftMs: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, error: 'no route' }, key.name)
      return oaiError(c, 404, `Model "${model}" is not served by this gateway. GET /v1/models lists what is.`, 'not_found_error')
    }
    const stream = body.stream === true
    if (stream && (path === 'chat/completions' || path === 'completions')) {
      body.stream_options = { ...((body.stream_options as object | undefined) ?? {}), include_usage: true }
    }
    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true })

    let lastError = 'upstream unavailable'
    for (const target of targets.slice(0, 2)) {
      const upstreamBody = JSON.stringify({ ...body, model: target.upstreamModel })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      for (const h of ['anthropic-version', 'anthropic-beta', 'accept']) {
        const v = c.req.header(h)
        if (v) headers[h] = v
      }
      inflight.set(target.baseUrl, (inflight.get(target.baseUrl) ?? 0) + 1)
      const release = () => inflight.set(target.baseUrl, Math.max(0, (inflight.get(target.baseUrl) ?? 1) - 1))
      let res: Response
      try {
        res = await doFetch(`${target.baseUrl}/${path}`, { method: 'POST', headers, body: upstreamBody, signal: abort.signal })
      } catch (e) {
        release()
        lastError = e instanceof Error ? e.message : String(e)
        if (abort.signal.aborted) break
        continue // connection failed before any byte: try the next copy
      }
      const base: Omit<RequestRow, 'status' | 'latencyMs' | 'ttftMs' | 'promptTokens' | 'cachedTokens' | 'completionTokens' | 'error'> = {
        ts: started, keyId: key.id, model, deploymentId: target.deploymentId, nodeId: target.nodeIds[0] ?? null, path,
      }
      const contentType = res.headers.get('content-type') ?? 'application/json'
      if (!stream || !res.body || !contentType.includes('event-stream')) {
        const text = await res.text().catch(() => '')
        release()
        let usage: Usage | null = null
        try {
          usage = usageOf(JSON.parse(text))
        } catch {
          // non-JSON error body
        }
        const latency = now() - started
        record({ ...base, status: res.status, latencyMs: latency, ttftMs: res.ok ? latency : null, promptTokens: usage?.promptTokens ?? 0, cachedTokens: usage?.cachedTokens ?? 0, completionTokens: usage?.completionTokens ?? 0, error: res.ok ? null : text.slice(0, 200) }, key.name)
        return new Response(text, { status: res.status, headers: { 'content-type': contentType } })
      }
      const tap = new SseUsageTap(now)
      const reader = res.body.getReader()
      const out = new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          try {
            const { done, value } = await reader.read()
            if (done) {
              finish(null)
              ctrl.close()
              return
            }
            tap.push(value)
            ctrl.enqueue(value)
          } catch (e) {
            finish(e instanceof Error ? e.message : String(e))
            ctrl.error(e)
          }
        },
        cancel() {
          abort.abort()
          finish('client closed the stream')
        },
      })
      let finished = false
      const finish = (error: string | null) => {
        if (finished) return
        finished = true
        release()
        record({
          ...base, status: res.status, latencyMs: now() - started, ttftMs: tap.firstContentAt === null ? null : tap.firstContentAt - started,
          promptTokens: tap.usage.promptTokens, cachedTokens: tap.usage.cachedTokens, completionTokens: tap.usage.completionTokens, error,
        }, key.name)
      }
      return new Response(out, { status: res.status, headers: { 'content-type': contentType, 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } })
    }
    record({ ts: started, keyId: key.id, model, deploymentId: targets[0].deploymentId, nodeId: targets[0].nodeIds[0] ?? null, path, status: 502, latencyMs: now() - started, ttftMs: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, error: lastError.slice(0, 200) }, key.name)
    return oaiError(c, 502, `Upstream for "${model}" is unreachable: ${lastError}`, 'api_error')
  }

  // tailscale serve may or may not strip the /v1 mount point: answer both
  for (const prefix of ['/v1', '']) {
    app.get(`${prefix}/models`, models)
    app.get(`${prefix}/registry/api.json`, registry)
    app.post(`${prefix}/*`, proxy)
  }
  app.get('/healthz', (c) => c.json({ ok: true, models: Object.keys(db.routes().models).length }))
  app.all('*', (c) => oaiError(c, 404, 'Not found'))
  return app
}

/** The gateway's address as the client reached it: tailscale serve mounts it at https://<host>/v1. */
export function publicBase(c: Context): string {
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '127.0.0.1'
  const proto = c.req.header('x-forwarded-proto') ?? (host.endsWith('.ts.net') ? 'https' : 'http')
  return `${proto}://${host}/v1`
}

/** Chat models only: embedding models answer /v1/embeddings, so they stay out of chat clients' model pickers. */
function chatModels(models: RouteTable['models']): [string, RouteTarget[]][] {
  return Object.entries(models).filter(([id, targets]) => !targets.some((t) => t.embedding) && !/embed/i.test(id)).sort(([a], [b]) => a.localeCompare(b))
}

export function registryJson(base: string, models: RouteTable['models']) {
  const entries = chatModels(models).map(([id, targets]) => {
    const t = targets[0]
    const ctx = Math.max(0, ...targets.map((x) => x.contextLength ?? 0))
    const out = targets.find((x) => x.maxOutput)?.maxOutput ?? 0
    // unknown caps: tools only, which is what Kimi Code assumes for a model without any
    const caps = t.caps ?? ['tools']
    const limit = { ...(ctx ? { context: ctx } : {}), ...(out ? { output: out } : {}) }
    return [id, {
      id,
      name: t.label ?? id,
      ...(Object.keys(limit).length ? { limit } : {}),
      // Kimi Code drops tool use unless tool_call says so, so always say
      tool_call: caps.includes('tools'),
      reasoning: caps.includes('thinking'),
      modalities: { input: caps.includes('images') ? ['text', 'image'] : ['text'], output: ['text'] },
    }] as const
  })
  return { sparkman: { id: 'sparkman', name: 'SparkMan', type: 'openai', api: base, env: ['SPARKMAN_API_KEY'], models: Object.fromEntries(entries) } }
}

/** a context window clients can plan around when the engine reports none */
const FALLBACK_CONTEXT = 131072
const FALLBACK_OUTPUT = 32768

/**
 * opencode's org discovery (GET /.well-known/opencode, read by `opencode auth login <origin>`). opencode
 * needs an auth command that prints the key: it can't prompt, so it takes SPARKMAN_API_KEY from the
 * login shell and stores it. The config then reads that stored key as {env:SPARKMAN_API_KEY}, and
 * opencode refetches this every 10 minutes, so started and stopped models follow.
 */
export function opencodeManifest(origin: string, models: RouteTable['models']) {
  const entries = chatModels(models).map(([id, targets]) => {
    const t = targets[0]
    const caps = t.caps ?? ['tools']
    const context = Math.max(0, ...targets.map((x) => x.contextLength ?? 0)) || FALLBACK_CONTEXT
    const output = Math.min(targets.find((x) => x.maxOutput)?.maxOutput ?? FALLBACK_OUTPUT, context)
    return [id, {
      name: t.label ?? id,
      tool_call: caps.includes('tools'),
      // thinking models stream their reasoning beside the answer: current vLLM as `reasoning`,
      // SGLang, TensorFold and llama.cpp as `reasoning_content`
      ...(caps.includes('thinking') ? { interleaved: { field: t.engine === 'vLLM' ? 'reasoning' : 'reasoning_content' } } : {}),
      modalities: { input: caps.includes('images') ? ['text', 'image'] : ['text'], output: ['text'] },
      limit: { context, output },
    }] as const
  })
  const check = `[ -n "$SPARKMAN_API_KEY" ] || { echo "Create a key in SparkMan (AI Gateway > API keys), then run: SPARKMAN_API_KEY=<key> opencode auth login ${origin}" >&2; exit 1; }; printf %s "$SPARKMAN_API_KEY"`
  return {
    auth: { command: ['sh', '-c', check], env: 'SPARKMAN_API_KEY' },
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        sparkman: {
          name: 'SparkMan',
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: `${origin}/v1`, apiKey: '{env:SPARKMAN_API_KEY}' },
          models: Object.fromEntries(entries),
        },
      },
    },
  }
}
