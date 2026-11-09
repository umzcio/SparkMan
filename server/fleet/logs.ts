import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { HistogramBucket, LogIncidentBand, LogLevel, LogLine, LogQueryInput, LogQueryResult, LogSource } from '../../src/api/types.ts'
import { matchesLogQuery, parseLogQuery, type ParsedLogQuery } from '../../src/lib/log-query.ts'
import { RANGE_MS } from './db.ts'
import type { SshRunner, SshTarget } from './ssh.ts'

export const HOT_DAYS = 7
const DAY = 86_400_000
const HISTOGRAM_BUCKETS = 60
const ENGINE_RE = /llama-swap|vllm|sglang|ollama|tensorfold|trtllm|triton|nim|llama-server|ds4/i

// ---------- journald → LogLine ----------

/** journald JSON fields we read (MESSAGE may be a byte array for non-UTF-8 text). */
export interface JournalEntry {
  __CURSOR?: string
  __REALTIME_TIMESTAMP?: string
  PRIORITY?: string
  MESSAGE?: string | number[] | null
  SYSLOG_IDENTIFIER?: string
  _SYSTEMD_UNIT?: string
  _TRANSPORT?: string
  _PID?: string
  CONTAINER_NAME?: string
  _COMM?: string
}

/** A stable id for a message's shape: numbers, hex, addresses and paths become placeholders. */
export function patternOf(service: string, message: string): string {
  const template = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .slice(0, 200)
  return createHash('sha1').update(service).update('\0').update(template).digest('hex').slice(0, 16)
}

function levelOf(prio: number, message: string): LogLevel {
  if (/NVRM: Xid/.test(message)) return 'error'
  if (prio <= 3) return 'error'
  if (prio === 4) return 'warn'
  if (prio <= 6) return 'info'
  return 'debug'
}

const text = (m: JournalEntry['MESSAGE']): string => (Array.isArray(m) ? Buffer.from(m).toString('utf8') : (m ?? ''))

export function journalToLine(host: string, e: JournalEntry): LogLine | null {
  const tsUs = Number(e.__REALTIME_TIMESTAMP)
  if (!Number.isFinite(tsUs)) return null
  const message = text(e.MESSAGE).trimEnd()
  if (!message) return null
  const unit = e._SYSTEMD_UNIT?.replace(/\.service$/, '')
  const service = e.CONTAINER_NAME ?? e.SYSLOG_IDENTIFIER ?? unit ?? e._COMM ?? 'unknown'
  const source: LogSource = e._TRANSPORT === 'kernel' ? 'kernel' : e.CONTAINER_NAME || ENGINE_RE.test(`${service} ${unit ?? ''}`) ? 'engine' : 'journald'
  const attributes: Record<string, string> = {}
  if (unit) attributes.unit = unit
  if (e._PID) attributes.pid = e._PID
  const xid = /NVRM: Xid \([^)]*\): (\d+)/.exec(message)
  if (xid) attributes.xid = xid[1]
  return {
    id: '',
    ts: Math.floor(tsUs / 1000),
    level: levelOf(Number(e.PRIORITY ?? 6), message),
    source,
    host,
    service,
    message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message,
    pattern: patternOf(service, message),
    attributes,
  }
}

// ---------- store ----------

const DIRECT_KEYS = new Set(['level', 'host', 'source', 'service', 'pattern'])

