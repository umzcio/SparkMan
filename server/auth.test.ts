// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFakeQuery } from './agent/fake-query.ts'
import { SessionStore } from './agent/store.ts'
import { createApp } from './app.ts'
import { AuthStore, hashPassword, verifyPassword, writeUser } from './auth.ts'

let dir: string
const stores: SessionStore[] = []
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-auth-'))
})
afterEach(() => {
  for (const s of stores.splice(0)) s.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

function setup(now = () => 1_000_000) {
  const usersFile = path.join(dir, 'users.json')
  writeUser(usersFile, 'admin', 'correct horse battery')
  const auth = new AuthStore({ usersFile, sessionsFile: path.join(dir, 'sessions.json'), now })
  const store = new SessionStore({ dir: path.join(dir, 'agent'), queryFn: createFakeQuery(), defaultCwd: '/srv' })
  stores.push(store)
  const app = createApp({ store, auth, allowedUsers: [], defaultCwd: '/srv', fake: true, isLoopback: () => true })
  return { app, auth, usersFile }
}

const post = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})
const cookieOf = (res: Response) => res.headers.get('set-cookie')?.split(';')[0] ?? ''

describe('passwords', () => {
  it('verifies scrypt hashes', () => {
    const h = hashPassword('s3cret-pass')
    expect(verifyPassword('s3cret-pass', h)).toBe(true)
    expect(verifyPassword('wrong', h)).toBe(false)
    expect(verifyPassword('x', 'garbage')).toBe(false)
  })
})

describe('sign-in', () => {
  it('rejects API calls without a session and accepts them after login', async () => {
    const { app } = setup()
    expect((await app.request('/api/agent/health')).status).toBe(401)
    const bad = await app.request('/api/auth/login', post({ username: 'admin', password: 'nope' }))
    expect(bad.status).toBe(401)
    const ok = await app.request('/api/auth/login', post({ username: 'admin', password: 'correct horse battery' }))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(ok.headers.get('set-cookie')).toMatch(/SameSite=Strict/i)
    const cookie = cookieOf(ok)
    const health = await app.request('/api/agent/health', { headers: { cookie } })
    expect(health.status).toBe(200)
    expect(((await health.json()) as { user: string }).user).toBe('admin')
    const session = await app.request('/api/auth/session', { headers: { cookie } })
    expect(await session.json()).toEqual({ authEnabled: true, user: 'admin' })
  })

  it('logs out and ends the session', async () => {
    const { app } = setup()
    const cookie = cookieOf(await app.request('/api/auth/login', post({ username: 'admin', password: 'correct horse battery' })))
    await app.request('/api/auth/logout', post({}, cookie))
    expect((await app.request('/api/agent/health', { headers: { cookie } })).status).toBe(401)
  })

  it('admits tailnet logins when sign-in is on and the allow-list is empty', async () => {
    const { app } = setup()
    const cookie = cookieOf(await app.request('/api/auth/login', post({ username: 'admin', password: 'correct horse battery' })))
    const res = await app.request('/api/agent/health', { headers: { cookie, 'Tailscale-User-Login': 'someone@example.com', 'X-Forwarded-For': '100.64.0.2' } })
    expect(res.status).toBe(200)
  })

  it('throttles after five failures in a minute', async () => {
    const { app } = setup()
    for (let i = 0; i < 5; i++) await app.request('/api/auth/login', post({ username: 'admin', password: 'x' }))
    expect((await app.request('/api/auth/login', post({ username: 'admin', password: 'correct horse battery' }))).status).toBe(429)
  })

  it('sessions survive a restart and die with the account', () => {
    let t = 1_000_000
    const { auth, usersFile } = setup(() => t)
    const token = auth.login('admin', 'correct horse battery')!
    const again = new AuthStore({ usersFile, sessionsFile: path.join(dir, 'sessions.json'), now: () => t })
    expect(again.check(token)).toBe('admin')
    t += 31 * 86_400_000
    expect(again.check(token)).toBeNull()
    t = 1_000_000
    const fresh = auth.login('admin', 'correct horse battery')!
    writeUser(usersFile, 'admin', null)
    expect(auth.check(fresh)).toBeNull()
  })

  it('a password reset ends the sessions signed in with the old password', () => {
    const { auth, usersFile } = setup()
    const before = auth.login('admin', 'correct horse battery')!
    writeUser(usersFile, 'admin', 'new staple')
    expect(auth.check(before)).toBeNull()
    expect(auth.check(auth.login('admin', 'new staple')!)).toBe('admin')
  })

  it('refuses account names that would change the users object instead', () => {
    const { auth, usersFile } = setup()
    expect(() => writeUser(usersFile, '__proto__', 'x')).toThrow()
    expect(auth.login('constructor', 'x')).toBeNull()
  })
})
