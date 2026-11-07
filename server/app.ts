import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SESSION_COOKIE, SESSION_MAX_AGE_S, type AuthStore } from './auth.ts'
import {
  EFFORTS,
  isAgentMode,
  isCodexMode,
  type HostMode,
  type PluginActionBody,
  type PluginInfo,
  type Effort,
  type Capabilities,
  type ContextUsage,
  type CreateSessionBody,
  type EventEnvelope,
  type ForkBody,
  type HealthResponse,
  type ImageAttachment,
  type McpActionBody,
  type McpServerInfo,
  type PermissionDecisionBody,
  type PlanUsage,
  type RewindBody,
  type RewindResult,
  type SendMessageBody,
  type SessionDetail,
  type SessionSummary,
  type SetModeBody,
  type SetModelBody,
  type SetThinkingBody,
} from '../src/agent/protocol.ts'
import { UnsupportedError } from './agent/host-session.ts'
import { ForkError, type SessionStore } from './agent/store.ts'
import { mountFleet } from './fleet/routes.ts'
import type { FleetService } from './fleet/service.ts'
import { opencodeManifest, publicBase } from './gateway/proxy.ts'
import type { GatewayDb } from './gateway/store.ts'

export interface AppConfig {
  store: SessionStore
  /** Codex on the host; its routes (/api/codex) exist only when this is set */
  codexStore?: SessionStore
  /** extra Host names allowed besides loopback names and *.ts.net (e.g. a custom tailnet domain) */
  allowedHosts?: string[]
  /** expose bypassPermissions (opt-in) */
  allowBypass?: boolean
  /** Tailscale logins allowed to use the agent (lower-case). Empty = no tailnet access. */
  allowedUsers: string[]
  defaultCwd: string
  fake: boolean
  /** directory with the built SPA (index.html); omitted in dev */
  staticDir?: string
  /** username/password sign-in; when set, every /api route but /api/auth/* needs a session cookie */
  auth?: AuthStore
  /** the live fleet (phase 2); /api/fleet exists only when set, otherwise the UI runs the simulator */
  fleet?: FleetService
  /** gateway state (routes, keys, request rows) shared with the sparkman-gateway process */
  gateway?: GatewayDb
  /** override for tests; default inspects the socket */
  isLoopback?: (c: Context) => boolean
}

type Env = { Variables: { user: string | null } }

/** Per-agent differences in the session API. */
interface AgentRoutes {
  isMode: (v: unknown) => v is HostMode
  /** the no-guardrails mode, only offered when SPARKMAN_ALLOW_BYPASS=1 */
  optInMode: HostMode
  optInLabel: string
  canFork: boolean
}

const CLAUDE_ROUTES: AgentRoutes = { isMode: isAgentMode, optInMode: 'bypassPermissions', optInLabel: 'Bypass mode', canFork: true }
const CODEX_ROUTES: AgentRoutes = { isMode: isCodexMode, optInMode: 'full-access', optInLabel: 'Full access', canFork: false }

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Hostname from a Host header or Origin URL, lower-cased, without port. */
function hostnameOf(value: string | undefined, isOrigin = false): string | null {
  if (!value) return null
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

function socketIsLoopback(c: Context): boolean {
  try {
    const addr = getConnInfo(c).remote.address
    return addr !== undefined && LOOPBACK.has(addr)
  } catch {
    return false
  }
}

const HEARTBEAT_MS = 15_000
const MAX_IMAGES = 4
// the API's 5 MB image limit applies to the base64 payload
const MAX_IMAGE_BASE64 = 5 * 1024 * 1024
const MAX_MESSAGE_BYTES = MAX_IMAGES * MAX_IMAGE_BASE64 + 256 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isImage = (v: unknown): v is ImageAttachment =>
  isPlainObject(v) && IMAGE_TYPES.has(v.mediaType as string) && typeof v.data === 'string' && v.data.length > 0 && v.data.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/]+=*$/.test(v.data)

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function validateOptions(o: CreateSessionBody['options']): string | null {
  if (o === undefined) return null
  if (!isPlainObject(o)) return 'options must be an object'
  if (o.effort !== undefined && !EFFORTS.includes(o.effort as Effort)) return 'Unknown effort level'
  if (o.maxBudgetUsd !== undefined && !(typeof o.maxBudgetUsd === 'number' && o.maxBudgetUsd > 0 && o.maxBudgetUsd <= 1000)) return 'Budget must be between $0 and $1000'
  if (o.additionalDirectories !== undefined) {
    if (!Array.isArray(o.additionalDirectories) || o.additionalDirectories.length > 20) return 'additionalDirectories must be a list'
    for (const d of o.additionalDirectories) {
      if (typeof d !== 'string' || !path.isAbsolute(d)) return 'Additional directories must be absolute paths'
      if (!isDirectory(d)) return `No such directory: ${d}`
    }
  }
  return null
}

