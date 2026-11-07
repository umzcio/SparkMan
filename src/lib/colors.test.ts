// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CSS_VAR, contrastRatio, themes } from './colors'

function cssBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`missing ${selector}`)
  const body = css.slice(start, css.indexOf('}', start))
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].trim().toLowerCase()
  return vars
}

const css = readFileSync(path.resolve(__dirname, '../index.css'), 'utf8')

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for identical colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
    expect(contrastRatio('#76B900', '#76B900')).toBeCloseTo(1, 5)
  })
})

describe.each([
  ['dark', '.dark'],
  ['light', ':root'],
] as const)('%s theme', (name, selector) => {
  const t = themes[name]
  const vars = cssBlock(css, selector)

  it('index.css mirrors the token table', () => {
    for (const [key, cssVar] of Object.entries(CSS_VAR)) {
      expect(vars[cssVar], cssVar).toBe(t[key as keyof typeof CSS_VAR].toLowerCase())
    }
    t.categorical.forEach((hex, i) => expect(vars[`--cat-${i + 1}`]).toBe(hex.toLowerCase()))
  })

  it('text meets 4.5:1 on background and card', () => {
    for (const bg of [t.background, t.card]) {
      expect(contrastRatio(t.foreground, bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(t.mutedForeground, bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('data, level and brand colors meet 3:1 on card', () => {
    const marks = [t.brand, t.gpu, t.cpu, t.memory, t.power, t.levelError, t.levelWarn, t.levelInfo, t.levelDebug, ...t.categorical]
    for (const c of marks) expect(contrastRatio(c, t.card), c).toBeGreaterThanOrEqual(3)
  })
})
