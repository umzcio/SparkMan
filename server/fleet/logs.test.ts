// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LogLine } from '../../src/api/types.ts'
import { journalToLine, LogStore, patternOf } from './logs.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-logs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const line = (over: Partial<LogLine>): LogLine => ({
  id: '', ts: NOW - 1000, level: 'info', source: 'journald', host: 'spark-01', service: 'sshd', message: 'hello', pattern: 'p', attributes: {}, ...over,
})

describe('journalToLine', () => {
  it('maps kernel Xid lines to errors with the Xid as an attribute', () => {
    const l = journalToLine('spark-01', {
      __REALTIME_TIMESTAMP: String(NOW * 1000), PRIORITY: '4', _TRANSPORT: 'kernel', SYSLOG_IDENTIFIER: 'kernel',
      MESSAGE: 'NVRM: Xid (PCI:000f:01:00): 31, pid=4242, name=python3',
    })!
    expect(l).toMatchObject({ ts: NOW, level: 'error', source: 'kernel', service: 'kernel', attributes: { xid: '31' } })
  })
  it('recognises engines and decodes byte-array messages', () => {
    const l = journalToLine('spark-02', { __REALTIME_TIMESTAMP: '1000', PRIORITY: '6', _SYSTEMD_UNIT: 'llama-swap.service', MESSAGE: [104, 105] })!
    expect(l).toMatchObject({ source: 'engine', service: 'llama-swap', message: 'hi', attributes: { unit: 'llama-swap' } })
  })
  it('drops entries without a timestamp or message', () => {
    expect(journalToLine('h', { MESSAGE: 'x' })).toBeNull()
    expect(journalToLine('h', { __REALTIME_TIMESTAMP: '1', MESSAGE: '' })).toBeNull()
  })
  it('gives messages that differ only in numbers one pattern', () => {
    expect(patternOf('sshd', 'Accepted key for zz from 10.0.0.5 port 4021')).toBe(patternOf('sshd', 'Accepted key for zz from 10.0.0.9 port 51'))
    expect(patternOf('sshd', 'a')).not.toBe(patternOf('cron', 'a'))
  })
})

describe('LogStore', () => {
  it('filters by fields, attributes and terms, newest first, with a histogram', () => {
    const s = new LogStore(':memory:')
    s.add(line({ ts: NOW - 3000, level: 'error', host: 'spark-01', source: 'kernel', message: 'NVRM: Xid 31', attributes: { xid: '31' } }))
    s.add(line({ ts: NOW - 2000, level: 'info', host: 'spark-02', message: 'Started session' }))
    s.add(line({ ts: NOW - 1000, level: 'warn', host: 'spark-01', message: 'Link down' }))
    const all = s.query({ query: '', range: '15m' }, NOW)
    expect(all.lines.map((l) => l.message)).toEqual(['Link down', 'Started session', 'NVRM: Xid 31'])
    expect(all.total).toBe(3)
    expect(all.histogram).toHaveLength(60)
    expect(s.query({ query: 'host:spark-01 -level:warn', range: '15m' }, NOW).lines.map((l) => l.message)).toEqual(['NVRM: Xid 31'])
    expect(s.query({ query: 'xid:31', range: '15m' }, NOW).lines).toHaveLength(1)
    expect(s.query({ query: 'session', range: '15m' }, NOW).lines).toHaveLength(1)
    expect(s.query({ query: '-session', range: '15m' }, NOW).lines).toHaveLength(2)
    expect(s.query({ query: '', range: '15m', around: NOW - 2000 }, NOW).lines).toHaveLength(3)
  })

  it('archives days older than a week to gzip JSONL and deletes them', async () => {
    const s = new LogStore(':memory:')
    const old = NOW - 9 * 86_400_000
    s.add(line({ ts: old, host: 'spark-01', message: 'old one' }))
    s.add(line({ ts: old + 1000, host: 'spark-01', message: 'old two' }))
    s.add(line({ ts: NOW - 1000, host: 'spark-01', message: 'fresh' }))
    const r = await s.archive(dir, NOW)
    expect(r).toEqual({ files: 1, lines: 2 })
    const ymd = new Date(old).toISOString().slice(0, 10)
    const folder = path.join(dir, 'spark-01', ymd.slice(0, 4), ymd.slice(5, 7))
    const [file] = readdirSync(folder)
    const rows = gunzipSync(readFileSync(path.join(folder, file))).toString().trim().split('\n').map((l) => JSON.parse(l) as { message: string })
    expect(rows.map((r) => r.message)).toEqual(['old one', 'old two'])
    expect(s.query({ query: '', range: '7d' }, NOW).lines.map((l) => l.message)).toEqual(['fresh'])
  })

  it('archives consecutive days whole, one file per host and day', async () => {
    // a fractional "day" (node:sqlite binds numbers as REAL) made a group per line; on consecutive days a later
    // group's window caught the next day's lines and overwrote the earlier file while every group deleted its lines
    const s = new LogStore(':memory:')
    const day1 = Math.floor((NOW - 10 * 86_400_000) / 86_400_000) * 86_400_000
    const messages: string[] = []
    for (const [d, h] of [[0, 1], [0, 9], [0, 23], [1, 0], [1, 12], [1, 22]]) {
      const msg = `day${d + 1} ${h}h`
      messages.push(msg)
      s.add(line({ ts: day1 + d * 86_400_000 + h * 3_600_000, host: 'spark-01', message: msg }))
    }
    expect(await s.archive(dir, NOW)).toEqual({ files: 2, lines: 6 })
    const read = (ts: number) => {
      const ymd = new Date(ts).toISOString().slice(0, 10)
      const folder = path.join(dir, 'spark-01', ymd.slice(0, 4), ymd.slice(5, 7))
      const files = readdirSync(folder).filter((f) => f.startsWith(ymd))
      expect(files).toHaveLength(1)
      return gunzipSync(readFileSync(path.join(folder, files[0]))).toString().trim().split('\n').map((l) => (JSON.parse(l) as { message: string }).message)
    }
    expect([...read(day1), ...read(day1 + 86_400_000)]).toEqual(messages)
    expect((s.db.prepare('SELECT count(*) AS n FROM logs').get() as { n: number }).n).toBe(0)
  })

  it('keeps lines hot when the archive is missing', async () => {
    const s = new LogStore(':memory:')
    s.add(line({ ts: NOW - 9 * 86_400_000 }))
    expect(await s.archive(path.join(dir, 'not-mounted'), NOW)).toMatchObject({ skipped: expect.stringContaining('unavailable') })
    expect(s.query({ query: '', range: '7d' }, NOW + 0).total).toBe(0)
    expect((s.db.prepare('SELECT count(*) AS n FROM logs').get() as { n: number }).n).toBe(1)
  })

  it('remembers journal cursors', () => {
    const s = new LogStore(':memory:')
    s.setCursor('spark-01', 's=abc;i=1')
    expect(s.cursor('spark-01')).toBe('s=abc;i=1')
    expect(s.cursor('spark-02')).toBeNull()
  })
})
