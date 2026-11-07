import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Username/password accounts for the console. Users live outside the repo (default
 * /etc/sparkman/users.json, written by `pnpm user:set`); sessions are random tokens in an HttpOnly
 * cookie, stored hashed so a leaked sessions file can't be replayed.
 */

export const SESSION_COOKIE = 'sparkman_session'
const SESSION_TTL_MS = 30 * 86_400_000
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const

export interface UserRecord {
  /** scrypt$N$r$p$saltB64$hashB64 */
  hash: string
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const key = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// a fixed hash to verify against for unknown users, so timing doesn't reveal which names exist
const DUMMY = hashPassword(randomBytes(12).toString('hex'))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function readUsers(file: string): Record<string, UserRecord> {
  if (!existsSync(file)) return {}
  const v = JSON.parse(readFileSync(file, 'utf8')) as { users?: Record<string, UserRecord> }
  return v.users ?? {}
}

export function writeUser(file: string, username: string, password: string | null): void {
  const users = readUsers(file)
  if (password === null) delete users[username]
  else users[username] = { hash: hashPassword(password) }
  writeJson(file, { users })
}

interface SessionRecord {
  user: string
  expires: number
}

export class AuthStore {
  private sessions = new Map<string, SessionRecord>()
  private failures: number[] = []
  private usersFile: string
  private sessionsFile: string
  private now: () => number

  constructor(opts: { usersFile: string; sessionsFile: string; now?: () => number }) {
    this.usersFile = opts.usersFile
    this.sessionsFile = opts.sessionsFile
    this.now = opts.now ?? Date.now
    try {
      const saved = JSON.parse(readFileSync(this.sessionsFile, 'utf8')) as Record<string, SessionRecord>
      for (const [k, v] of Object.entries(saved)) if (v.expires > this.now()) this.sessions.set(k, v)
    } catch {
      // no saved sessions yet
    }
  }

  /** Accounts are configured (otherwise login can never succeed). */
  hasUsers(): boolean {
    return Object.keys(readUsers(this.usersFile)).length > 0
  }

  /** Too many failed logins in the last minute: refuse further attempts for a while. */
  throttled(): boolean {
    const cutoff = this.now() - 60_000
    this.failures = this.failures.filter((t) => t > cutoff)
    return this.failures.length >= 5
  }

  /** A session token for good credentials, null otherwise. */
  login(username: string, password: string): string | null {
    const user = readUsers(this.usersFile)[username]
    const ok = verifyPassword(password, user?.hash ?? DUMMY) && user !== undefined
    if (!ok) {
      this.failures.push(this.now())
      return null
    }
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(sha(token), { user: username, expires: this.now() + SESSION_TTL_MS })
    this.save()
    return token
  }

  /** The signed-in user for a cookie token (sliding expiry), or null. */
  check(token: string | undefined): string | null {
    if (!token) return null
    const key = sha(token)
    const s = this.sessions.get(key)
    if (!s) return null
    if (s.expires <= this.now() || !(s.user in readUsers(this.usersFile))) {
      this.sessions.delete(key)
      this.save()
      return null
    }
    // extend at most once an hour to keep writes rare
    if (s.expires - this.now() < SESSION_TTL_MS - 3_600_000) {
      s.expires = this.now() + SESSION_TTL_MS
      this.save()
    }
    return s.user
  }

  logout(token: string | undefined): void {
    if (!token) return
    if (this.sessions.delete(sha(token))) this.save()
  }

  private save(): void {
    writeJson(this.sessionsFile, Object.fromEntries(this.sessions))
  }
}

export const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000
