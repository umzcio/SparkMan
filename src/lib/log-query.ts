import type { LogLine } from '@/api/types'

export interface LogFilter {
  key: string
  value: string
  negate: boolean
}
export interface LogTerm {
  text: string
  negate: boolean
}
export interface ParsedLogQuery {
  filters: LogFilter[]
  terms: LogTerm[]
}
export type HighlightKind = 'key' | 'value' | 'negate' | 'term' | 'space'

interface RawToken {
  text: string
  /** text accumulated before the first quote, or null when the token had no quote */
  beforeQuote: string | null
}

function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i++
      continue
    }
    let text = ''
    let beforeQuote: string | null = null
    while (i < input.length && !/\s/.test(input[i])) {
      if (input[i] === '"') {
        if (beforeQuote === null) beforeQuote = text
        const close = input.indexOf('"', i + 1)
        const end = close === -1 ? input.length : close
        text += input.slice(i + 1, end)
        i = close === -1 ? input.length : close + 1
      } else {
        text += input[i]
        i++
      }
    }
    tokens.push({ text, beforeQuote })
  }
  return tokens
}

export function parseLogQuery(input: string): ParsedLogQuery {
  const filters: LogFilter[] = []
  const terms: LogTerm[] = []
  for (const tok of tokenize(input)) {
    let text = tok.text
    let negate = false
    if (text.startsWith('-')) {
      if (text.length === 1) continue
      negate = true
      text = text.slice(1)
    }
    const keyPart = tok.beforeQuote === null ? text : tok.beforeQuote.replace(/^-/, '')
    const colon = keyPart.indexOf(':')
    const isFilter = tok.beforeQuote === null ? colon > 0 : colon > 0 && colon === keyPart.length - 1
    if (isFilter) {
      const value = text.slice(colon + 1)
      if (value) filters.push({ key: text.slice(0, colon).toLowerCase(), value, negate })
      continue
    }
    if (text) terms.push({ text, negate })
  }
  return { filters, terms }
}

function fieldValue(line: LogLine, key: string): string | undefined {
  switch (key) {
    case 'level':
      return line.level
    case 'host':
      return line.host
    case 'source':
      return line.source
    case 'service':
      return line.service
    case 'pattern':
      return line.pattern
    default:
      return line.attributes[key]
  }
}

export function matchesLogQuery(line: LogLine, q: ParsedLogQuery): boolean {
  const positive = new Map<string, string[]>()
  for (const f of q.filters) {
    const target = f.value.toLowerCase()
    if (f.negate) {
      if (fieldValue(line, f.key)?.toLowerCase() === target) return false
      continue
    }
    positive.set(f.key, [...(positive.get(f.key) ?? []), target])
  }
  for (const [key, values] of positive) {
    const v = fieldValue(line, key)?.toLowerCase()
    if (v === undefined || !values.includes(v)) return false
  }
  const msg = line.message.toLowerCase()
  for (const t of q.terms) {
    const hit = msg.includes(t.text.toLowerCase())
    if (t.negate ? hit : !hit) return false
  }
  return true
}

export function highlightLogQuery(input: string): { text: string; kind: HighlightKind }[] {
  return input
    .split(/(\s+)/)
    .filter(Boolean)
    .flatMap((chunk): { text: string; kind: HighlightKind }[] => {
      if (/^\s+$/.test(chunk)) return [{ text: chunk, kind: 'space' }]
      if (chunk.startsWith('-') && chunk.length > 1) return [{ text: chunk, kind: 'negate' }]
      const m = /^([\w.]+:)(.*)$/.exec(chunk)
      if (m) return m[2] ? [{ text: m[1], kind: 'key' }, { text: m[2], kind: 'value' }] : [{ text: m[1], kind: 'key' }]
      return [{ text: chunk, kind: 'term' }]
    })
}
