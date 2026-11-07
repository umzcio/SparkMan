import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActivityEvent, ActivityKind, MetricKey, MetricPoint, TimeRange } from '../../src/api/types.ts'

export const METRIC_KEYS: MetricKey[] = [
  'gpuUtil', 'memUsedGB', 'gpuPowerW', 'gpuTempC', 'acpiTempC', 'cpuUser', 'cpuSystem',
  'netRxBps', 'netTxBps', 'cx7RxBps', 'cx7TxBps', 'diskReadBps', 'diskWriteBps', 'diskUsedPct',
]

export const SERIES_POINTS = 120
export const RANGE_MS: Record<TimeRange, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}
const RAW_KEEP_MS = 86_400_000
const MINUTE_KEEP_MS = 30 * 86_400_000
const MINUTE = 60_000

/**
 * Fleet state on the SparkMan host: metric history (raw 2 s samples for a day, minute averages for
 * 30 days), small key/value state (drained nodes) and the activity feed.
 */
export class FleetDb {
  readonly db: DatabaseSync
  private insertSample
  private lastRollup = 0

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    const cols = METRIC_KEYS.map((k) => `${k} REAL`).join(', ')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (node TEXT NOT NULL, t INTEGER NOT NULL, ${cols});
      CREATE INDEX IF NOT EXISTS samples_node_t ON samples (node, t);
      CREATE TABLE IF NOT EXISTS minutes (node TEXT NOT NULL, t INTEGER NOT NULL, ${cols}, PRIMARY KEY (node, t));
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, node TEXT);
    `)
    this.insertSample = this.db.prepare(`INSERT INTO samples (node, t, ${METRIC_KEYS.join(', ')}) VALUES (?, ?, ${METRIC_KEYS.map(() => '?').join(', ')})`)
  }

  addSample(node: string, p: MetricPoint): void {
    this.insertSample.run(node, Math.round(p.t), ...METRIC_KEYS.map((k) => p[k]))
    if (p.t - this.lastRollup >= MINUTE) this.rollup(p.t)
  }

  /** Average finished minutes into `minutes`, then trim both tables. */
  rollup(now: number): void {
    const upTo = Math.floor(now / MINUTE) * MINUTE
    const from = Math.max(this.lastRollup, upTo - RAW_KEEP_MS)
    const avgs = METRIC_KEYS.map((k) => `avg(${k})`).join(', ')
    this.db.prepare(
      `INSERT OR REPLACE INTO minutes (node, t, ${METRIC_KEYS.join(', ')})
       SELECT node, (t / ${MINUTE}) * ${MINUTE} AS m, ${avgs} FROM samples WHERE t >= ? AND t < ? GROUP BY node, m`,
    ).run(from, upTo)
    this.db.prepare('DELETE FROM samples WHERE t < ?').run(now - RAW_KEEP_MS)
    this.db.prepare('DELETE FROM minutes WHERE t < ?').run(now - MINUTE_KEEP_MS)
    this.lastRollup = upTo
  }

  /** SERIES_POINTS step-aligned points ending at `now`; null where the node reported nothing. */
  series(node: string, range: TimeRange, now: number): MetricPoint[] {
    const step = RANGE_MS[range] / SERIES_POINTS
    const end = Math.floor(now / step) * step
    const start = end - (SERIES_POINTS - 1) * step
    const table = RANGE_MS[range] > RAW_KEEP_MS / 2 ? 'minutes' : 'samples'
    const rows = this.db
      .prepare(
        `SELECT CAST((t - ?) / ? AS INTEGER) AS b, ${METRIC_KEYS.map((k) => `avg(${k}) AS ${k}`).join(', ')}
         FROM ${table} WHERE node = ? AND t >= ? AND t < ? GROUP BY b`,
      )
      .all(start, step, node, start, end + step) as Record<string, number | null>[]
    const byBucket = new Map(rows.map((r) => [Number(r.b), r]))
    return Array.from({ length: SERIES_POINTS }, (_, i) => {
      const r = byBucket.get(i)
      const p = { t: start + i * step } as MetricPoint
      for (const k of METRIC_KEYS) p[k] = r ? (r[k] ?? null) : null
      return p
    })
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM kv WHERE key = ?').run(key)
    else this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, value)
  }

  addActivity(kind: ActivityKind, text: string, nodeId: string | null, ts = Date.now()): void {
    this.db.prepare('INSERT INTO activity (ts, kind, text, node) VALUES (?, ?, ?, ?)').run(ts, kind, text, nodeId)
  }

  activity(limit = 50): ActivityEvent[] {
    const rows = this.db.prepare('SELECT id, ts, kind, text, node FROM activity ORDER BY ts DESC, id DESC LIMIT ?').all(limit) as {
      id: number; ts: number; kind: ActivityKind; text: string; node: string | null
    }[]
    return rows.map((r) => ({ id: `act-${r.id}`, ts: r.ts, kind: r.kind, text: r.text, nodeId: r.node }))
  }

  close(): void {
    this.db.close()
  }
}
