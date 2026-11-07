import { describe, expect, it } from 'vitest'
import type { LogLine } from '@/api/types'
import { highlightLogQuery, matchesLogQuery, parseLogQuery } from './log-query'

const line = (over: Partial<LogLine> = {}): LogLine => ({
  id: '1', ts: 0, level: 'error', source: 'gateway', host: 'sparkman-gw', service: 'gateway',
  message: 'POST /v1/chat/completions 502 812ms upstream=spark-03 connection reset', pattern: 'abc123',
  attributes: { 'http.status_code': '502', model: 'gpt-oss-120b' }, ...over,
})

describe('parseLogQuery', () => {
  it('parses filters, negations, terms and quoted phrases', () => {
    expect(parseLogQuery('level:error host:spark-03 -healthcheck "connection reset" -"foo bar"')).toEqual({
      filters: [
        { key: 'level', value: 'error', negate: false },
        { key: 'host', value: 'spark-03', negate: false },
      ],
      terms: [
        { text: 'healthcheck', negate: true },
        { text: 'connection reset', negate: false },
        { text: 'foo bar', negate: true },
      ],
    })
  })
  it('supports quoted filter values and negated filters', () => {
    expect(parseLogQuery('host:"spark-01" -level:debug').filters).toEqual([
      { key: 'host', value: 'spark-01', negate: false },
      { key: 'level', value: 'debug', negate: true },
    ])
  })
  it('malformed input never throws', () => {
    for (const q of ['', '   ', 'host:', '"unterminated', '-', ':::', '-"', 'a:b:c', '""', '-host:']) {
      expect(() => parseLogQuery(q)).not.toThrow()
    }
    expect(parseLogQuery('host:')).toEqual({ filters: [], terms: [] })
    expect(parseLogQuery('"unterminated phrase')).toEqual({ filters: [], terms: [{ text: 'unterminated phrase', negate: false }] })
    expect(parseLogQuery(':::').terms).toEqual([{ text: ':::', negate: false }])
    expect(parseLogQuery('a:b:c').filters).toEqual([{ key: 'a', value: 'b:c', negate: false }])
  })
})

describe('matchesLogQuery', () => {
  it('ANDs across keys and ORs within the same key', () => {
    expect(matchesLogQuery(line(), parseLogQuery('level:error level:warn'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('level:warn'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('level:error host:spark-01'))).toBe(false)
  })
  it('handles negation, attributes, pattern and case-insensitive terms', () => {
    expect(matchesLogQuery(line(), parseLogQuery('-level:error'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('http.status_code:502'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('pattern:abc123'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('CONNECTION -timeout'))).toBe(true)
    expect(matchesLogQuery(line(), parseLogQuery('-reset'))).toBe(false)
    expect(matchesLogQuery(line(), parseLogQuery('nosuchattr:1'))).toBe(false)
  })
})

describe('highlightLogQuery', () => {
  it('round-trips the input text and classifies chunks', () => {
    const input = 'host:spark-03  -healthcheck timeout'
    const tokens = highlightLogQuery(input)
    expect(tokens.map((t) => t.text).join('')).toBe(input)
    expect(tokens.map((t) => t.kind)).toEqual(['key', 'value', 'space', 'negate', 'space', 'term'])
  })
})
