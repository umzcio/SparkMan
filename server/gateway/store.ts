import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApiKey, Engine, ModelCap } from '../../src/api/types.ts'

/**
 * State shared by the console (writes routes and keys) and the gateway process (reads them, writes one
 * row per request). One SQLite file in WAL mode; both processes open it.
 */

/** One upstream copy of a model. */
export interface RouteTarget {
  deploymentId: string
  engine: Engine
  /** OpenAI-compatible base, e.g. http://10.0.0.11:8000/v1 */
  baseUrl: string
  /** the copy's nodes, head first */
  nodeIds: string[]
  /** the model name the upstream expects (may differ from the public name) */
  upstreamModel: string
  /** what clients need to size requests (the registry and /v1/models report them); 0/absent = unknown */
  contextLength?: number
  maxOutput?: number | null
  caps?: ModelCap[]
  /** a friendlier name than the model id, for client model pickers */
  label?: string
  /** answers /v1/embeddings only; chat clients' model lists leave it out */
  embedding?: boolean
}

export interface RouteTable {
  updatedAt: number
  /** public model name → copies */
  models: Record<string, RouteTarget[]>
}

export interface RequestRow {
  ts: number
  keyId: string | null
  model: string
  deploymentId: string | null
  nodeId: string | null
  path: string
  status: number
  latencyMs: number
  ttftMs: number | null
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  error: string | null
}

export const KEY_PREFIX = 'sk-sm-'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const REQUEST_KEEP_MS = 30 * 86_400_000
/** the longest a request is assumed to run (the proxy has no timeout of its own): bounds the ts scan */
const MAX_REQUEST_MS = 6 * 3_600_000

