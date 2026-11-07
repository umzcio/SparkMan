import { DEFAULT_POLICY, stepDuty, zoneTarget, type CoolingPolicy, type DutyState, type FanReason, type Thermal } from '@/lib/cooling'
import type { CoolingPoint, CoolingState, Fan, TimeRange } from '../types'
import { seriesTimes } from './metrics'
import { noise } from './rng'

// Simulated Pico + three 140 mm PWM fans in front of the top shelf.

export const FAN_MAX_RPM = 1500
export const FAN_MIN_RPM = 300
export const WATCHDOG_MS = 10_000
export const STALL_MS = 5_000
export const PICO_PORT = '/dev/ttyACM0'
export const PICO_FIRMWARE = 'sparkman-fan 0.1.0'
const RPM_TAU_MS = 4_000
const STALL_RPM = 50
const HISTORY_MS = 2 * 3_600_000

/** a history sample plus the airflow each fan-shelf box got, so later zone edits don't rewrite the past */
type SimPoint = CoolingPoint & { flow: Record<string, number> }

export const DEFAULT_ZONES: Record<string, string[]> = {
  'fan-1': ['gx10-01', 'spark-01'],
  'fan-2': ['spark-02', 'spark-03', 'spark-04'],
  'fan-3': ['dell-01', 'dell-02'],
}

/** steady-state RPM for a duty; PWM fans keep a minimum spin above 0 % */
/** boxes the front fans can cool (the top shelf) */
const FAN_SHELF = Object.values(DEFAULT_ZONES).flat()

export function rpmFor(duty: number): number {
  return duty <= 0 ? 0 : Math.max(FAN_MIN_RPM, (FAN_MAX_RPM * duty) / 100)
}

interface FanRuntime {
  id: string
  name: string
  nodeIds: string[]
  state: DutyState | null
  /** smoothed, before tach jitter */
  rpm: number
  manualDuty: number | null
  reason: FanReason
  zeroSince: number | null
}

export class CoolingSim {
  /** false while the Pico is unplugged / silent */
  connected = true
  /** fan whose tach reads 0 (failure injection) */
  stalledFan: string | null = null
  policy: CoolingPolicy = structuredClone(DEFAULT_POLICY)
  private seed: number
  private fans: FanRuntime[]
  private lastHeartbeatAt: number | null = null
  private lastStepAt: number | null = null
  private history: SimPoint[] = []

  constructor(opts: { seed: number }) {
    this.seed = opts.seed
    this.fans = Object.entries(DEFAULT_ZONES).map(([id, nodeIds], i) => ({
      id, name: `Fan ${i + 1}`, nodeIds: [...nodeIds], state: null, rpm: 0, manualDuty: null, reason: { kind: 'idle' }, zeroSince: null,
    }))
  }

  fanIds(): string[] {
    return this.fans.map((f) => f.id)
  }

  fan(id: string): { id: string; name: string; nodeIds: string[] } | null {
    const f = this.fans.find((x) => x.id === id)
    return f ? { id: f.id, name: f.name, nodeIds: [...f.nodeIds] } : null
  }

  private failsafe(now: number): boolean {
    return !this.connected && this.lastHeartbeatAt !== null && now - this.lastHeartbeatAt >= WATCHDOG_MS
  }

