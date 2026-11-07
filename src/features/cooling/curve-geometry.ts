import { CURVE_TEMP_MAX, CURVE_TEMP_MIN, type CurvePoint } from '@/lib/cooling'

export type Box = { w: number; h: number; pad: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const SPAN = CURVE_TEMP_MAX - CURVE_TEMP_MIN

export function toPx(p: CurvePoint, b: Box): { x: number; y: number } {
  return {
    x: b.pad + ((p.tempC - CURVE_TEMP_MIN) / SPAN) * (b.w - 2 * b.pad),
    y: b.h - b.pad - (p.duty / 100) * (b.h - 2 * b.pad),
  }
}

export function fromPx(x: number, y: number, b: Box): CurvePoint {
  const tempC = CURVE_TEMP_MIN + ((x - b.pad) / (b.w - 2 * b.pad)) * SPAN
  const duty = ((b.h - b.pad - y) / (b.h - 2 * b.pad)) * 100
  return { tempC: Math.round(clamp(tempC, CURVE_TEMP_MIN, CURVE_TEMP_MAX)), duty: Math.round(clamp(duty, 0, 100)) }
}