export class GatewayDb {
  readonly db: DatabaseSync
  private insertReq

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
        created INTEGER NOT NULL, revoked INTEGER, rpm INTEGER NOT NULL, last_used INTEGER
      );
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, key_id TEXT, model TEXT NOT NULL, deployment_id TEXT, node_id TEXT,
        path TEXT NOT NULL, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, ttft_ms INTEGER,
        prompt_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    this.insertReq = this.db.prepare(
      `INSERT INTO requests (ts, key_id, model, deployment_id, node_id, path, status, latency_ms, ttft_ms, prompt_tokens, cached_tokens, completion_tokens, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
  }

  // ---------- routes ----------

  setRoutes(table: RouteTable): void {
    this.db.prepare('INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)').run('routes', JSON.stringify(table))
  }

  routes(): RouteTable {
    const r = this.db.prepare('SELECT value FROM state WHERE key = ?').get('routes') as { value: string } | undefined
    return r ? (JSON.parse(r.value) as RouteTable) : { updatedAt: 0, models: {} }
  }

  // ---------- keys ----------

  createKey(name: string, rpm: number, now = Date.now()): { key: ApiKey; secret: string } {
    const secret = `${KEY_PREFIX}${randomBytes(24).toString('base64url')}`
    const id = `key-${randomBytes(6).toString('hex')}`
    const prefix = secret.slice(0, KEY_PREFIX.length + 4)
    this.db.prepare('INSERT INTO keys (id, name, prefix, hash, created, revoked, rpm, last_used) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)').run(id, name, prefix, sha(secret), now, rpm)
    return { key: this.key(id)!, secret }
  }

  revokeKey(id: string, now = Date.now()): boolean {
    return Number(this.db.prepare('UPDATE keys SET revoked = ? WHERE id = ? AND revoked IS NULL').run(now, id).changes) > 0
  }

  private key(id: string): ApiKey | null {
    return this.listKeys().find((k) => k.id === id) ?? null
  }

  listKeys(now = Date.now()): ApiKey[] {
    const rows = this.db
      .prepare(`SELECT k.id, k.name, k.prefix, k.created, k.revoked, k.rpm, k.last_used,
                (SELECT count(*) FROM requests r WHERE r.key_id = k.id AND r.ts >= ?) AS n24
                FROM keys k ORDER BY k.created DESC`)
      .all(now - 86_400_000) as { id: string; name: string; prefix: string; created: number; revoked: number | null; rpm: number; last_used: number | null; n24: number }[]
    return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created, lastUsedAt: r.last_used, rateLimitRpm: r.rpm, revokedAt: r.revoked, requests24h: r.n24 }))
  }

  /** The live key for a bearer secret, or null. */
  authenticate(secret: string): { id: string; name: string; rpm: number } | null {
    if (!secret.startsWith(KEY_PREFIX)) return null
    const r = this.db.prepare('SELECT id, name, rpm FROM keys WHERE hash = ? AND revoked IS NULL').get(sha(secret)) as { id: string; name: string; rpm: number } | undefined
    return r ?? null
  }

  touchKey(id: string, now = Date.now()): void {
    this.db.prepare('UPDATE keys SET last_used = ? WHERE id = ?').run(now, id)
  }

  // ---------- requests ----------

  addRequest(r: RequestRow): void {
    this.insertReq.run(r.ts, r.keyId, r.model, r.deploymentId, r.nodeId, r.path, r.status, r.latencyMs, r.ttftMs, r.promptTokens, r.cachedTokens, r.completionTokens, r.error)
  }

  trim(now = Date.now()): void {
    this.db.prepare('DELETE FROM requests WHERE ts < ?').run(now - REQUEST_KEEP_MS)
  }

  requestsBetween(from: number, to: number): RequestRow[] {
    return this.rows(this.db
      .prepare('SELECT ts, key_id, model, deployment_id, node_id, path, status, latency_ms, ttft_ms, prompt_tokens, cached_tokens, completion_tokens, error FROM requests WHERE ts >= ? AND ts < ? ORDER BY ts')
      .all(from, to) as Record<string, unknown>[])
  }

  /** Requests that finished in [from, to): a row is written when its request ends but keeps its start as ts. */
  requestsEndedBetween(from: number, to: number): RequestRow[] {
    return this.rows(this.db
      .prepare('SELECT ts, key_id, model, deployment_id, node_id, path, status, latency_ms, ttft_ms, prompt_tokens, cached_tokens, completion_tokens, error FROM requests WHERE ts >= ? AND ts < ? AND ts + latency_ms >= ? AND ts + latency_ms < ? ORDER BY ts')
      .all(from - MAX_REQUEST_MS, to, from, to) as Record<string, unknown>[])
  }

  private rows(rows: Record<string, unknown>[]): RequestRow[] {
    return rows.map((r) => ({
      ts: r.ts as number, keyId: r.key_id as string | null, model: r.model as string, deploymentId: r.deployment_id as string | null, nodeId: r.node_id as string | null,
      path: r.path as string, status: r.status as number, latencyMs: r.latency_ms as number, ttftMs: r.ttft_ms as number | null,
      promptTokens: r.prompt_tokens as number, cachedTokens: r.cached_tokens as number, completionTokens: r.completion_tokens as number, error: r.error as string | null,
    }))
  }

  /** The newest streamed, successful requests per deployment since `from`: tokens out and the time spent generating them. */
  recentDecodes(from: number, perDeployment: number): { deploymentId: string; completionTokens: number; decodeMs: number }[] {
    return (
      this.db
        .prepare(
          `SELECT deployment_id, completion_tokens, latency_ms - ttft_ms AS decode_ms FROM (
             SELECT deployment_id, completion_tokens, latency_ms, ttft_ms, ROW_NUMBER() OVER (PARTITION BY deployment_id ORDER BY ts DESC) AS n
             FROM requests WHERE ts >= ? AND status = 200 AND deployment_id IS NOT NULL AND ttft_ms IS NOT NULL AND latency_ms > ttft_ms
           ) WHERE n <= ?`,
        )
        .all(from, perDeployment) as { deployment_id: string; completion_tokens: number; decode_ms: number }[]
    ).map((r) => ({ deploymentId: r.deployment_id, completionTokens: r.completion_tokens, decodeMs: r.decode_ms }))
  }

  close(): void {
    this.db.close()
  }
}
