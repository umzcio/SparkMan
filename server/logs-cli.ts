/**
 * Rebuild days of the log archive from the source of truth, for when archived files are missing or partial:
 *   pnpm logs:rebuild journal <first-day> <last-day> <node>[=<ssh-target>]...   each box's own journal
 *   pnpm logs:rebuild gateway <first-day> <last-day>                            the gateway's requests table
 * Days are UTC (YYYY-MM-DD) and must be older than the hot window, so they never overlap what the nightly
 * archive will still write. Each host and day is written whole as `<day>.rebuild-<stamp>.jsonl.gz` beside the
 * old files. An old file for a rebuilt day is removed only when every one of its lines is in this host's new
 * files; otherwise it is kept and reported. Nothing is deleted on the boxes, and the gateway database is
 * opened read-only.
 *
 * `<node>` is the folder name in the archive (the node id); it is also the SSH target unless `=<ssh-target>`
 * is given. The box needs `sudo -n journalctl` (as the log collector does). How far back a box can go is
 * whatever its journal still holds; the gateway keeps 30 days of requests.
 * Archive: SPARKMAN_LOG_ARCHIVE; gateway database: SPARKMAN_FLEET_DB_DIR (default ~/.sparkman).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { LogLine } from '../src/api/types.ts'
import { HOT_DAYS, journalToLine, type JournalEntry } from './fleet/logs.ts'
import { requestLogLine } from './gateway/proxy.ts'

const DAY = 86_400_000
const USAGE = `usage: pnpm logs:rebuild journal <first-day> <last-day> <node>[=<ssh-target>]...
       pnpm logs:rebuild gateway <first-day> <last-day>`

/** a line as the archive stores it (LogStore.archive) */
type ArchiveRow = Omit<LogLine, 'id' | 'attributes'> & { attrs: Record<string, string> }
const toRow = (l: LogLine): ArchiveRow => ({ ts: l.ts, level: l.level, source: l.source, host: l.host, service: l.service, message: l.message, pattern: l.pattern, attrs: l.attributes })
const identity = (r: { ts: number; service: string; message: string }) => `${r.ts}|${r.service}|${r.message}`
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const folderOf = (dir: string, host: string, ymd: string) => path.join(dir, host.replace(/[^\w.-]/g, '_'), ymd.slice(0, 4), ymd.slice(5, 7))

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function dayRange(first: string | undefined, last: string | undefined): number[] {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!first || !last || !re.test(first) || !re.test(last)) fail(USAGE)
  const from = Date.parse(`${first}T00:00:00Z`)
  const to = Date.parse(`${last}T00:00:00Z`)
  if (!(from <= to)) fail('the first day must not be after the last day')
  const hot = Math.floor((Date.now() - HOT_DAYS * DAY) / DAY) * DAY
  if (to >= hot) fail(`${last} is still in the hot store (the last ${HOT_DAYS} days); the nightly archive writes it`)
  const days: number[] = []
  for (let d = from; d <= to; d += DAY) days.push(d)
  return days
}

/** one UTC day of a box's journal, as the collector would have stored it */
function journalDay(node: string, target: string, start: number): Promise<LogLine[]> {
  return new Promise((resolve, reject) => {
    const cmd = `sudo -n journalctl -q -o json -p 0..6 --no-pager --since @${start / 1000} --until @${(start + DAY) / 1000}`
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: LogLine[] = []
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    createInterface({ input: child.stdout }).on('line', (text) => {
      let e: JournalEntry
      try {
        e = JSON.parse(text) as JournalEntry
      } catch {
        return
      }
      const l = journalToLine(node, e)
      if (l && l.ts >= start && l.ts < start + DAY) lines.push(l)
    })
    child.on('close', (code) => (code === 0 ? resolve(lines) : reject(new Error(`${target}: journalctl exited ${code}: ${err.trim().slice(0, 200)}`))))
  })
}

/** every request in [from, to), as the log line the gateway logged for it */
function gatewayLines(dbFile: string, from: number, to: number): LogLine[] {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const rows = db
      .prepare(`SELECT r.ts, r.model, r.node_id, r.path, r.status, r.latency_ms, r.error, k.name AS key_name
        FROM requests r LEFT JOIN keys k ON k.id = r.key_id WHERE r.ts >= ? AND r.ts < ? ORDER BY r.ts, r.id`)
      .all(from, to) as Record<string, unknown>[]
    return rows.map((r) => requestLogLine({
      ts: Number(r.ts), model: String(r.model), nodeId: (r.node_id as string | null) ?? null, path: String(r.path), status: Number(r.status),
      latencyMs: Number(r.latency_ms), error: (r.error as string | null) ?? null,
    }, (r.key_name as string | null) ?? null))
  } finally {
    db.close()
  }
}

