export type TimeRange = '15m' | '1h' | '6h' | '24h' | '7d'

const DASH = '—'
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const isMissing = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v)

function trimNumber(value: number): string {
  const fixed = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed
}

export function formatBytes(bytes: number | null | undefined): string {
  if (isMissing(bytes)) return DASH
  if (bytes === 0) return '0 B'
  const exp = Math.max(0, Math.min(Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)), UNITS.length - 1))
  return `${trimNumber(bytes / 1024 ** exp)} ${UNITS[exp]}`
}

export function formatGB(gb: number | null | undefined): string {
  return isMissing(gb) ? DASH : formatBytes(gb * 1024 ** 3)
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  return isMissing(bytesPerSec) ? DASH : `${formatBytes(bytesPerSec)}/s`
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  return isMissing(v) ? DASH : `${v.toFixed(digits)}%`
}

export function formatWatts(w: number | null | undefined): string {
  return isMissing(w) ? DASH : `${Math.round(w)} W`
}

export function formatTemp(c: number | null | undefined): string {
  return isMissing(c) ? DASH : `${Math.round(c)} °C`
}

const numberFmt = new Intl.NumberFormat('en-US')
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export const formatNumber = (n: number): string => numberFmt.format(Math.round(n))
export const formatCompact = (n: number): string => compactFmt.format(n)
export const formatUsd = (n: number): string => usdFmt.format(n)

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const s = Math.floor(ms / 1000)
  if (ms < 3_600_000) return `${Math.floor(s / 60)}m ${s % 60}s`
  const m = Math.floor(s / 60)
  if (ms < 86_400_000) return `${Math.floor(m / 60)}h ${m % 60}m`
  const h = Math.floor(m / 60)
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function formatRelative(ts: number, now: number): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatClock(ts: number, withMs = true): string {
  const d = new Date(ts)
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base
}

export function formatTimeTick(ts: number, range: TimeRange): string {
  const d = new Date(ts)
  if (range === '7d') return `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${formatClock(ts, false)}`
}

/** "58.2 tok/s", "1,240 tok/s" */
export function formatTokS(v: number | null | undefined): string {
  if (isMissing(v)) return DASH
  return `${Math.abs(v) >= 100 ? numberFmt.format(Math.round(v)) : v.toFixed(1)} tok/s`
}
