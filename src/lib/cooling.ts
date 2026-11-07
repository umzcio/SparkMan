// Fan control for the rack's front fans. Pure, so the simulator and (phase 2) the host's Pico bridge share it.

export interface CurvePoint {
  tempC: number
  /** 0–100 */
  duty: number
}

export interface CoolingPolicy {
  /** 2–6 points, temperatures increasing, duty never decreasing */
  curve: CurvePoint[]
  /** a box at or above `util` % GPU asks for at least `duty` %, before its heat shows */
  loadFloor: { util: number; duty: number }
  minDuty: number
  /** how long a fan holds after its last rise before slowing down */
  holdMs: number
  /** duty points per second once the hold is over */
  rampDownPerSec: number
}

export type FanReasonKind = 'temp' | 'load' | 'no-data' | 'idle' | 'manual' | 'failsafe'

/** why a fan runs at its speed: the box that set it and the reading */
export interface FanReason {
  kind: FanReasonKind
  nodeId?: string
  value?: number
}

/** what the loop needs from a box; null when it is offline, rebooting or silent */
export type Thermal = { gpuTempC: number; gpuUtil: number } | null

export interface Demand {
  duty: number
  reason: FanReason
}

export interface DutyState {
  duty: number
  /** last time the duty rose (starts the hold) */
  heldAt: number
  /** last step */
  at: number
}

export const CURVE_TEMP_MIN = 30
export const CURVE_TEMP_MAX = 95

export const DEFAULT_POLICY: CoolingPolicy = {
  curve: [
    { tempC: 45, duty: 25 },
    { tempC: 60, duty: 40 },
    { tempC: 72, duty: 65 },
    { tempC: 82, duty: 100 },
  ],
  loadFloor: { util: 80, duty: 50 },
  minDuty: 20,
  holdMs: 30_000,
  rampDownPerSec: 2,
}

const clampDuty = (d: number) => Math.min(100, Math.max(0, d))

export function curveDuty(curve: CurvePoint[], tempC: number): number {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (tempC <= first.tempC) return first.duty
  if (tempC >= last.tempC) return last.duty
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]
    const b = curve[i]
    if (tempC <= b.tempC) return a.duty + ((tempC - a.tempC) / (b.tempC - a.tempC)) * (b.duty - a.duty)
  }
  return last.duty
}

export function nodeDemand(policy: CoolingPolicy, nodeId: string, thermal: Thermal): Demand {
  if (!thermal) return { duty: 100, reason: { kind: 'no-data', nodeId } }
  const byTemp = curveDuty(policy.curve, thermal.gpuTempC)
  const byLoad = thermal.gpuUtil >= policy.loadFloor.util ? policy.loadFloor.duty : 0
  const duty = clampDuty(Math.max(byTemp, byLoad, policy.minDuty))
  return byLoad > byTemp
    ? { duty, reason: { kind: 'load', nodeId, value: thermal.gpuUtil } }
    : { duty, reason: { kind: 'temp', nodeId, value: thermal.gpuTempC } }
}

/** The fan follows its hungriest box; ties go to the hotter one, and a silent box counts as hottest. */
export function zoneTarget(policy: CoolingPolicy, zone: { id: string; thermal: Thermal }[]): Demand {
  let best: (Demand & { temp: number }) | null = null
  for (const n of zone) {
    const d = nodeDemand(policy, n.id, n.thermal)
    const temp = n.thermal ? n.thermal.gpuTempC : Infinity
    if (!best || d.duty > best.duty || (d.duty === best.duty && temp > best.temp)) best = { ...d, temp }
  }
  return best ? { duty: best.duty, reason: best.reason } : { duty: policy.minDuty, reason: { kind: 'idle' } }
}

/** Rise at once; after a rise, hold `holdMs`, then fall at `rampDownPerSec` until reaching the target. */
export function stepDuty(prev: DutyState | null, target: number, now: number, policy: CoolingPolicy): DutyState {
  if (!prev || target >= prev.duty) return { duty: target, heldAt: now, at: now }
  const holdEnds = prev.heldAt + policy.holdMs
  if (now < holdEnds) return { duty: prev.duty, heldAt: prev.heldAt, at: now }
  const from = Math.max(prev.at, holdEnds)
  return { duty: Math.max(target, prev.duty - (policy.rampDownPerSec * (now - from)) / 1000), heldAt: prev.heldAt, at: now }
}

const inRange = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi

export function validateCurve(curve: CurvePoint[]): string | null {
  if (!Array.isArray(curve) || curve.length < 2 || curve.length > 6) return 'The curve needs 2 to 6 points'
  for (const p of curve) {
    if (!p || !inRange(p.tempC, CURVE_TEMP_MIN, CURVE_TEMP_MAX)) return `Points must sit between ${CURVE_TEMP_MIN}–${CURVE_TEMP_MAX} °C`
    if (!inRange(p.duty, 0, 100)) return 'Fan speed must be 0–100 %'
  }
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].tempC <= curve[i - 1].tempC) return 'Temperatures must increase from left to right'
    if (curve[i].duty < curve[i - 1].duty) return 'A hotter point can’t run the fans slower'
  }
  return null
}

export function validatePolicy(p: CoolingPolicy): string | null {
  if (!p || typeof p !== 'object') return 'Missing cooling policy'
  const curve = validateCurve(p.curve)
  if (curve) return curve
  if (!p.loadFloor || !inRange(p.loadFloor.util, 0, 100) || !inRange(p.loadFloor.duty, 0, 100)) return 'Load floor must be 0–100 %'
  if (!inRange(p.minDuty, 0, 100)) return 'Minimum speed must be 0–100 %'
  if (!inRange(p.holdMs, 0, 600_000)) return 'Hold must be 0–600 s'
  if (!(Number.isFinite(p.rampDownPerSec) && p.rampDownPerSec > 0)) return 'Ramp-down must be above 0 %/s'
  return null
}

export function reasonText(r: FanReason): string {
  switch (r.kind) {
    case 'temp':
      return `${r.nodeId} ${Math.round(r.value ?? 0)} °C`
    case 'load':
      return `Load floor · ${r.nodeId} ${Math.round(r.value ?? 0)}% GPU`
    case 'no-data':
      return `${r.nodeId} offline — running safe`
    case 'idle':
      return 'No boxes in this zone'
    case 'manual':
      return 'Manual'
    case 'failsafe':
      return 'Pico failsafe'
  }
}
