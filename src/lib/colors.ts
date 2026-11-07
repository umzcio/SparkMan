export interface ThemeTokens {
  background: string
  card: string
  foreground: string
  mutedForeground: string
  brand: string
  gpu: string
  cpu: string
  memory: string
  power: string
  levelError: string
  levelWarn: string
  levelInfo: string
  levelDebug: string
  categorical: string[]
}

export const themes: Record<'dark' | 'light', ThemeTokens> = {
  dark: {
    background: '#0A0B0A',
    card: '#111311',
    foreground: '#EDEEEC',
    mutedForeground: '#9BA19A',
    brand: '#76B900',
    gpu: '#76B900',
    cpu: '#2DD4BF',
    memory: '#A78BFA',
    power: '#F5A524',
    levelError: '#F2545B',
    levelWarn: '#F5A524',
    levelInfo: '#5B7CFA',
    levelDebug: '#8A8F98',
    categorical: ['#76B900', '#2DD4BF', '#A78BFA', '#F5A524', '#5B7CFA', '#F472B6', '#94A3B8'],
  },
  light: {
    background: '#F7F8F6',
    card: '#FFFFFF',
    foreground: '#0F120E',
    mutedForeground: '#5C6359',
    brand: '#4F7D00',
    gpu: '#4F7D00',
    cpu: '#0F9488',
    memory: '#7C3AED',
    power: '#D97706',
    levelError: '#DC2626',
    levelWarn: '#B45309',
    levelInfo: '#3B5BDB',
    levelDebug: '#6B7280',
    categorical: ['#4F7D00', '#0F9488', '#7C3AED', '#D97706', '#3B5BDB', '#DB2777', '#64748B'],
  },
}

export const CSS_VAR: Record<Exclude<keyof ThemeTokens, 'categorical'>, string> = {
  background: '--background',
  card: '--card',
  foreground: '--foreground',
  mutedForeground: '--muted-foreground',
  brand: '--brand',
  gpu: '--gpu',
  cpu: '--cpu',
  memory: '--memory',
  power: '--power',
  levelError: '--level-error',
  levelWarn: '--level-warn',
  levelInfo: '--level-info',
  levelDebug: '--level-debug',
}

function channel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