const summary = { files: 0, lines: 0, emptyDays: 0, oldRemoved: 0, oldKept: 0 }
const stamp = Date.now()

/** write a host's rebuilt days, then retire the old files they fully cover */
function rebuild(dir: string, host: string, days: number[], linesOf: Map<number, LogLine[]>): void {
  const have = new Set<string>()
  for (const day of days) {
    const ymd = ymdOf(day)
    const lines = (linesOf.get(day) ?? []).sort((a, b) => a.ts - b.ts)
    if (!lines.length) {
      summary.emptyDays++
      console.log(`${host} ${ymd}: nothing to rebuild from`)
      continue
    }
    const folder = folderOf(dir, host, ymd)
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, `${ymd}.rebuild-${stamp}.jsonl.gz`)
    writeFileSync(`${file}.tmp`, gzipSync(lines.map((l) => JSON.stringify(toRow(l))).join('\n') + '\n'))
    renameSync(`${file}.tmp`, file)
    // check the old files against what is on disk, not what is in memory
    for (const l of gunzipSync(readFileSync(file)).toString().trim().split('\n')) have.add(identity(JSON.parse(l) as ArchiveRow))
    summary.files++
    summary.lines += lines.length
    console.log(`${host} ${ymd}: ${lines.length} lines`)
  }
  // an old file's lines can belong to any rebuilt day (the pre-fix archive filed some under the previous day)
  for (const day of days) {
    const ymd = ymdOf(day)
    const folder = folderOf(dir, host, ymd)
    let names: string[]
    try {
      names = readdirSync(folder).filter((f) => f.startsWith(`${ymd}.`) && f.endsWith('.jsonl.gz') && !f.includes(`.rebuild-${stamp}.`))
    } catch {
      continue
    }
    for (const f of names) {
      const old = gunzipSync(readFileSync(path.join(folder, f))).toString().trim().split('\n').filter(Boolean)
      const missing = old.filter((l) => !have.has(identity(JSON.parse(l) as ArchiveRow)))
      if (!missing.length) {
        rmSync(path.join(folder, f))
        summary.oldRemoved++
      } else {
        summary.oldKept++
        const when = [...new Set(missing.map((l) => ymdOf((JSON.parse(l) as ArchiveRow).ts)))].join(', ')
        console.log(`${host}: kept ${f}: ${missing.length} of its ${old.length} lines aren't in the rebuild (from ${when})`)
      }
    }
  }
}

const [mode, first, last, ...nodes] = process.argv.slice(2)
const dir = process.env.SPARKMAN_LOG_ARCHIVE || fail('SPARKMAN_LOG_ARCHIVE is not set (the archive directory)')
const days = dayRange(first, last)
const byDay = (lines: LogLine[]) => {
  const m = new Map<number, LogLine[]>()
  for (const l of lines) {
    const day = Math.floor(l.ts / DAY) * DAY
    m.set(day, [...(m.get(day) ?? []), l])
  }
  return m
}

if (mode === 'journal') {
  if (!nodes.length) fail(USAGE)
  for (const spec of nodes) {
    const [node, target = node] = spec.split('=')
    const lines: LogLine[] = []
    for (const day of days) lines.push(...(await journalDay(node, target, day)))
    rebuild(dir, node, days, byDay(lines))
  }
} else if (mode === 'gateway') {
  if (nodes.length) fail(USAGE)
  const dbFile = path.join(process.env.SPARKMAN_FLEET_DB_DIR ?? path.join(os.homedir(), '.sparkman'), 'gateway.db')
  rebuild(dir, 'gateway', days, byDay(gatewayLines(dbFile, days[0], days.at(-1)! + DAY)))
} else {
  fail(USAGE)
}
console.log(`done: ${summary.lines} lines in ${summary.files} files; ${summary.emptyDays} days with nothing to rebuild from; old files removed ${summary.oldRemoved}, kept ${summary.oldKept}`)
