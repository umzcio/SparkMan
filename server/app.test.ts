// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionDetail, SessionSummary } from '../src/agent/protocol.ts'
import { createFakeQuery } from './agent/fake-query.ts'
import { SessionStore } from './agent/store.ts'
import { createApp } from './app.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-app-'))
})
const stores: SessionStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

function makeApp(opts: { loopback?: boolean; allowedUsers?: string[]; allowBypass?: boolean; allowedHosts?: string[] } = {}) {
  const store = new SessionStore({ dir, queryFn: createFakeQuery(), defaultCwd: '/srv' })
  stores.push(store)
  return createApp({ store, allowedUsers: opts.allowedUsers ?? ['admin@example.com'], allowedHosts: opts.allowedHosts, allowBypass: opts.allowBypass, defaultCwd: '/srv', fake: true, isLoopback: () => opts.loopback ?? true })
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('auth', () => {
  it('allows direct loopback requests without an identity header', async () => {
    const res = await makeApp().request('/api/agent/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, user: null, fake: true, defaultCwd: '/srv' })
  })

  it('allows listed tailnet users (case-insensitive) and reports who they are', async () => {
    const res = await makeApp({ loopback: true }).request('/api/agent/health', { headers: { 'Tailscale-User-Login': 'Admin@Example.com', 'X-Forwarded-For': '100.64.0.2' } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: string }).user).toBe('admin@example.com')
  })

  it('rejects unlisted tailnet users, proxied header-less requests and non-loopback sockets', async () => {
    expect((await makeApp().request('/api/agent/health', { headers: { 'Tailscale-User-Login': 'eve@example.com' } })).status).toBe(403)
    expect((await makeApp().request('/api/agent/health', { headers: { 'X-Forwarded-For': '100.64.0.9' } })).status).toBe(403)
    expect((await makeApp({ loopback: false }).request('/api/agent/health')).status).toBe(403)
  })

  it('fails closed when no tailnet users are configured', async () => {
    const res = await makeApp({ allowedUsers: [] }).request('/api/agent/health', { headers: { 'Tailscale-User-Login': 'admin@example.com' } })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('SPARKMAN_ALLOWED_USERS')
  })
})

describe('cross-site and network hardening', () => {
  it('rejects a DNS-rebound Host and foreign Origins, allows loopback, *.ts.net and configured hosts', async () => {
    const app = makeApp({ allowedHosts: ['sparkman.lan'] })
    expect((await app.request('http://evil.example:4100/api/agent/health')).status).toBe(403)
    expect((await app.request('/api/agent/sessions', { ...json({}), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } })).status).toBe(403)
    expect((await app.request('http://127.0.0.1:4100/api/agent/health')).status).toBe(200)
    expect((await app.request('http://[::1]:4100/api/agent/health')).status).toBe(200)
    expect((await app.request('https://sparkman-host.tail1234.ts.net/api/agent/health', { headers: { 'Tailscale-User-Login': 'admin@example.com' } })).status).toBe(200)
    expect((await app.request('http://sparkman.lan/api/agent/health')).status).toBe(200)
    expect((await app.request('/api/agent/sessions', { ...json({}), headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' } })).status).toBe(201)
  })

  it('requires JSON bodies on state-changing requests (no CORS-simple text/plain posts)', async () => {
    const res = await makeApp().request('/api/agent/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"mode":"default"}' })
    expect(res.status).toBe(415)
  })

  it('never honours an identity header from a non-loopback socket', async () => {
    const res = await makeApp({ loopback: false }).request('/api/agent/health', { headers: { 'Tailscale-User-Login': 'admin@example.com' } })
    expect(res.status).toBe(403)
  })

  it('keeps bypass mode off unless the host opts in', async () => {
    const off = makeApp()
    expect((await (await off.request('/api/agent/health')).json()) as { allowBypass: boolean }).toMatchObject({ allowBypass: false })
    expect((await off.request('/api/agent/sessions', json({ mode: 'bypassPermissions' }))).status).toBe(400)
    const { id } = (await (await off.request('/api/agent/sessions', json({}))).json()) as SessionSummary
    expect((await off.request(`/api/agent/sessions/${id}/mode`, json({ mode: 'bypassPermissions' }))).status).toBe(400)
    const on = makeApp({ allowBypass: true })
    expect((await on.request('/api/agent/sessions', json({ mode: 'bypassPermissions' }))).status).toBe(201)
  })

  it('validates the working directory', async () => {
    const app = makeApp()
    expect((await app.request('/api/agent/sessions', json({ cwd: 'relative/dir' }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions', json({ cwd: '/definitely/not/here' }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions', json({ cwd: 42 }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions', json({ cwd: dir }))).status).toBe(201)
  })
})

describe('routes', () => {
  it('creates, lists and fetches sessions; validates input', async () => {
    const app = makeApp()
    expect((await app.request('/api/agent/sessions', json({ mode: 'yolo' }))).status).toBe(400)
    const created = await app.request('/api/agent/sessions', json({ cwd: dir, mode: 'plan' }))
    expect(created.status).toBe(201)
    const summary = (await created.json()) as SessionSummary
    expect(summary).toMatchObject({ cwd: dir, mode: 'plan', state: 'idle' })

    const list = (await (await app.request('/api/agent/sessions')).json()) as SessionSummary[]
    expect(list.map((s) => s.id)).toEqual([summary.id])

    const detail = (await (await app.request(`/api/agent/sessions/${summary.id}`)).json()) as SessionDetail
    expect(detail.session.id).toBe(summary.id)
    expect(detail.events).toEqual([])

    expect((await app.request('/api/agent/sessions/nope')).status).toBe(404)
    expect((await app.request(`/api/agent/sessions/${summary.id}/messages`, json({ text: '  ' }))).status).toBe(400)
    expect((await app.request(`/api/agent/sessions/${summary.id}/mode`, json({ mode: 'nope' }))).status).toBe(400)
    expect((await app.request(`/api/agent/sessions/${summary.id}/permissions/req_x`, json({ behavior: 'allow' }))).status).toBe(409)
    expect((await app.request('/api/agent/unknown')).status).toBe(404)
  })

  it('sends a message, decides a permission and changes mode', async () => {
    const app = makeApp()
    const { id } = (await (await app.request('/api/agent/sessions', json({}))).json()) as SessionSummary
    expect((await app.request(`/api/agent/sessions/${id}/messages`, json({ text: 'check disk' }))).status).toBe(202)

    let requestId = ''
    for (let i = 0; i < 50 && !requestId; i++) {
      await new Promise((r) => setTimeout(r, 10))
      const d = (await (await app.request(`/api/agent/sessions/${id}`)).json()) as SessionDetail
      const ev = d.events.map((e) => e.event).find((e) => e.kind === 'permission_request')
      if (ev && ev.kind === 'permission_request') requestId = ev.requestId
    }
    expect(requestId).not.toBe('')
    expect((await app.request(`/api/agent/sessions/${id}/permissions/${requestId}`, json({ behavior: 'allow' }))).status).toBe(200)

    const mode = await app.request(`/api/agent/sessions/${id}/mode`, json({ mode: 'acceptEdits' }))
    expect(((await mode.json()) as SessionSummary).mode).toBe('acceptEdits')
  })
})

describe('SDK feature routes', () => {
  const create = async (app: ReturnType<typeof makeApp>, body: unknown = {}) => (await (await app.request('/api/agent/sessions', json(body))).json()) as SessionSummary

  it('validates session options and image attachments', async () => {
    const app = makeApp()
    expect((await app.request('/api/agent/sessions', json({ options: { effort: 'ludicrous' } }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions', json({ options: { maxBudgetUsd: -1 } }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions', json({ options: { additionalDirectories: ['relative'] } }))).status).toBe(400)
    const s = await create(app, { options: { effort: 'high', maxBudgetUsd: 2, additionalDirectories: [os.tmpdir()] } })
    expect(s.options).toEqual({ effort: 'high', maxBudgetUsd: 2, additionalDirectories: [os.tmpdir()] })
    expect(s.showThinking).toBe(true)

    const send = (body: unknown) => app.request(`/api/agent/sessions/${s.id}/messages`, json(body))
    expect((await send({ text: '', images: [{ mediaType: 'image/svg+xml', data: 'aGk=' }] })).status).toBe(400)
    expect((await send({ text: '', images: [{ mediaType: 'image/png', data: 'not base64!' }] })).status).toBe(400)
    expect((await send({ text: '', images: Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: 'aGk=' })) })).status).toBe(400)
    expect((await send({ text: '', images: [{ mediaType: 'image/png', data: 'aGk=' }] })).status).toBe(202)
  })

  it('serves capabilities, context, usage and MCP, and applies model / thinking / MCP changes', async () => {
    const app = makeApp()
    const { id } = await create(app)
    const get = async <T,>(p: string) => (await (await app.request(`/api/agent/sessions/${id}${p}`)).json()) as T
    expect((await get<{ models: unknown[] }>('/capabilities')).models).toHaveLength(3)
    expect((await get<{ maxTokens: number }>('/context')).maxTokens).toBe(200_000)
    expect((await get<{ available: boolean }>('/usage')).available).toBe(true)
    expect((await get<{ name: string }[]>('/mcp')).map((m) => m.name)).toEqual(['github', 'linear'])

    const post = (p: string, body: unknown) => app.request(`/api/agent/sessions/${id}${p}`, json(body))
    expect(((await (await post('/model', { model: 'sonnet' })).json()) as SessionSummary).model).toBe('sonnet')
    expect((await post('/model', { model: 'rm -rf /' })).status).toBe(400)
    expect(((await (await post('/thinking', { enabled: false })).json()) as SessionSummary).showThinking).toBe(false)
    expect((await post('/thinking', { enabled: 'no' })).status).toBe(400)
    const mcp = (await (await post('/mcp/github', { action: 'disable' })).json()) as { name: string; status: string }[]
    expect(mcp.find((m) => m.name === 'github')?.status).toBe('disabled')
    expect((await post('/mcp/github', { action: 'explode' })).status).toBe(400)
    expect((await post('/mcp/nope', { action: 'enable' })).status).toBe(500)
    expect(((await (await post('/skills/reload', {})).json()) as { skills: string[] }).skills).toEqual(['deploy-check'])
    expect((await post('/rewind', {})).status).toBe(400)
    expect(((await (await post('/rewind', { userUuid: 'u1', dryRun: true })).json()) as { canRewind: boolean }).canRewind).toBe(true)
  })

  it('rejects a bypass mode switch inside a permission decision when bypass is off, and bad forks', async () => {
    const app = makeApp()
    const { id } = await create(app)
    expect((await app.request(`/api/agent/sessions/${id}/permissions/x`, json({ behavior: 'allow', mode: 'bypassPermissions' }))).status).toBe(400)
    expect((await app.request(`/api/agent/sessions/${id}/fork`, json({}))).status).toBe(400)
    expect((await app.request(`/api/agent/sessions/${id}/fork`, json({ atUuid: 'nope' }))).status).toBe(400)
    expect((await app.request('/api/agent/sessions/missing/fork', json({ atUuid: 'x' }))).status).toBe(404)
  })
})