/** Lines from every box for HOT_DAYS, then archived to gzip JSONL (see archive()). */
export class LogStore {
  readonly db: DatabaseSync
  private insert
  private pending: LogLine[] = []
  private flushTimer: NodeJS.Timeout | null = null

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL,
        host TEXT NOT NULL, service TEXT NOT NULL, message TEXT NOT NULL, pattern TEXT NOT NULL, attrs TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS logs_ts ON logs (ts);
      CREATE INDEX IF NOT EXISTS logs_host_ts ON logs (host, ts);
      CREATE TABLE IF NOT EXISTS cursors (host TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    `)
    this.insert = this.db.prepare('INSERT INTO logs (ts, level, source, host, service, message, pattern, attrs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  }

  /** Buffer a line; writes go out in one transaction per second. */
  add(line: LogLine): void {
    this.pending.push(line)
    if (this.pending.length >= 2000) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), 1000)
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.pending.length) return
    const batch = this.pending.splice(0)
    this.db.exec('BEGIN')
    try {
      for (const l of batch) this.insert.run(l.ts, l.level, l.source, l.host, l.service, l.message, l.pattern, JSON.stringify(l.attributes))
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  cursor(host: string): string | null {
    const r = this.db.prepare('SELECT cursor FROM cursors WHERE host = ?').get(host) as { cursor: string } | undefined
    return r?.cursor ?? null
  }

  setCursor(host: string, cursor: string): void {
    // a collector's ssh child can close after shutdown has closed the db
    if (!this.db.isOpen) return
    this.db.prepare('INSERT OR REPLACE INTO cursors (host, cursor) VALUES (?, ?)').run(host, cursor)
  }

  /** SQL for the parts of a query SQLite can do; matchesLogQuery re-checks every returned line. */
  private where(q: ParsedLogQuery, from: number, to: number): { sql: string; args: (string | number)[] } {
    const parts = ['ts >= ?', 'ts <= ?']
    const args: (string | number)[] = [from, to]
    const positive = new Map<string, string[]>()
    for (const f of q.filters) {
      const col = DIRECT_KEYS.has(f.key) ? `lower(${f.key})` : `lower(json_extract(attrs, ?))`
      if (f.negate) {
        parts.push(`(${col} IS NULL OR ${col} != ?)`)
        if (!DIRECT_KEYS.has(f.key)) args.push(`$."${f.key}"`, `$."${f.key}"`)
        args.push(f.value.toLowerCase())
      } else positive.set(f.key, [...(positive.get(f.key) ?? []), f.value.toLowerCase()])
    }
    for (const [key, values] of positive) {
      if (DIRECT_KEYS.has(key)) parts.push(`lower(${key}) IN (${values.map(() => '?').join(', ')})`)
      else {
        parts.push(`lower(json_extract(attrs, ?)) IN (${values.map(() => '?').join(', ')})`)
        args.push(`$."${key}"`)
      }
      args.push(...values)
    }
    for (const t of q.terms) {
      parts.push(t.negate ? 'instr(lower(message), ?) = 0' : 'instr(lower(message), ?) > 0')
      args.push(t.text.toLowerCase())
    }
    return { sql: parts.join(' AND '), args }
  }

  query(input: LogQueryInput, now: number, bands: LogIncidentBand[] = []): LogQueryResult {
    this.flush()
    const from = input.around !== undefined ? input.around - 60_000 : now - RANGE_MS[input.range]
    const to = input.around !== undefined ? Math.min(input.around + 60_000, now) : now
    const q = parseLogQuery(input.query)
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 2000)
    const { sql, args } = this.where(q, from, to)
    const rows = this.db
      .prepare(`SELECT id, ts, level, source, host, service, message, pattern, attrs FROM logs WHERE ${sql} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...args, limit + 1) as { id: number; ts: number; level: LogLevel; source: LogSource; host: string; service: string; message: string; pattern: string; attrs: string }[]
    const lines = rows
      .map((r): LogLine => ({ id: `log-${r.id}`, ts: r.ts, level: r.level, source: r.source, host: r.host, service: r.service, message: r.message, pattern: r.pattern, attributes: JSON.parse(r.attrs) as Record<string, string> }))
      .filter((l) => matchesLogQuery(l, q))
    const width = (to - from) / HISTOGRAM_BUCKETS
    const counts = this.db
      .prepare(`SELECT CAST((ts - ?) / ? AS INTEGER) AS b, level, count(*) AS n FROM logs WHERE ${sql} GROUP BY b, level`)
      .all(from, width, ...args) as { b: number; level: LogLevel; n: number }[]
    const histogram: HistogramBucket[] = Array.from({ length: HISTOGRAM_BUCKETS }, (_, i) => ({ t: from + i * width, error: 0, warn: 0, info: 0, debug: 0 }))
    for (const c of counts) {
      const bucket = histogram[Math.min(Math.max(c.b, 0), HISTOGRAM_BUCKETS - 1)]
      bucket[c.level] += c.n
    }
    const total = histogram.reduce((s, b) => s + b.error + b.warn + b.info + b.debug, 0)
    return {
      lines: lines.slice(0, limit),
      histogram,
      total,
      truncated: rows.length > limit,
      bands: bands.filter((b) => b.from <= to && b.to >= from).map((b) => ({ ...b, from: Math.max(b.from, from), to: Math.min(b.to, to) })),
      from,
      to,
    }
  }

  /**
   * Move whole days older than HOT_DAYS to `dir/<host>/<yyyy>/<mm>/<yyyy-mm-dd>.<stamp>.jsonl.gz`, then delete
   * them here. `dir` must already exist (it's the archive mount). Skipped — lines stay hot — when it doesn't
   * answer within 10 s or isn't writable: the archive is on NFS, and a hung mount must not freeze the server,
   * so the probe runs in a child process and every write is async.
   */
  async archive(dir: string, now: number): Promise<{ files: number; lines: number } | { skipped: string }> {
    this.flush()
    // a real write, in a child process so a hung NFS mount can't block the event loop; it also
    // triggers the automount, which a stat or access() check can race
    const marker = path.join(dir, '.sparkman-archive-probe')
    const probe = await new Promise<string | null>((resolve) => {
      execFile('touch', [marker], { timeout: 10_000 }, (err) => {
        if (!err) resolve(null)
        else resolve(err.killed ? 'archive did not answer within 10 s' : `archive unavailable: ${err.message.split('\n')[0]}`)
      })
    })
    if (probe) return { skipped: probe }
    const cutoff = Math.floor((now - HOT_DAYS * DAY) / DAY) * DAY
    // node:sqlite binds a JS number as REAL: without the cast `ts / ?` is a fractional "day", every line its own
    // group, and same-day groups overwrote each other's file while each deleted its lines (logs lost)
    const groups = this.db
      .prepare('SELECT host, CAST(ts / ? AS INTEGER) AS day, count(*) AS n FROM logs WHERE ts < ? GROUP BY host, day')
      .all(DAY, cutoff) as { host: string; day: number; n: number }[]
    let files = 0
    let lines = 0
    for (const g of groups) {
      const dayStart = g.day * DAY
      const rows = this.db
        .prepare('SELECT id, ts, level, source, host, service, message, pattern, attrs FROM logs WHERE host = ? AND ts >= ? AND ts < ? ORDER BY ts, id')
        .all(g.host, dayStart, dayStart + DAY) as Record<string, unknown>[]
      if (!rows.length) continue
      const maxId = Math.max(...rows.map((r) => Number(r.id)))
      const body = rows.map(({ id: _id, ...r }) => JSON.stringify({ ...r, attrs: JSON.parse(String(r.attrs)) })).join('\n') + '\n'
      const ymd = new Date(dayStart).toISOString().slice(0, 10)
      const target = path.join(dir, g.host.replace(/[^\w.-]/g, '_'), ymd.slice(0, 4), ymd.slice(5, 7))
      await mkdir(target, { recursive: true })
      const file = path.join(target, `${ymd}.${now}.jsonl.gz`)
      await writeFile(`${file}.tmp`, gzipSync(body))
      await rename(`${file}.tmp`, file)
      // only what went into the file: a late line for this day arriving meanwhile waits for the next run
      this.db.prepare('DELETE FROM logs WHERE host = ? AND ts >= ? AND ts < ? AND id <= ?').run(g.host, dayStart, dayStart + DAY, maxId)
      files++
      lines += rows.length
    }
    return { files, lines }
  }

  close(): void {
    if (!this.db.isOpen) return
    this.flush()
    this.db.close()
  }
}