  step(now: number, thermal: (nodeId: string) => Thermal): void {
    if (this.connected) this.lastHeartbeatAt = now
    const failsafe = this.failsafe(now)
    const dt = this.lastStepAt === null ? Infinity : now - this.lastStepAt
    const point: SimPoint = { t: now, duty: {}, rpm: {}, zoneTempC: {}, flow: {} }
    for (const f of this.fans) {
      const zone = f.nodeIds.map((id) => ({ id, thermal: thermal(id) }))
      if (failsafe) {
        f.state = { duty: 100, heldAt: now, at: now }
        f.reason = { kind: 'failsafe' }
      } else if (!this.connected) {
        // the Pico keeps applying the last command until its watchdog fires; the ramp resumes from now on reconnect
        if (f.state) f.state = { ...f.state, at: now }
      } else if (f.manualDuty !== null) {
        f.state = { duty: f.manualDuty, heldAt: now, at: now }
        f.reason = { kind: 'manual' }
      } else {
        const target = zoneTarget(this.policy, zone)
        f.state = stepDuty(f.state, target.duty, now, this.policy)
        f.reason = target.reason
      }
      const duty = f.state?.duty ?? 100
      const goal = rpmFor(duty)
      if (f.id === this.stalledFan) f.rpm = 0 // the tach reads nothing (seized fan or loose cable)
      else f.rpm = dt === Infinity ? goal : f.rpm + (goal - f.rpm) * (1 - Math.exp(-dt / RPM_TAU_MS))
      if (goal === 0 && f.rpm < 20) f.rpm = 0
      const measured = this.measured(f, now)
      f.zeroSince = duty >= 20 && measured < STALL_RPM ? (f.zeroSince ?? now) : null
      const temps = zone.flatMap((z) => (z.thermal ? [z.thermal.gpuTempC] : []))
      point.duty[f.id] = duty
      point.rpm[f.id] = measured
      point.zoneTempC[f.id] = temps.length ? Math.max(...temps) : null
    }
    for (const id of FAN_SHELF) {
      const f = this.fans.find((x) => x.nodeIds.includes(id))
      point.flow[id] = f ? point.rpm[f.id] / FAN_MAX_RPM : 0
    }
    this.history.push(point)
    while (this.history.length && this.history[0].t < now - HISTORY_MS) this.history.shift()
    this.lastStepAt = now
  }

  private measured(f: FanRuntime, now: number): number {
    const jitter = 0.015 * (2 * noise(this.seed, f.id, 'rpm', Math.floor(now / 2000)) - 1)
    return Math.round(f.rpm * (1 + jitter))
  }

  /** latest history point at or before t */
  private pointAt(t: number): SimPoint | null {
    let lo = 0
    let hi = this.history.length - 1
    let found: SimPoint | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.history[mid].t <= t) {
        found = this.history[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }

  /** airflow a box got at time t (0–1); before the first sample the oldest stands in; null off the fan shelf */
  airflowAt(nodeId: string, t: number): number | null {
    if (!FAN_SHELF.includes(nodeId)) return null
    const p = this.pointAt(t) ?? this.history[0]
    return p ? (p.flow[nodeId] ?? 0) : null
  }

  state(now: number): CoolingState {
    const last = this.history.at(-1)
    return {
      controller: {
        connected: this.connected,
        port: PICO_PORT,
        firmware: PICO_FIRMWARE,
        lastHeartbeatAt: this.lastHeartbeatAt,
        watchdogMs: WATCHDOG_MS,
        failsafe: this.failsafe(now),
      },
      fans: this.fans.map(
        (f): Fan => ({
          id: f.id,
          name: f.name,
          nodeIds: [...f.nodeIds],
          duty: Math.round(f.state?.duty ?? 100),
          rpm: last?.rpm[f.id] ?? 0,
          mode: f.manualDuty === null ? 'auto' : 'manual',
          manualDuty: f.manualDuty,
          reason: { ...f.reason },
          stalled: f.zeroSince !== null && now - f.zeroSince >= STALL_MS,
        }),
      ),
      policy: structuredClone(this.policy),
      maxRpm: FAN_MAX_RPM,
    }
  }

  series(range: TimeRange, now: number): CoolingPoint[] {
    return seriesTimes(range, now).flatMap((t) => {
      const p = this.pointAt(t)
      return p ? [{ t, duty: { ...p.duty }, rpm: { ...p.rpm }, zoneTempC: { ...p.zoneTempC } }] : []
    })
  }

  /** caller validates; takes effect at once (RPM follows over the next ticks) */
  setManual(fanId: string, duty: number | null, now: number): void {
    const f = this.fans.find((x) => x.id === fanId)!
    f.manualDuty = duty
    if (duty !== null && this.connected) {
      f.state = { duty, heldAt: now, at: now }
      f.reason = { kind: 'manual' }
    }
  }

  setPolicy(p: CoolingPolicy): void {
    this.policy = structuredClone(p)
  }

  /** caller validates */
  setZones(zones: Record<string, string[]>): void {
    for (const f of this.fans) f.nodeIds = [...(zones[f.id] ?? [])]
  }
}