export function createApp(cfg: AppConfig): Hono<Env> {
  const app = new Hono<Env>()
  const isLoopback = cfg.isLoopback ?? socketIsLoopback

  const extraHosts = new Set((cfg.allowedHosts ?? []).map((h) => h.toLowerCase()))
  const hostAllowed = (h: string | null) => h !== null && (LOOPBACK_HOSTNAMES.has(h) || h.endsWith('.ts.net') || extraHosts.has(h))

  // Auth, in order:
  // 1. Every request must arrive on a loopback socket (the server binds 127.0.0.1; tailscale serve
  //    connects from loopback), so a forged identity header from the network is never honoured.
  // 2. Host (and Origin, when sent) must be a loopback name, a *.ts.net tailnet name, or configured:
  //    this defeats DNS rebinding, where a hostile page re-points its own hostname at 127.0.0.1.
  // 3. State-changing requests must be JSON, which browsers cannot send cross-origin without a
  //    CORS preflight (and this server answers no preflights).
  // 4. `tailscale serve` stamps Tailscale-User-Login; it must be on the allow-list. Header-less
  //    requests are accepted only when not proxied (no X-Forwarded-For) — i.e. on the host itself.
  app.use('/api/*', async (c, next) => {
    if (!isLoopback(c)) return c.json({ error: 'Forbidden: connect through tailscale serve.' }, 403)
    // node-server builds c.req.url from the Host header
    if (!hostAllowed(new URL(c.req.url).hostname.toLowerCase())) return c.json({ error: 'Forbidden host. Add it to SPARKMAN_ALLOWED_HOSTS if this is your tailnet name.' }, 403)
    const origin = c.req.header('origin')
    if (origin && !hostAllowed(hostnameOf(origin, true))) return c.json({ error: 'Forbidden origin.' }, 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ error: 'Content-Type must be application/json.' }, 415)
    }
    const login = c.req.header('tailscale-user-login')?.trim().toLowerCase()
    if (login) {
      // with sign-in on, an empty allow-list admits any tailnet login (the password is the gate)
      const listed = cfg.allowedUsers.includes(login) || (cfg.auth !== undefined && cfg.allowedUsers.length === 0)
      if (!listed) {
        return c.json({ error: cfg.allowedUsers.length === 0 ? 'Tailnet access is disabled: set SPARKMAN_ALLOWED_USERS on the host.' : `${login} is not allowed to use this SparkMan host.` }, 403)
      }
      c.set('user', login)
    } else {
      if (c.req.header('x-forwarded-for')) return c.json({ error: 'Forbidden: connect through tailscale serve as an allowed user.' }, 403)
      c.set('user', null)
    }
    // 5. Username/password session (when configured), except for the sign-in endpoints themselves.
    if (cfg.auth && !c.req.path.startsWith('/api/auth/')) {
      const user = cfg.auth.check(getCookie(c, SESSION_COOKIE))
      if (!user) return c.json({ error: 'Sign in to SparkMan.' }, 401)
      c.set('user', user)
    }
    await next()
  })

  if (cfg.auth) {
    const auth = cfg.auth
    const secure = (c: Context) => new URL(c.req.url).hostname.endsWith('.ts.net') || c.req.header('x-forwarded-proto') === 'https'
    app.get('/api/auth/session', (c) => {
      const user = auth.check(getCookie(c, SESSION_COOKIE))
      return c.json({ authEnabled: true, user })
    })
    app.post('/api/auth/login', async (c) => {
      if (auth.throttled()) return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429)
      const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; password?: unknown }
      if (typeof body.username !== 'string' || typeof body.password !== 'string' || !body.username || body.password.length > 1024) {
        return c.json({ error: 'Username and password are required.' }, 400)
      }
      const token = auth.login(body.username.trim(), body.password)
      if (!token) return c.json({ error: 'Wrong username or password.' }, 401)
      setCookie(c, SESSION_COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', secure: secure(c), maxAge: SESSION_MAX_AGE_S })
      return c.json({ user: body.username.trim() })
    })
    app.post('/api/auth/logout', (c) => {
      auth.logout(getCookie(c, SESSION_COOKIE))
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: secure(c) })
      return c.json({ ok: true })
    })
  } else {
    app.get('/api/auth/session', (c) => c.json({ authEnabled: false, user: c.get('user') }))
  }

  /** The session API for one host agent, mounted under `base`. */
  function mountAgent(base: string, store: SessionStore, agent: AgentRoutes): void {
    app.get(`${base}/health`, (c) => c.json<HealthResponse>({ ok: true, user: c.get('user'), fake: cfg.fake, defaultCwd: cfg.defaultCwd, allowBypass: cfg.allowBypass === true }))

    const modeAllowed = (mode: unknown) => agent.isMode(mode) && (mode !== agent.optInMode || cfg.allowBypass === true)
    const BYPASS_OFF = `${agent.optInLabel} is disabled on this host (set SPARKMAN_ALLOW_BYPASS=1 to enable it).`

    app.get(`${base}/sessions`, (c) => c.json(store.list()))

    app.post(`${base}/sessions`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as CreateSessionBody
      if (body.mode !== undefined && !agent.isMode(body.mode)) return c.json({ error: 'Unknown permission mode' }, 400)
      if (body.mode !== undefined && !modeAllowed(body.mode)) return c.json({ error: BYPASS_OFF }, 400)
      if (body.cwd !== undefined) {
        if (typeof body.cwd !== 'string' || !path.isAbsolute(body.cwd.trim())) return c.json({ error: 'Working directory must be an absolute path' }, 400)
        if (!isDirectory(body.cwd.trim())) return c.json({ error: `No such directory: ${body.cwd.trim()}` }, 400)
      }
      const optionsError = validateOptions(body.options)
      if (optionsError) return c.json({ error: optionsError }, 400)
      const session = store.create(body)
      return c.json(session.summary, 201)
    })

    app.get(`${base}/sessions/:id`, (c) => {
      const session = store.get(c.req.param('id'))
      if (!session) return c.json({ error: 'Session not found' }, 404)
      return c.json<SessionDetail>({ session: session.summary, events: session.allEvents() })
    })

    app.get(`${base}/sessions/:id/stream`, (c) => {
      const session = store.get(c.req.param('id'))
      if (!session) return c.json({ error: 'Session not found' }, 404)
      const after = Math.max(Number(c.req.query('after') ?? 0) || 0, Number(c.req.header('last-event-id') ?? 0) || 0)
      return streamSSE(c, async (stream) => {
        const backlog: EventEnvelope[] = session.eventsAfter(after)
        let wake: (() => void) | null = null
        let closed = false
        const unsubscribe = session.subscribe((env) => {
          backlog.push(env)
          wake?.()
        })
        stream.onAbort(() => {
          closed = true
          wake?.()
        })
        try {
          while (!closed) {
            while (backlog.length > 0 && !closed) {
              const env = backlog.shift()!
              await stream.writeSSE({ id: String(env.seq), data: JSON.stringify(env) })
            }
            if (closed) break
            const woke = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(() => resolve(false), HEARTBEAT_MS)
              wake = () => {
                clearTimeout(timer)
                resolve(true)
              }
            })
            wake = null
            if (!woke && !closed) await stream.writeSSE({ event: 'ping', data: '' })
          }
        } finally {
          unsubscribe()
        }
      })
    })

    type Ctx = Context<Env>
    type Session = NonNullable<ReturnType<SessionStore['get']>>
    const fail = (c: Ctx, err: unknown, status: 400 | 500 = 500) => c.json({ error: err instanceof Error ? err.message : String(err) }, status)
    const readBody = async <T,>(c: Ctx) => (await c.req.json().catch(() => ({}))) as Partial<T>
    /** Look up the session, run `fn`, and map thrown errors to a JSON 500. */
    const withSession = (fn: (c: Ctx, s: Session) => Promise<Response> | Response) => async (c: Ctx) => {
      const session = store.get(c.req.param('id') ?? '')
      if (!session) return c.json({ error: 'Session not found' }, 404)
      try {
        return await fn(c, session)
      } catch (err) {
        if (err instanceof UnsupportedError) return c.json({ error: err.message }, 501)
        return fail(c, err)
      }
    }

    app.post(
      `${base}/sessions/:id/messages`,
      bodyLimit({ maxSize: MAX_MESSAGE_BYTES, onError: (c) => c.json({ error: 'Message is too large (at most 4 images of about 3.7 MB each).' }, 413) }),
      withSession(async (c, session) => {
        const body = await readBody<SendMessageBody>(c)
        const images = body.images ?? []
        if (typeof body.text !== 'string') return c.json({ error: 'Message text is required' }, 400)
        if (!Array.isArray(images) || images.length > MAX_IMAGES) return c.json({ error: `Attach at most ${MAX_IMAGES} images` }, 400)
        if (!images.every(isImage)) return c.json({ error: 'Images must be PNG, JPEG, GIF or WebP, about 3.7 MB at most' }, 400)
        if (!body.text.trim() && images.length === 0) return c.json({ error: 'Message text is required' }, 400)
        session.send(body.text, images)
        return c.json({ ok: true }, 202)
      }),
    )

    app.post(
      `${base}/sessions/:id/permissions/:requestId`,
      withSession(async (c, session) => {
        const body = await readBody<PermissionDecisionBody>(c)
        if (body.behavior !== 'allow' && body.behavior !== 'deny') return c.json({ error: 'behavior must be allow or deny' }, 400)
        if (body.mode !== undefined && !(isAgentMode(body.mode) && modeAllowed(body.mode))) return c.json({ error: isAgentMode(body.mode) && agent.isMode(body.mode) ? BYPASS_OFF : 'Unknown permission mode' }, 400)
        if (body.updatedInput !== undefined && !isPlainObject(body.updatedInput)) return c.json({ error: 'updatedInput must be an object' }, 400)
        const ok = session.decide(c.req.param('requestId') ?? '', {
          behavior: body.behavior,
          ...(typeof body.message === 'string' ? { message: body.message } : {}),
          ...(body.updatedInput ? { updatedInput: body.updatedInput } : {}),
          ...(body.mode ? { mode: body.mode } : {}),
        })
        return ok ? c.json({ ok: true }) : c.json({ error: 'That permission request is no longer pending' }, 409)
      }),
    )

    app.post(
      `${base}/sessions/:id/mode`,
      withSession(async (c, session) => {
        const body = await readBody<SetModeBody>(c)
        if (!agent.isMode(body.mode)) return c.json({ error: 'Unknown permission mode' }, 400)
        if (!modeAllowed(body.mode)) return c.json({ error: BYPASS_OFF }, 400)
        await session.setMode(body.mode)
        return c.json(session.summary)
      }),
    )

    app.post(
      `${base}/sessions/:id/model`,
      withSession(async (c, session) => {
        const body = await readBody<SetModelBody>(c)
        if (typeof body.model !== 'string' || !/^[\w.:[\]-]{1,100}$/.test(body.model)) return c.json({ error: 'Unknown model' }, 400)
        await session.setModel(body.model)
        return c.json(session.summary)
      }),
    )

    app.post(
      `${base}/sessions/:id/thinking`,
      withSession(async (c, session) => {
        const body = await readBody<SetThinkingBody>(c)
        if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400)
        await session.setShowThinking(body.enabled)
        return c.json(session.summary)
      }),
    )

    app.post(
      `${base}/sessions/:id/interrupt`,
      withSession(async (c, session) => {
        await session.interrupt()
        return c.json({ ok: true })
      }),
    )

    app.get(`${base}/sessions/:id/capabilities`, withSession(async (c, session) => c.json<Capabilities>(await session.capabilities())))
    app.get(`${base}/sessions/:id/context`, withSession(async (c, session) => c.json<ContextUsage>(await session.context())))
    app.get(`${base}/sessions/:id/usage`, withSession(async (c, session) => c.json<PlanUsage>(await session.planUsage())))
    app.get(`${base}/sessions/:id/mcp`, withSession(async (c, session) => c.json<McpServerInfo[]>(await session.mcpServers())))

    app.post(
      `${base}/sessions/:id/mcp/:name`,
      withSession(async (c, session) => {
        const body = await readBody<McpActionBody>(c)
        if (body.action !== 'enable' && body.action !== 'disable' && body.action !== 'reconnect') return c.json({ error: 'action must be enable, disable or reconnect' }, 400)
        await session.mcpAction(c.req.param('name') ?? '', body.action)
        return c.json<McpServerInfo[]>(await session.mcpServers())
      }),
    )

    app.post(
      `${base}/sessions/:id/skills/reload`,
      withSession(async (c, session) => c.json({ skills: await session.reloadSkills() })),
    )

    app.post(
      `${base}/sessions/:id/tasks/:taskId/stop`,
      withSession(async (c, session) => {
        await session.stopTask(c.req.param('taskId') ?? '')
        return c.json({ ok: true })
      }),
    )

    app.post(
      `${base}/sessions/:id/rewind`,
      withSession(async (c, session) => {
        const body = await readBody<RewindBody>(c)
        if (typeof body.userUuid !== 'string' || !body.userUuid) return c.json({ error: 'userUuid is required' }, 400)
        return c.json<RewindResult>(await session.rewind(body.userUuid, body.dryRun !== false))
      }),
    )

    app.get(`${base}/sessions/:id/plugins`, withSession(async (c, session) => c.json<PluginInfo[]>(await session.plugins())))

    app.post(
      `${base}/sessions/:id/plugins/:pluginId`,
      withSession(async (c, session) => {
        const body = await readBody<PluginActionBody>(c)
        if (body.action !== 'install' && body.action !== 'uninstall') return c.json({ error: 'action must be install or uninstall' }, 400)
        await session.pluginAction(c.req.param('pluginId') ?? '', body.action)
        return c.json<PluginInfo[]>(await session.plugins())
      }),
    )

    app.post(`${base}/sessions/:id/fork`, async (c) => {
      if (!agent.canFork) return c.json({ error: 'Forking isn’t available for this agent' }, 501)
      const body = await readBody<ForkBody>(c)
      if (typeof body.atUuid !== 'string' || !body.atUuid) return c.json({ error: 'atUuid is required' }, 400)
      try {
        return c.json<SessionSummary>(store.fork(c.req.param('id'), body.atUuid).summary, 201)
      } catch (err) {
        if (err instanceof ForkError) return c.json({ error: err.message }, err.status)
        return fail(c, err)
      }
    })
  }

  mountAgent('/api/agent', cfg.store, CLAUDE_ROUTES)
  if (cfg.codexStore) mountAgent('/api/codex', cfg.codexStore, CODEX_ROUTES)
  if (cfg.fleet) mountFleet(app, cfg.fleet, cfg.gateway)
  // no fleet on this host (dev, e2e): the UI asks once at startup and stays on the simulator
  else app.get('/api/fleet/health', (c) => c.json({ ok: true, live: [] }))

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404))

  // opencode's org discovery: public on the tailnet (opencode sends no credentials), and holds no secrets
  const gw = cfg.gateway
  if (gw) {
    app.get('/.well-known/opencode', (c) => {
      if (!isLoopback(c) || !hostAllowed(new URL(c.req.url).hostname.toLowerCase())) return c.json({ error: 'Forbidden' }, 403)
      return c.json(opencodeManifest(publicBase(c).replace(/\/v1$/, ''), gw.routes().models))
    })
  }

  if (cfg.staticDir && existsSync(path.join(cfg.staticDir, 'index.html'))) {
    const root = path.relative(process.cwd(), cfg.staticDir) || '.'
    // re-read when a rebuild replaces it, so deep links don't point at deleted asset hashes
    const indexFile = path.join(cfg.staticDir, 'index.html')
    let indexHtml = { mtime: 0, html: '' }
    const index = () => {
      const mtime = statSync(indexFile).mtimeMs
      if (mtime !== indexHtml.mtime) indexHtml = { mtime, html: readFileSync(indexFile, 'utf8') }
      return indexHtml.html
    }
    app.use('/*', serveStatic({ root }))
    app.get('*', (c) => c.html(index())) // SPA fallback for client-side routes
  }

  return app
}