// ---------- collector ----------

/**
 * One `journalctl -f -o json` per box over SSH, resuming from the last stored cursor (or the last 6 h
 * on first contact). Priorities 0–6; debug stays on the box.
 */
export class LogCollector {
  private children = new Map<string, ChildProcessWithoutNullStreams>()
  private timers = new Map<string, NodeJS.Timeout>()
  private stopped = false
  private store: LogStore
  private ssh: SshRunner
  private onLine?: (l: LogLine) => void

  constructor(store: LogStore, ssh: SshRunner, onLine?: (l: LogLine) => void) {
    this.store = store
    this.ssh = ssh
    this.onLine = onLine
  }

  start(targets: SshTarget[]): void {
    for (const t of targets) this.follow(t, 2000)
  }

  private follow(t: SshTarget, retryMs: number): void {
    if (this.stopped) return
    const cursor = this.store.cursor(t.id)
    const from = cursor ? `--after-cursor=${shellQuote(cursor)}` : '--since=-6h'
    const child = this.ssh.stream(t, `sudo -n journalctl -f -q -o json -p 0..6 ${from}`)
    this.children.set(t.id, child)
    let lastCursor: string | null = null
    let saveTimer: NodeJS.Timeout | null = null
    const saveCursor = () => {
      saveTimer = null
      if (lastCursor) this.store.setCursor(t.id, lastCursor)
    }
    createInterface({ input: child.stdout }).on('line', (raw) => {
      let e: JournalEntry
      try {
        e = JSON.parse(raw) as JournalEntry
      } catch {
        return
      }
      // journalctl only prints objects; anything else (a stray `null`) is skipped, not dereferenced
      if (typeof e !== 'object' || e === null || Array.isArray(e)) return
      const line = journalToLine(t.id, e)
      if (line) {
        this.store.add(line)
        this.onLine?.(line)
      }
      if (e.__CURSOR) {
        lastCursor = e.__CURSOR
        saveTimer ??= setTimeout(saveCursor, 2000)
      }
      retryMs = 2000
    })
    child.stderr.resume()
    child.on('close', () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveCursor()
      this.children.delete(t.id)
      if (this.stopped) return
      this.timers.set(t.id, setTimeout(() => this.follow(t, Math.min(retryMs * 2, 60_000)), retryMs))
    })
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    for (const c of this.children.values()) c.kill()
  }
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
