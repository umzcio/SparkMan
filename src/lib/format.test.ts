import { describe, expect, it } from 'vitest'
import {
  formatBytes, formatClock, formatCompact, formatDateTime, formatDuration, formatGB, formatNumber,
  formatPercent, formatRate, formatRelative, formatTemp, formatTimeTick, formatTokS, formatUsd, formatWatts,
} from './format'

describe('format', () => {
  it('formatBytes uses 1024 steps and trims .0', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(128 * 1024 ** 3)).toBe('128 GB')
    expect(formatBytes(0.4)).toBe('0.4 B')
    expect(formatBytes(null)).toBe('—')
  })
  it('formatGB and formatRate', () => {
    expect(formatGB(1536)).toBe('1.5 TB')
    expect(formatGB(97.25)).toBe('97.3 GB')
    expect(formatRate(4.8 * 1024 ** 2)).toBe('4.8 MB/s')
    expect(formatRate(null)).toBe('—')
  })
  it('percent, watts, temp', () => {
    expect(formatPercent(27.4)).toBe('27%')
    expect(formatPercent(0.123, 1)).toBe('0.1%')
    expect(formatPercent(null)).toBe('—')
    expect(formatWatts(86.6)).toBe('87 W')
    expect(formatTemp(64.2)).toBe('64 °C')
  })
  it('numbers and money', () => {
    expect(formatNumber(28369)).toBe('28,369')
    expect(formatCompact(1_234_000)).toBe('1.2M')
    expect(formatCompact(950)).toBe('950')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
  })
  it('formatDuration picks a sensible unit', () => {
    expect(formatDuration(312)).toBe('312 ms')
    expect(formatDuration(5012)).toBe('5.0 s')
    expect(formatDuration(65_000)).toBe('1m 5s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h')
  })
  it('formatRelative', () => {
    const now = 1_000_000_000
    expect(formatRelative(now - 2_000, now)).toBe('just now')
    expect(formatRelative(now - 12_000, now)).toBe('12s ago')
    expect(formatRelative(now - 4 * 60_000, now)).toBe('4m ago')
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(formatRelative(now + 5_000, now)).toBe('just now')
  })
  it('clock, ticks and date-time use local time', () => {
    const ts = new Date(2026, 9, 8, 16, 16, 31, 640).getTime()
    expect(formatClock(ts)).toBe('16:16:31.640')
    expect(formatClock(ts, false)).toBe('16:16:31')
    expect(formatTimeTick(ts, '1h')).toBe('16:16')
    expect(formatTimeTick(ts, '7d')).toBe('Oct 8')
    expect(formatDateTime(ts)).toBe('Oct 8, 16:16:31')
  })
  it('formatTokS', () => {
    expect(formatTokS(58.24)).toBe('58.2 tok/s')
    expect(formatTokS(1240.4)).toBe('1,240 tok/s')
    expect(formatTokS(null)).toBe('—')
  })
})
