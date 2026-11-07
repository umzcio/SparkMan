# SparkMan Cooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cooling page that shows three Pico-driven 140 mm fans in front of the top shelf, controlled by SparkMan from each zone's GPU temperature and load, running on the simulator.

**Architecture:** The control loop is pure functions in `src/lib/cooling.ts` (phase 2's host bridge reuses them). `src/api/mock/cooling.ts` holds a `CoolingSim` (fan state, RPM lag, Pico link, history) that the `Simulator` steps every tick; fan airflow feeds back into node temperatures through `MetricWorld.airflow`. The page talks only to `SparkManClient`, like every other page.

**Tech Stack:** React 19, TypeScript (strict, `verbatimModuleSyntax`, `erasableSyntaxOnly`), Tailwind 4, shadcn/ui (radix-ui), TanStack Router + Query, Recharts 3, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-sparkman-cooling-design.md`

## Global Constraints

- Never edit files in `src/components/ui/`. (The fan speed slider uses the `radix-ui` Slider primitive directly so its thumb can carry an accessible name.)
- UI code (`features`, `components`, `routes`, `lib`) never imports `src/api/mock` (enforced by `src/api/architecture.test.ts`).
- Run `pnpm typecheck` (it runs `tsr generate` before `tsc -b`) after adding a route file.
- Default policy: curve 45 °C→25 %, 60→40, 72→65, 82→100; load floor 80 % GPU ⇒ ≥ 50 %; min duty 20 %; hold 30 000 ms; ramp-down 2 %/s.
- Fans: `fan-1` → gx10-01, spark-01 · `fan-2` → spark-02, spark-03, spark-04 · `fan-3` → dell-01, dell-02. Only shelf-1 boxes may be in a zone; a box is in at most one zone.
- Fan max 1500 RPM, min spin 300 RPM; Pico watchdog 10 000 ms; stall after 5 000 ms at < 50 RPM while duty ≥ 20 %. Port `/dev/ttyACM0`, firmware `sparkman-fan 0.1.0`.
- A box with no telemetry demands 100 %.
- Motion respects `prefers-reduced-motion` (blades don't spin).
- Copy style: sentence case, `°C` with a space before it, en dash for ranges, no exclamation marks.
- Commit after every task; end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Manual override to 0 %** — the fan stops (RPM 0) but must not be reported as stalled (stall needs duty ≥ 20 %). Test in Task 3.
2. **A zone box goes offline** (Settings → Take a node offline: spark-03) — its fan goes to 100 % with "spark-03 offline — running safe", not the fan ignoring it. Test in Task 4.
3. **Pico disconnect, then reconnect** — fans hold their last speed until the watchdog, go 100 %, and after reconnect come down slowly (hold, then ramp), not snap. Test in Task 3.
4. **Resolving the "Cooling controller offline" incident from the Alerts page** switches the Pico failure off too (same as the other injected incidents). Test in Task 4.
5. **Saving an invalid curve** (two points at the same temperature, or a hotter point with lower duty) — rejected with a readable message, the old curve stays. Tests in Tasks 1 and 4, UI in Task 7.

---

### Task 1: Control logic — `src/lib/cooling.ts`

**Files:**
- Create: `src/lib/cooling.ts`
- Test: `src/lib/cooling.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `interface CurvePoint { tempC: number; duty: number }`
  - `interface CoolingPolicy { curve: CurvePoint[]; loadFloor: { util: number; duty: number }; minDuty: number; holdMs: number; rampDownPerSec: number }`
  - `type FanReasonKind = 'temp' | 'load' | 'no-data' | 'idle' | 'manual' | 'failsafe'`
  - `interface FanReason { kind: FanReasonKind; nodeId?: string; value?: number }`
  - `type Thermal = { gpuTempC: number; gpuUtil: number } | null`
  - `interface Demand { duty: number; reason: FanReason }`
  - `interface DutyState { duty: number; heldAt: number; at: number }`
  - `const DEFAULT_POLICY: CoolingPolicy`, `const CURVE_TEMP_MIN = 30`, `const CURVE_TEMP_MAX = 95`
  - `curveDuty(curve, tempC): number`, `nodeDemand(policy, nodeId, thermal): Demand`, `zoneTarget(policy, zone: { id: string; thermal: Thermal }[]): Demand`, `stepDuty(prev: DutyState | null, target, now, policy): DutyState`, `validateCurve(curve): string | null`, `validatePolicy(policy): string | null`, `reasonText(reason): string`

- [ ] **Step 1: Write the failing tests** — `src/lib/cooling.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, curveDuty, nodeDemand, reasonText, stepDuty, validateCurve, validatePolicy, zoneTarget, type CoolingPolicy } from './cooling'

const P: CoolingPolicy = DEFAULT_POLICY

describe('curveDuty', () => {
  it('interpolates between points and holds the ends', () => {
    expect(curveDuty(P.curve, 30)).toBe(25)
    expect(curveDuty(P.curve, 45)).toBe(25)
    expect(curveDuty(P.curve, 52.5)).toBeCloseTo(32.5)
    expect(curveDuty(P.curve, 72)).toBe(65)
    expect(curveDuty(P.curve, 77)).toBeCloseTo(82.5)
    expect(curveDuty(P.curve, 95)).toBe(100)
  })
})

describe('nodeDemand', () => {
  it('follows the curve and names the box', () => {
    expect(nodeDemand(P, 'spark-02', { gpuTempC: 72, gpuUtil: 40 })).toEqual({ duty: 65, reason: { kind: 'temp', nodeId: 'spark-02', value: 72 } })
  })
  it('lets heavy load set a floor before the heat shows', () => {
    expect(nodeDemand(P, 'spark-03', { gpuTempC: 50, gpuUtil: 92 })).toEqual({ duty: 50, reason: { kind: 'load', nodeId: 'spark-03', value: 92 } })
  })
  it('never goes under the minimum', () => {
    const p = { ...P, minDuty: 30 }
    expect(nodeDemand(p, 'a', { gpuTempC: 30, gpuUtil: 0 }).duty).toBe(30)
  })
  it('treats a silent box as hot', () => {
    expect(nodeDemand(P, 'dell-02', null)).toEqual({ duty: 100, reason: { kind: 'no-data', nodeId: 'dell-02' } })
  })
})

describe('zoneTarget', () => {
  it('takes the hungriest box in the zone', () => {
    const d = zoneTarget(P, [
      { id: 'a', thermal: { gpuTempC: 50, gpuUtil: 10 } },
      { id: 'b', thermal: { gpuTempC: 78, gpuUtil: 10 } },
    ])
    expect(d.reason).toMatchObject({ kind: 'temp', nodeId: 'b' })
  })
  it('breaks ties by temperature, silent boxes first', () => {
    const hot = { gpuTempC: 90, gpuUtil: 10 }
    expect(zoneTarget(P, [{ id: 'a', thermal: hot }, { id: 'b', thermal: null }]).reason).toMatchObject({ kind: 'no-data', nodeId: 'b' })
    expect(zoneTarget(P, [{ id: 'a', thermal: { gpuTempC: 85, gpuUtil: 0 } }, { id: 'b', thermal: hot }]).reason.nodeId).toBe('b')
  })
  it('idles an empty zone at the minimum', () => {
    expect(zoneTarget(P, [])).toEqual({ duty: 20, reason: { kind: 'idle' } })
  })
})

describe('stepDuty', () => {
  it('rises at once', () => {
    expect(stepDuty({ duty: 30, heldAt: 0, at: 0 }, 70, 1000, P)).toEqual({ duty: 70, heldAt: 1000, at: 1000 })
  })
  it('holds, then ramps down at the set rate, never below the target', () => {
    let s = stepDuty(null, 80, 0, P)
    s = stepDuty(s, 30, 20_000, P)
    expect(s.duty).toBe(80) // still holding
    s = stepDuty(s, 30, 35_000, P)
    expect(s.duty).toBeCloseTo(70) // 5 s past the 30 s hold at 2 %/s
    s = stepDuty(s, 30, 37_000, P)
    expect(s.duty).toBeCloseTo(66)
    s = stepDuty(s, 30, 200_000, P)
    expect(s.duty).toBe(30)
  })
})

describe('validation', () => {
  it('accepts the default', () => {
    expect(validatePolicy(P)).toBeNull()
  })
  it('rejects bad curves with a readable reason', () => {
    expect(validateCurve([{ tempC: 50, duty: 30 }])).toMatch(/2 to 6 points/)
    expect(validateCurve([{ tempC: 50, duty: 30 }, { tempC: 50, duty: 60 }])).toMatch(/increase/)
    expect(validateCurve([{ tempC: 50, duty: 60 }, { tempC: 70, duty: 40 }])).toMatch(/slower/)
    expect(validateCurve([{ tempC: 20, duty: 30 }, { tempC: 70, duty: 40 }])).toMatch(/30–95 °C/)
    expect(validateCurve([{ tempC: 40, duty: 30 }, { tempC: 70, duty: 140 }])).toMatch(/0–100 %/)
  })
  it('rejects bad policy numbers', () => {
    expect(validatePolicy({ ...P, minDuty: -1 })).toMatch(/Minimum/)
    expect(validatePolicy({ ...P, rampDownPerSec: 0 })).toMatch(/Ramp/)
    expect(validatePolicy({ ...P, loadFloor: { util: 120, duty: 50 } })).toMatch(/Load floor/)
  })
})

describe('reasonText', () => {
  it('reads like a sentence fragment', () => {
    expect(reasonText({ kind: 'temp', nodeId: 'spark-02', value: 78.4 })).toBe('spark-02 78 °C')
    expect(reasonText({ kind: 'load', nodeId: 'spark-03', value: 92.2 })).toBe('Load floor · spark-03 92% GPU')
    expect(reasonText({ kind: 'no-data', nodeId: 'dell-02' })).toBe('dell-02 offline — running safe')
    expect(reasonText({ kind: 'manual' })).toBe('Manual')
    expect(reasonText({ kind: 'failsafe' })).toBe('Pico failsafe')
    expect(reasonText({ kind: 'idle' })).toBe('No boxes in this zone')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/cooling.test.ts`
Expected: FAIL — cannot resolve `./cooling`.

- [ ] **Step 3: Implement** — `src/lib/cooling.ts`

```ts
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
  if (curve.length < 2 || curve.length > 6) return 'The curve needs 2 to 6 points'
  for (const p of curve) {
    if (!inRange(p.tempC, CURVE_TEMP_MIN, CURVE_TEMP_MAX)) return `Points must sit between ${CURVE_TEMP_MIN}–${CURVE_TEMP_MAX} °C`
    if (!inRange(p.duty, 0, 100)) return 'Fan speed must be 0–100 %'
  }
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].tempC <= curve[i - 1].tempC) return 'Temperatures must increase from left to right'
    if (curve[i].duty < curve[i - 1].duty) return 'A hotter point can’t run the fans slower'
  }
  return null
}

export function validatePolicy(p: CoolingPolicy): string | null {
  const curve = validateCurve(p.curve)
  if (curve) return curve
  if (!inRange(p.loadFloor.util, 0, 100) || !inRange(p.loadFloor.duty, 0, 100)) return 'Load floor must be 0–100 %'
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/cooling.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/lib/cooling.ts src/lib/cooling.test.ts
git commit -m "feat(cooling): fan control loop — curve, load floor, zones, hold and ramp-down

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Types, client contract, and airflow in the temperature model

**Files:**
- Modify: `src/api/types.ts` (FailureInjection ~line 333, Topic ~line 341, new cooling types at the end)
- Modify: `src/api/client.tsx` (interface, after `setFailures`)
- Modify: `src/api/mock/metrics.ts` (`MetricWorld`, `sampleNode`)
- Test: `src/api/mock/metrics.test.ts`

**Interfaces:**
- Consumes: `CoolingPolicy`, `FanReason` from Task 1.
- Produces:
  - `interface Fan { id: string; name: string; nodeIds: string[]; duty: number; rpm: number; mode: 'auto' | 'manual'; manualDuty: number | null; reason: FanReason; stalled: boolean }`
  - `interface CoolingController { connected: boolean; port: string; firmware: string; lastHeartbeatAt: number | null; watchdogMs: number; failsafe: boolean }`
  - `interface CoolingState { controller: CoolingController; fans: Fan[]; policy: CoolingPolicy; maxRpm: number }`
  - `interface CoolingPoint { t: number; duty: Record<string, number>; rpm: Record<string, number>; zoneTempC: Record<string, number | null> }`
  - `FailureInjection` gains `picoDisconnected: boolean; fanStalled: string | null`; `Topic` gains `'cooling'`
  - `SparkManClient` gains `getCooling(): Promise<CoolingState>`, `getCoolingSeries(range: TimeRange): Promise<CoolingPoint[]>`, `setFanOverride(fanId: string, duty: number | null): Promise<void>`, `setCoolingPolicy(patch: Partial<CoolingPolicy>): Promise<void>`, `setFanZones(zones: Record<string, string[]>): Promise<void>`
  - `MetricWorld.airflow?: (nodeId: string, t: number) => number | null` (0–1 fraction of max RPM; null = not fan-cooled) and `airflowOffsetC(flow: number, gpuUtil: number): number`

- [ ] **Step 1: Write the failing test** — append to `src/api/mock/metrics.test.ts` (merge imports with the existing ones; use the file's existing node/world helpers if it has them, otherwise this self-contained version)

```ts
import { airflowOffsetC, sampleNode, type MetricWorld } from './metrics'
import { NODE_SPECS } from './fixtures'

describe('airflow', () => {
  const node = NODE_SPECS.find((n) => n.id === 'spark-02')!
  const t = new Date(2026, 9, 8, 15, 0, 0).getTime()
  const world = (flow: number | null): MetricWorld => ({ seed: 1729, outages: [], gatewayErrorWindows: [], airflow: () => flow })

  it('slow fans run a loaded box ~11 °C hotter than full fans', () => {
    expect(airflowOffsetC(0.2, 100) - airflowOffsetC(1, 100)).toBeCloseTo(11.2)
    expect(airflowOffsetC(0.2, 0) - airflowOffsetC(1, 0)).toBeCloseTo(4.48)
  })

  it('moves the sampled GPU temperature, and leaves uncooled boxes alone', () => {
    const slow = sampleNode(world(0.2), node, null, t).gpuTempC!
    const fast = sampleNode(world(1), node, null, t).gpuTempC!
    const none = sampleNode(world(null), node, null, t).gpuTempC!
    const legacy = sampleNode({ seed: 1729, outages: [], gatewayErrorWindows: [] }, node, null, t).gpuTempC!
    expect(slow).toBeGreaterThan(fast)
    expect(none).toBe(legacy)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/metrics.test.ts`
Expected: FAIL — `airflowOffsetC` is not exported / `airflow` not in `MetricWorld`.

- [ ] **Step 3: Implement**

`src/api/mock/metrics.ts` — extend `MetricWorld` and `sampleNode`:

```ts
export interface MetricWorld {
  seed: number
  outages: Outage[]
  gatewayErrorWindows: { from: number; to: number | null }[]
  /** front-fan airflow at a box (0–1 of max RPM) at time t; null when no fan covers it */
  airflow?: (nodeId: string, t: number) => number | null
}

/** °C a box gains (+) or loses (−) from its fan's airflow; ~0 at the auto curve's usual 55 %, bigger under load. */
export function airflowOffsetC(flow: number, gpuUtil: number): number {
  return (0.4 + (0.6 * gpuUtil) / 100) * 14 * (0.55 - flow)
}
```

In `sampleNode`, replace the `gpuTempC` line with:

```ts
  const flow = world.airflow?.(node.id, t) ?? null
  const cooled = flow === null ? 0 : airflowOffsetC(flow, gpuUtil)
  const gpuTempC = clamp(36 + gpuUtil * 0.38 + n('t') * 2 + thermal + cooled, 25, 102)
```

`src/api/types.ts`:

```ts
// top of file, next to the TimeRange import
import type { CoolingPolicy, FanReason } from '@/lib/cooling'
export type { CoolingPolicy, CurvePoint, FanReason } from '@/lib/cooling'
```

```ts
export interface FailureInjection {
  nodeOffline: string | null
  gatewayErrors: boolean
  xidStorm: boolean
  /** when true, MockClient rejects every request except failure get/set (exercises UI error states) */
  apiErrors: boolean
  /** the Pico stops answering; after its watchdog it runs every fan at 100 % */
  picoDisconnected: boolean
  /** id of a fan whose tach reads 0 while it is driven */
  fanStalled: string | null
}

export type Topic =
  | 'nodes' | 'deployments' | 'keys' | 'rules' | 'incidents' | 'updates' | 'rollouts' | 'activity' | 'failures' | 'benchmarks' | 'cooling'
```

Append:

```ts
// ---------- cooling (front fans on the Pico) ----------

export interface Fan {
  id: string
  name: string
  /** the boxes in front of it (its zone) */
  nodeIds: string[]
  /** commanded, 0–100 */
  duty: number
  /** measured from the tach */
  rpm: number
  mode: 'auto' | 'manual'
  manualDuty: number | null
  reason: FanReason
  /** driven at ≥ 20 % but the tach has read ~0 for 5 s */
  stalled: boolean
}

export interface CoolingController {
  connected: boolean
  port: string
  firmware: string
  lastHeartbeatAt: number | null
  watchdogMs: number
  /** the Pico has lost SparkMan and runs every fan at 100 % */
  failsafe: boolean
}

export interface CoolingState {
  controller: CoolingController
  fans: Fan[]
  policy: CoolingPolicy
  maxRpm: number
}

export interface CoolingPoint {
  t: number
  /** by fan id */
  duty: Record<string, number>
  rpm: Record<string, number>
  /** hottest GPU in each fan's zone; null when none reported */
  zoneTempC: Record<string, number | null>
}
```

`src/api/client.tsx` — add the import of `CoolingPoint, CoolingPolicy, CoolingState` to the existing type import from `./types`, and after `setFailures(...)`:

```ts
  /** Front fans: controller link, each fan's speed, RPM and reason, and the active policy. */
  getCooling(): Promise<CoolingState>
  getCoolingSeries(range: TimeRange): Promise<CoolingPoint[]>
  /** Pin a fan to `duty` (0–100); null returns it to the curve. */
  setFanOverride(fanId: string, duty: number | null): Promise<void>
  /** Rejects (invalid) when the merged policy fails validation. */
  setCoolingPolicy(patch: Partial<CoolingPolicy>): Promise<void>
  /** Every fan id → its shelf-1 boxes; a box may sit in one zone only. */
  setFanZones(zones: Record<string, string[]>): Promise<void>
```

Typecheck will now fail in `MockClient` and `Simulator` (missing methods/fields) — Tasks 3–4 fix those. To keep this task's commit green, add temporary stubs **only in `MockClient`**:

```ts
  getCooling(): Promise<CoolingState> { return Promise.reject(new SimError('unavailable', 'Cooling not wired yet')) }
  getCoolingSeries(): Promise<CoolingPoint[]> { return Promise.resolve([]) }
  setFanOverride(): Promise<void> { return Promise.resolve() }
  setCoolingPolicy(): Promise<void> { return Promise.resolve() }
  setFanZones(): Promise<void> { return Promise.resolve() }
```

and in `Simulator`, set the initial failures to `{ nodeOffline: null, gatewayErrors: false, xidStorm: false, apiErrors: false, picoDisconnected: false, fanStalled: null }`; update the exact-object assertion in `src/api/mock/simulator.test.ts:210` to include `picoDisconnected: false, fanStalled: null`. In `resolveIncident`, the `else this.failures[kind] = false` line stays valid until Task 4 adds new kinds.

Add a `cooling` entry to `TOPIC_KEYS` in `src/api/hooks.ts` so the `Record<Topic, …>` compiles: `cooling: [['cooling']],`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run src/api && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/api src/lib
git commit -m "feat(cooling): cooling types and client contract; fan airflow moves GPU temperature

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `CoolingSim` — fans, RPM, the Pico link and history

**Files:**
- Create: `src/api/mock/cooling.ts`
- Test: `src/api/mock/cooling.test.ts`

**Interfaces:**
- Consumes: Task 1 (`zoneTarget`, `stepDuty`, `DEFAULT_POLICY`, `DutyState`, `Thermal`, `FanReason`, `CoolingPolicy`), Task 2 types (`Fan`, `CoolingState`, `CoolingPoint`, `TimeRange`), `seriesTimes` from `./metrics`, `noise` from `./rng`.
- Produces:
  - constants `FAN_MAX_RPM = 1500`, `FAN_MIN_RPM = 300`, `WATCHDOG_MS = 10_000`, `STALL_MS = 5_000`, `PICO_PORT = '/dev/ttyACM0'`, `PICO_FIRMWARE = 'sparkman-fan 0.1.0'`, `DEFAULT_ZONES: Record<string, string[]>`
  - `rpmFor(duty: number): number`
  - `class CoolingSim` with: `constructor(opts: { seed: number })`, fields `connected: boolean` (default true), `stalledFan: string | null` (default null), `policy: CoolingPolicy`; methods `step(now: number, thermal: (nodeId: string) => Thermal): void`, `airflowAt(nodeId: string, t: number): number | null`, `state(now: number): CoolingState`, `series(range: TimeRange, now: number): CoolingPoint[]`, `fanIds(): string[]`, `fan(id: string): { id: string; name: string; nodeIds: string[] } | null`, `setManual(fanId: string, duty: number | null, now: number): void`, `setPolicy(p: CoolingPolicy): void`, `setZones(zones: Record<string, string[]>): void`

- [ ] **Step 1: Write the failing tests** — `src/api/mock/cooling.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { Thermal } from '@/lib/cooling'
import { CoolingSim, FAN_MAX_RPM, STALL_MS, WATCHDOG_MS, rpmFor } from './cooling'

const T0 = new Date(2026, 9, 8, 15, 0, 0).getTime()

function setup(temps: Record<string, Thermal> = {}) {
  const sim = new CoolingSim({ seed: 1729 })
  let t = T0
  const thermal = (id: string): Thermal => (id in temps ? temps[id] : { gpuTempC: 50, gpuUtil: 10 })
  const run = (ms: number) => {
    const end = t + ms
    while (t < end) {
      t += 2000
      sim.step(t, thermal)
    }
  }
  sim.step(t, thermal)
  return { sim, run, now: () => t, temps }
}

const fan = (sim: CoolingSim, id: string, now: number) => sim.state(now).fans.find((f) => f.id === id)!

describe('CoolingSim', () => {
  it('starts with three zoned fans on a connected Pico', () => {
    const { sim, now } = setup()
    const s = sim.state(now())
    expect(s.fans.map((f) => [f.id, f.nodeIds])).toEqual([
      ['fan-1', ['gx10-01', 'spark-01']],
      ['fan-2', ['spark-02', 'spark-03', 'spark-04']],
      ['fan-3', ['dell-01', 'dell-02']],
    ])
    expect(s.controller).toMatchObject({ connected: true, failsafe: false, port: '/dev/ttyACM0', firmware: 'sparkman-fan 0.1.0', watchdogMs: 10_000 })
    expect(s.maxRpm).toBe(FAN_MAX_RPM)
  })

  it('drives each fan from its hottest box and spins up toward the commanded RPM', () => {
    const { sim, run, now } = setup({ spark-04: { gpuTempC: 78, gpuUtil: 60 } })
    run(20_000)
    const f2 = fan(sim, 'fan-2', now())
    expect(f2.reason).toMatchObject({ kind: 'temp', nodeId: 'spark-04' })
    expect(f2.duty).toBeCloseTo(86, 0) // 78 °C sits between 72 °C→65 % and 82 °C→100 %
    expect(f2.rpm).toBeGreaterThan(rpmFor(f2.duty) * 0.95)
    expect(fan(sim, 'fan-1', now()).duty).toBeLessThan(40)
  })

  it('runs safe when a zone box goes silent', () => {
    const { sim, run, now } = setup({ dell-02: null })
    run(4000)
    expect(fan(sim, 'fan-3', now())).toMatchObject({ duty: 100, reason: { kind: 'no-data', nodeId: 'dell-02' } })
  })

  it('holds a manual speed, and returns to the curve', () => {
    const { sim, run, now } = setup()
    sim.setManual('fan-1', 0, now())
    run(20_000)
    expect(fan(sim, 'fan-1', now())).toMatchObject({ mode: 'manual', manualDuty: 0, duty: 0, rpm: 0, stalled: false, reason: { kind: 'manual' } })
    sim.setManual('fan-1', null, now())
    run(2000)
    expect(fan(sim, 'fan-1', now())).toMatchObject({ mode: 'auto', manualDuty: null, reason: { kind: 'temp' } })
  })

  it('holds the last command, then fails safe at 100 %; after reconnect it slows down gradually', () => {
    const { sim, run, now } = setup()
    run(10_000)
    const before = fan(sim, 'fan-1', now()).duty
    sim.connected = false
    run(WATCHDOG_MS - 2000)
    expect(sim.state(now()).controller).toMatchObject({ connected: false, failsafe: false })
    expect(fan(sim, 'fan-1', now()).duty).toBe(before)
    run(4000)
    expect(sim.state(now()).controller.failsafe).toBe(true)
    expect(fan(sim, 'fan-1', now())).toMatchObject({ duty: 100, reason: { kind: 'failsafe' } })
    sim.connected = true
    run(10_000)
    expect(fan(sim, 'fan-1', now()).duty).toBe(100) // holding
    run(30_000)
    const d = fan(sim, 'fan-1', now()).duty
    expect(d).toBeLessThan(100)
    expect(d).toBeGreaterThan(before)
  })

  it('reports a stall after the tach reads zero for 5 s', () => {
    const { sim, run, now } = setup()
    sim.stalledFan = 'fan-2'
    run(2000)
    expect(fan(sim, 'fan-2', now()).stalled).toBe(false)
    run(STALL_MS + 4000)
    expect(fan(sim, 'fan-2', now())).toMatchObject({ rpm: 0, stalled: true })
    sim.stalledFan = null
    run(4000)
    expect(fan(sim, 'fan-2', now()).stalled).toBe(false)
  })

  it('reports airflow per zone box from history, null for uncooled boxes', () => {
    const { sim, run, now } = setup()
    sim.setManual('fan-3', 100, now())
    run(30_000)
    expect(sim.airflowAt('dell-02', now())!).toBeGreaterThan(0.95)
    expect(sim.airflowAt('spark-05', now())).toBeNull()
    expect(sim.airflowAt('dell-02', T0 - 60_000)).toBeNull()
  })

  it('serves a downsampled series with zone temperatures', () => {
    const { sim, run, now } = setup({ spark-01: { gpuTempC: 66, gpuUtil: 30 } })
    run(5 * 60_000)
    const pts = sim.series('15m', now())
    expect(pts.length).toBeGreaterThan(30)
    expect(pts.length).toBeLessThanOrEqual(120)
    expect(pts.at(-1)!.zoneTempC['fan-1']).toBe(66)
    expect(Object.keys(pts.at(-1)!.duty)).toEqual(['fan-1', 'fan-2', 'fan-3'])
  })

  it('moves boxes between zones', () => {
    const { sim, now } = setup()
    sim.setZones({ 'fan-1': ['gx10-01'], 'fan-2': ['spark-01', 'spark-02', 'spark-03', 'spark-04'], 'fan-3': ['dell-01', 'dell-02'] })
    expect(fan(sim, 'fan-2', now()).nodeIds).toContain('spark-01')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/api/mock/cooling.test.ts`
Expected: FAIL — cannot resolve `./cooling`.

- [ ] **Step 3: Implement** — `src/api/mock/cooling.ts`

```ts
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

export const DEFAULT_ZONES: Record<string, string[]> = {
  'fan-1': ['gx10-01', 'spark-01'],
  'fan-2': ['spark-02', 'spark-03', 'spark-04'],
  'fan-3': ['dell-01', 'dell-02'],
}

/** steady-state RPM for a duty; PWM fans keep a minimum spin above 0 % */
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
  private history: CoolingPoint[] = []

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
    const point: CoolingPoint = { t: now, duty: {}, rpm: {}, zoneTempC: {} }
    for (const f of this.fans) {
      const zone = f.nodeIds.map((id) => ({ id, thermal: thermal(id) }))
      if (failsafe) {
        f.state = { duty: 100, heldAt: now, at: now }
        f.reason = { kind: 'failsafe' }
      } else if (!this.connected) {
        // the Pico keeps applying the last command until its watchdog fires
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
    this.history.push(point)
    while (this.history.length && this.history[0].t < now - HISTORY_MS) this.history.shift()
    this.lastStepAt = now
  }

  private measured(f: FanRuntime, now: number): number {
    const jitter = 0.015 * (2 * noise(this.seed, f.id, 'rpm', Math.floor(now / 2000)) - 1)
    return Math.round(f.rpm * (1 + jitter))
  }

  /** latest history point at or before t */
  private pointAt(t: number): CoolingPoint | null {
    let lo = 0
    let hi = this.history.length - 1
    let found: CoolingPoint | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.history[mid].t <= t) {
        found = this.history[mid]
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  }

  airflowAt(nodeId: string, t: number): number | null {
    const f = this.fans.find((x) => x.nodeIds.includes(nodeId))
    if (!f) return null
    const p = this.pointAt(t)
    return p ? (p.rpm[f.id] ?? 0) / FAN_MAX_RPM : null
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
      return p ? [{ ...structuredClone(p), t }] : []
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
```

Note: `series` returns duplicate points when ticks are sparser than the series step (only possible before the 1 h backfill exists); that is acceptable for charts.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/api/mock/cooling.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/mock/cooling.ts src/api/mock/cooling.test.ts
git commit -m "feat(cooling): simulated Pico and fans — RPM lag, watchdog failsafe, stall, history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire cooling into the Simulator, MockClient and hooks

**Files:**
- Modify: `src/api/mock/simulator.ts` (fields, constructor backfill, `tick`, `metricWorld`, `resolveIncident`, `setFailures`, new public methods, `InjectedKind`)
- Modify: `src/api/mock/fixtures.ts` (`ALERT_RULES`)
- Modify: `src/api/mock/mock-client.ts` (replace Task 2 stubs)
- Modify: `src/api/hooks.ts` (query keys, queries, mutations, `TOPIC_KEYS.cooling`)
- Test: `src/api/mock/simulator.test.ts`

**Interfaces:**
- Consumes: Task 3 `CoolingSim`, Task 1 `validatePolicy`.
- Produces:
  - `Simulator.getCooling(): CoolingState`, `getCoolingSeries(range): CoolingPoint[]`, `setFanOverride(fanId, duty | null): void`, `setCoolingPolicy(patch): void`, `setFanZones(zones): void`
  - hooks: `qk.cooling = ['cooling'] as const`, `qk.coolingSeries(range) = ['cooling', 'series', range] as const`, `useCooling()`, `useCoolingSeries(range: TimeRange)`, `useSetFanOverride()` (variables `{ fanId: string; duty: number | null }`), `useSetCoolingPolicy()` (variables `Partial<CoolingPolicy>`), `useSetFanZones()` (variables `Record<string, string[]>`)
  - alert rules `rule-cooling-link`, `rule-fan-stall`

- [ ] **Step 1: Write the failing tests** — append inside `describe('Simulator', …)` in `src/api/mock/simulator.test.ts`

```ts
  describe('cooling', () => {
    it('starts with an hour of fan history and three auto fans', () => {
      const { sim } = setup()
      const c = sim.getCooling()
      expect(c.fans).toHaveLength(3)
      expect(c.fans.every((f) => f.mode === 'auto' && f.duty >= 20 && f.rpm > 0)).toBe(true)
      expect(sim.getCoolingSeries('1h').length).toBeGreaterThan(100)
    })

    it('slow fans let the zone run hotter than full fans', () => {
      const a = setup()
      a.sim.setFanOverride('fan-2', 20)
      a.advance(120_000)
      const b = setup()
      b.sim.setFanOverride('fan-2', 100)
      b.advance(120_000)
      const temp = (s: typeof a) => s.sim.getNode('spark-02')!.live!.gpuTempC
      expect(temp(a) - temp(b)).toBeGreaterThan(3)
      // shelf 2 is not fan-cooled
      expect(a.sim.getNode('spark-06')!.live!.gpuTempC).toBeCloseTo(b.sim.getNode('spark-06')!.live!.gpuTempC, 5)
    })

    it('runs a zone fan safe when one of its boxes goes offline', () => {
      const { sim, advance } = setup()
      sim.setFailures({ nodeOffline: 'spark-03' })
      advance(4000)
      expect(sim.getCooling().fans.find((f) => f.id === 'fan-2')).toMatchObject({ duty: 100, reason: { kind: 'no-data', nodeId: 'spark-03' } })
    })

    it('Pico disconnect opens an incident, fails safe after the watchdog, and resolving the incident reconnects', () => {
      const { sim, advance } = setup()
      sim.setFailures({ picoDisconnected: true })
      const inc = sim.getIncidents().find((i) => i.title === 'Cooling controller offline' && i.status === 'ongoing')!
      expect(inc).toMatchObject({ severity: 'critical', ruleId: 'rule-cooling-link', nodeId: null })
      advance(12_000)
      expect(sim.getCooling().controller).toMatchObject({ connected: false, failsafe: true })
      expect(sim.getCooling().fans.every((f) => f.duty === 100)).toBe(true)
      sim.resolveIncident(inc.id)
      expect(sim.getFailures().picoDisconnected).toBe(false)
      advance(2000)
      expect(sim.getCooling().controller).toMatchObject({ connected: true, failsafe: false })
    })

    it('a stalled fan opens an incident and clears with the failure', () => {
      const { sim, advance } = setup()
      sim.setFailures({ fanStalled: 'fan-3' })
      expect(sim.getIncidents().some((i) => i.title === 'Fan 3 stalled' && i.status === 'ongoing')).toBe(true)
      advance(10_000)
      expect(sim.getCooling().fans.find((f) => f.id === 'fan-3')).toMatchObject({ rpm: 0, stalled: true })
      sim.setFailures({ fanStalled: null })
      expect(sim.getIncidents().some((i) => i.title === 'Fan 3 stalled' && i.status === 'ongoing')).toBe(false)
      expectSimError(() => sim.setFailures({ fanStalled: 'fan-9' }), 'not_found')
    })

    it('validates overrides, policies and zones', () => {
      const { sim } = setup()
      expectSimError(() => sim.setFanOverride('fan-9', 50), 'not_found')
      expectSimError(() => sim.setFanOverride('fan-1', 120), 'invalid')
      expectSimError(() => sim.setCoolingPolicy({ curve: [{ tempC: 50, duty: 30 }, { tempC: 50, duty: 60 }] }), 'invalid')
      expect(sim.getCooling().policy.curve).toHaveLength(4) // unchanged
      expectSimError(() => sim.setFanZones({ 'fan-1': ['spark-05'], 'fan-2': [], 'fan-3': [] }), 'invalid')
      expectSimError(() => sim.setFanZones({ 'fan-1': ['spark-01'], 'fan-2': ['spark-01'], 'fan-3': [] }), 'invalid')
      expectSimError(() => sim.setFanZones({ 'fan-1': [], 'fan-2': [] }), 'invalid')
      sim.setFanZones({ 'fan-1': ['gx10-01', 'spark-01', 'spark-02'], 'fan-2': ['spark-03', 'spark-04'], 'fan-3': ['dell-01', 'dell-02'] })
      expect(sim.getCooling().fans[0].nodeIds).toEqual(['gx10-01', 'spark-01', 'spark-02'])
    })

    it('logs changes and emits cooling events', () => {
      const { sim } = setup()
      const events: SimEvent[] = []
      sim.subscribe((e) => events.push(e))
      sim.setFanOverride('fan-2', 40)
      expect(sim.getActivity(1)[0].text).toBe('Fan 2 pinned to 40%')
      sim.setFanOverride('fan-2', null)
      expect(sim.getActivity(1)[0].text).toBe('Fan 2 back to auto')
      sim.setCoolingPolicy({ minDuty: 25 })
      expect(sim.getActivity(1)[0].text).toBe('Fan curve updated')
      expect(events).toContainEqual({ type: 'changed', topic: 'cooling' })
    })
  })
```

Also extend `src/api/mock/mock-client.test.ts` with:

```ts
it('serves cooling through the client', async () => {
  const sim = new Simulator({ seed: 1729 })
  const client = new MockClient(sim, { latencyMs: 0 })
  await client.setFanOverride('fan-1', 60)
  expect((await client.getCooling()).fans[0]).toMatchObject({ mode: 'manual', duty: 60 })
  await expect(client.setCoolingPolicy({ minDuty: 200 })).rejects.toThrow(/Minimum/)
})
```

(adjust the imports at the top of that file if `Simulator`/`MockClient` are not already imported).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/api/mock/simulator.test.ts src/api/mock/mock-client.test.ts`
Expected: FAIL — `getCooling` is not a function.

- [ ] **Step 3: Implement**

`src/api/mock/fixtures.ts` — append to `ALERT_RULES`:

```ts
  { id: 'rule-cooling-link', name: 'Cooling controller offline', condition: 'no Pico heartbeat for 10 s', severity: 'critical', enabled: true },
  { id: 'rule-fan-stall', name: 'Fan stalled', condition: 'fan rpm ≈ 0 while duty ≥ 20 % for 5 s', severity: 'critical', enabled: true },
```

`src/api/mock/simulator.ts`:

```ts
// imports
import { validatePolicy, type CoolingPolicy, type Thermal } from '@/lib/cooling'
import { CoolingSim } from './cooling'
// add CoolingPoint, CoolingState to the existing '../types' import

type InjectedKind = 'nodeOffline' | 'gatewayErrors' | 'xidStorm' | 'picoDisconnected' | 'fanStalled'
```

Fields:

```ts
  private failures: FailureInjection = { nodeOffline: null, gatewayErrors: false, xidStorm: false, apiErrors: false, picoDisconnected: false, fanStalled: null }
  private injected: Record<InjectedKind, string | null> = { nodeOffline: null, gatewayErrors: null, xidStorm: null, picoDisconnected: null, fanStalled: null }
  private cooling: CoolingSim
```

End of the constructor (after `this.activity = …`):

```ts
    // an hour of fan history, so charts and the temperature model have a past
    this.cooling = new CoolingSim({ seed: this.seed })
    for (let t = now - 3_600_000; t <= now; t += 30_000) this.cooling.step(t, (id) => this.thermalAt(id, t))
```

`tick()` — before `this.emit({ type: 'tick', now })`:

```ts
    this.cooling.step(now, (id) => this.getNode(id)?.live ?? null)
```

`metricWorld()`:

```ts
  private metricWorld(): MetricWorld {
    return { seed: this.seed, outages: this.outages, gatewayErrorWindows: this.gatewayErrorWindows, airflow: (id, t) => this.cooling?.airflowAt(id, t) ?? null }
  }

  /** a box's GPU temperature and load at a past time (backfill) */
  private thermalAt(id: string, t: number): Thermal {
    const p = sampleNode(this.metricWorld(), this.effectiveSpec(this.spec(id)), this.activeDepFor(id), t)
    return p.gpuTempC === null || p.gpuUtil === null ? null : { gpuTempC: p.gpuTempC, gpuUtil: p.gpuUtil }
  }
```

(`this.cooling?.` guards the constructor, where `metricWorld()` may run before `cooling` is assigned.)

`resolveIncident` — replace the failure reset:

```ts
      if (kind === 'nodeOffline' || kind === 'fanStalled') this.failures[kind] = null
      else this.failures[kind] = false
```

`setFailures` — add to the validation block at the top:

```ts
    if (patch.fanStalled && !this.cooling.fan(patch.fanStalled)) throw new SimError('not_found', `Fan ${patch.fanStalled} not found`)
```

and before the `apiErrors` line:

```ts
    if (patch.picoDisconnected !== undefined && patch.picoDisconnected !== this.failures.picoDisconnected) {
      if (patch.picoDisconnected) {
        this.cooling.connected = false
        this.openInjected('picoDisconnected', 'inj-pico', 'Cooling controller offline', 'critical', null, 'rule-cooling-link', 'No heartbeat from the Pico on /dev/ttyACM0', () => {
          this.cooling.connected = true
        })
      } else {
        this.resolveInjected('picoDisconnected')
      }
      this.failures.picoDisconnected = patch.picoDisconnected
    }
    if (patch.fanStalled !== undefined && patch.fanStalled !== this.failures.fanStalled) {
      this.resolveInjected('fanStalled')
      const id = patch.fanStalled
      if (id) {
        const fan = this.cooling.fan(id)!
        this.cooling.stalledFan = id
        this.openInjected('fanStalled', `inj-stall-${id}`, `${fan.name} stalled`, 'critical', null, 'rule-fan-stall', `Tach reads 0 RPM — cooling ${fan.nodeIds.join(', ')}`, () => {
          this.cooling.stalledFan = null
        })
      }
      this.failures.fanStalled = id
    }
```

and change the final line to `this.changed('failures', 'incidents', 'nodes', 'cooling')`.

New public methods (reads section and actions section respectively):

```ts
  getCooling(): CoolingState {
    return this.cooling.state(this.now())
  }

  getCoolingSeries(range: TimeRange): CoolingPoint[] {
    return this.cooling.series(range, this.now())
  }

  setFanOverride(fanId: string, duty: number | null): void {
    const fan = this.cooling.fan(fanId)
    if (!fan) throw new SimError('not_found', `Fan ${fanId} not found`)
    if (duty !== null && !(Number.isFinite(duty) && duty >= 0 && duty <= 100)) throw new SimError('invalid', 'Fan speed must be 0–100 %')
    this.cooling.setManual(fanId, duty === null ? null : Math.round(duty), this.now())
    this.log('system', duty === null ? `${fan.name} back to auto` : `${fan.name} pinned to ${Math.round(duty)}%`, null)
    this.changed('cooling')
  }

  setCoolingPolicy(patch: Partial<CoolingPolicy>): void {
    const next: CoolingPolicy = { ...this.cooling.policy, ...structuredClone(patch) }
    const err = validatePolicy(next)
    if (err) throw new SimError('invalid', err)
    this.cooling.setPolicy(next)
    this.log('system', 'Fan curve updated', null)
    this.changed('cooling')
  }

  setFanZones(zones: Record<string, string[]>): void {
    const ids = this.cooling.fanIds()
    if (ids.some((id) => !Array.isArray(zones[id])) || Object.keys(zones).some((k) => !ids.includes(k))) throw new SimError('invalid', 'Give every fan a zone')
    const seen = new Set<string>()
    for (const nodeId of Object.values(zones).flat()) {
      if (NODE_SPECS.find((n) => n.id === nodeId)?.rack.shelf !== 1) throw new SimError('invalid', `${nodeId} isn’t on the fan shelf`)
      if (seen.has(nodeId)) throw new SimError('invalid', `${nodeId} is in two zones`)
      seen.add(nodeId)
    }
    this.cooling.setZones(zones)
    this.log('system', 'Fan zones updated', null)
    this.changed('cooling')
  }
```

`src/api/mock/mock-client.ts` — replace the Task 2 stubs:

```ts
  getCooling() { return this.run(() => this.sim.getCooling()) }
  getCoolingSeries(range: TimeRange) { return this.run(() => this.sim.getCoolingSeries(range)) }
  setFanOverride(fanId: string, duty: number | null) { return this.run(() => this.sim.setFanOverride(fanId, duty)) }
  setCoolingPolicy(patch: Partial<CoolingPolicy>) { return this.run(() => this.sim.setCoolingPolicy(patch)) }
  setFanZones(zones: Record<string, string[]>) { return this.run(() => this.sim.setFanZones(zones)) }
```

(import `CoolingPolicy` from `../types`.)

`src/api/hooks.ts`:

```ts
// qk
  cooling: ['cooling'] as const,
  coolingSeries: (range: TimeRange) => ['cooling', 'series', range] as const,

// TOPIC_KEYS — replace the Task 2 placeholder
  cooling: [['cooling'], ['activity']],

// queries
export function useCooling() {
  const c = useClient()
  return useQuery({ queryKey: qk.cooling, queryFn: () => c.getCooling(), meta: LIVE })
}
export function useCoolingSeries(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.coolingSeries(range), queryFn: () => c.getCoolingSeries(range), meta: LIVE, placeholderData: keepPreviousData })
}

// mutations (next to useSetFailures)
export const useSetFanOverride = () =>
  useAction((c, v: { fanId: string; duty: number | null }) => c.setFanOverride(v.fanId, v.duty), (_, v) => (v.duty === null ? 'Back to auto' : null))
export const useSetCoolingPolicy = () => useAction((c, v: Partial<CoolingPolicy>) => c.setCoolingPolicy(v), () => 'Fan curve saved')
export const useSetFanZones = () => useAction((c, v: Record<string, string[]>) => c.setFanZones(v), () => 'Zones saved')
```

Also add `qk.cooling` to `TOPIC_KEYS.nodes` (zone temps change when nodes change): `nodes: [qk.nodes, qk.fleet, qk.updates, qk.deployments, ['gateway'], ['cooling']],`.

- [ ] **Step 4: Run the whole unit suite**

Run: `pnpm test`
Expected: PASS. If an older simulator test now fails because shelf-1 temperatures moved by a few °C (airflow), check the assertion: if it pins a specific shelf-1 temperature value, loosen it to the behaviour it was testing; do not change the airflow model. If the alert-rule count is asserted anywhere, bump it by 2.

- [ ] **Step 5: Commit**

```bash
git add src/api
git commit -m "feat(cooling): simulator runs the fans each tick; Pico/stall failures, rules, hooks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Route, nav, status line, fan cards and controller card

**Files:**
- Create: `src/routes/cooling.tsx`, `src/features/cooling/cooling-page.tsx`, `src/features/cooling/fan-card.tsx`, `src/features/cooling/controller-card.tsx`, `e2e/cooling.spec.ts`
- Modify: `src/lib/nav.ts`, `src/features/status/page-status.ts`, `e2e/all-routes.spec.ts`, `e2e/shell.spec.ts`, `e2e/mobile.spec.ts`

**Interfaces:**
- Consumes: Task 4 hooks, Task 1 `reasonText`.
- Produces: `CoolingPage`, `FanCard({ fan, maxRpm })`, `ControllerCard({ controller, now, onEditZones })`, `useCoolingStatus(): StatusItem[] | null`; testids `fan-card` (with `data-fan={id}`), `fan-duty`, `fan-rpm`, `fan-reason`, `fan-auto`, `controller-card`, `controller-state`.

- [ ] **Step 1: Write the failing e2e** — `e2e/cooling.spec.ts`

```ts
import { expect, test } from './fixtures.ts'

test('cooling shows three fans with live status', async ({ page }) => {
  await page.goto('/cooling')
  await expect(page.getByRole('heading', { level: 1, name: 'Cooling' })).toBeVisible()
  await expect(page.getByTestId('fan-card')).toHaveCount(3)
  await expect(page.getByTestId('status-line')).toContainText('Pico connected')
  await expect(page.getByTestId('controller-card')).toContainText('/dev/ttyACM0')
})

test('pin a fan by hand, then hand it back to the curve', async ({ page }) => {
  await page.goto('/cooling')
  const card = page.locator('[data-testid=fan-card][data-fan=fan-2]')
  const thumb = card.getByRole('slider', { name: 'Fan 2 speed' })
  await thumb.focus()
  await page.keyboard.press('End') // 100 %
  await expect(card.getByTestId('fan-reason')).toHaveText('Manual')
  await expect(card.getByTestId('fan-duty')).toHaveText('100%')
  await expect(page.getByTestId('status-line')).toContainText('1 manual')
  await card.getByTestId('fan-auto').click()
  await expect(card.getByTestId('fan-reason')).not.toHaveText('Manual')
})
```

Add `['/cooling', 'Cooling']` to `ROUTES` in `e2e/all-routes.spec.ts`, `['Cooling', 'Cooling']` to the list in `e2e/shell.spec.ts`, and `'/cooling'` to `PAGES` in `e2e/mobile.spec.ts`.

- [ ] **Step 2: Implement**

`src/lib/nav.ts` — add `'/cooling'` to `NavPath`, import `Fan` from `lucide-react`, and make Fleet `[{ to: '/', label: 'Overview', icon: House }, { to: '/nodes', label: 'Nodes', icon: Server }, { to: '/cooling', label: 'Cooling', icon: Fan }]`.

`src/routes/cooling.tsx`:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { CoolingPage } from '@/features/cooling/cooling-page'

export const Route = createFileRoute('/cooling')({ component: CoolingPage })
```

`src/features/status/page-status.ts` — add `useCooling` to the hooks import and `reasonText` from `@/lib/cooling`:

```ts
export function useCoolingStatus(): StatusItem[] | null {
  const cooling = useCooling()
  if (!cooling.data) return null
  const { controller, fans } = cooling.data
  const avg = Math.round(fans.reduce((s, f) => s + f.duty, 0) / Math.max(1, fans.length))
  const driver = fans.filter((f) => f.reason.kind === 'temp' || f.reason.kind === 'load' || f.reason.kind === 'no-data').sort((a, b) => b.duty - a.duty)[0]
  const manual = fans.filter((f) => f.mode === 'manual').length
  return [
    { text: `${plural(fans.length, 'fan')} · avg ${avg}%` },
    ...(driver ? [{ text: driver.reason.kind === 'temp' ? `Driven by ${reasonText(driver.reason)}` : reasonText(driver.reason), tone: driver.reason.kind === 'no-data' ? ('warn' as const) : undefined }] : []),
    controller.failsafe
      ? { text: 'Pico offline — failsafe 100%', tone: 'error' }
      : controller.connected
        ? { text: 'Pico connected', tone: 'ok' }
        : { text: 'Pico not answering', tone: 'warn' },
    ...fans.filter((f) => f.stalled).map((f) => ({ text: `${f.name} stalled`, tone: 'error' as const })),
    ...(manual ? [{ text: `${manual} manual`, tone: 'info' as const }] : []),
  ]
}
```

`src/features/cooling/fan-card.tsx`:

```tsx
import { Hand } from 'lucide-react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { useEffect, useState, type ReactNode } from 'react'
import { useSetFanOverride } from '@/api/hooks'
import type { Fan } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { reasonText } from '@/lib/cooling'
import { cn } from '@/lib/utils'

export function FanCard({ fan, maxRpm, children }: { fan: Fan; maxRpm: number; children?: ReactNode }) {
  const setOverride = useSetFanOverride()
  // the slider shows the commanded duty; while dragging it shows the drag value
  const [drag, setDrag] = useState<number | null>(null)
  useEffect(() => setDrag(null), [fan.manualDuty])
  const value = drag ?? fan.manualDuty ?? fan.duty
  return (
    <Card className={cn('gap-3 py-4', fan.stalled && 'border-level-error/50')} data-testid="fan-card" data-fan={fan.id}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {fan.name}
          {fan.mode === 'manual' && (
            <Badge variant="outline" className="gap-1 border-level-info/40 text-level-info">
              <Hand className="size-3" /> Manual
            </Badge>
          )}
          {fan.stalled && <Badge variant="destructive">Stalled</Badge>}
        </CardTitle>
        <span className="font-mono text-xs text-muted-foreground">{fan.nodeIds.join(' · ') || 'no boxes'}</span>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-3xl font-semibold tabular-nums" data-testid="fan-duty">{fan.duty}%</span>
          <span className="font-mono text-sm tabular-nums text-muted-foreground" data-testid="fan-rpm">
            {fan.rpm.toLocaleString()} <span className="text-xs">/ {maxRpm.toLocaleString()} rpm</span>
          </span>
        </div>
        <p className="truncate text-sm text-muted-foreground" data-testid="fan-reason">{reasonText(fan.reason)}</p>
        {children}
        <div className="flex items-center gap-3">
          <SliderPrimitive.Root
            min={0}
            max={100}
            step={5}
            value={[value]}
            onValueChange={([v]) => setDrag(v)}
            onValueCommit={([v]) => setOverride.mutate({ fanId: fan.id, duty: v })}
            className="relative flex h-6 flex-1 touch-none items-center select-none"
          >
            <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
              <SliderPrimitive.Range className="absolute h-full bg-brand" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
              aria-label={`${fan.name} speed`}
              className="block size-4 rounded-full border-2 border-brand bg-background shadow-sm outline-none transition-transform duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95"
            />
          </SliderPrimitive.Root>
          <Button size="sm" variant="outline" disabled={fan.mode === 'auto'} onClick={() => setOverride.mutate({ fanId: fan.id, duty: null })} data-testid="fan-auto">
            Back to auto
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
```

`src/features/cooling/controller-card.tsx`:

```tsx
import { Cpu, PencilLine } from 'lucide-react'
import type { CoolingController } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

export function ControllerCard({ controller, now, onEditZones }: { controller: CoolingController; now: number; onEditZones: () => void }) {
  const state = controller.failsafe ? 'Failsafe — all fans 100%' : controller.connected ? 'Connected' : 'Not answering'
  const tone = controller.failsafe ? 'bg-level-error' : controller.connected ? 'bg-brand' : 'bg-level-warn motion-safe:animate-pulse'
  const rows: [string, string][] = [
    ['Port', controller.port],
    ['Firmware', controller.firmware],
    ['Last heartbeat', controller.lastHeartbeatAt ? formatRelative(controller.lastHeartbeatAt, now) : '—'],
    ['Watchdog', `${formatDuration(controller.watchdogMs)} → 100%`],
  ]
  return (
    <Card className="gap-3 py-4" data-testid="controller-card">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Cpu className="size-4 text-muted-foreground" /> Raspberry Pi Pico
        </CardTitle>
        <span className="inline-flex items-center gap-1.5 text-xs" data-testid="controller-state">
          <span className={cn('size-1.5 rounded-full', tone)} aria-hidden />
          {state}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-mono text-xs leading-5">{v}</dd>
            </div>
          ))}
        </dl>
        <Button size="sm" variant="outline" className="w-full" onClick={onEditZones}>
          <PencilLine /> Edit zones
        </Button>
      </CardContent>
    </Card>
  )
}
```

`src/features/cooling/cooling-page.tsx` (hero, curve, history and zones slot in during Tasks 6–8; keep the marked spots):

```tsx
import { useState } from 'react'
import { useCooling } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { StatusLine } from '@/components/status-line'
import { Skeleton } from '@/components/ui/skeleton'
import { useCoolingStatus } from '@/features/status/page-status'
import { ControllerCard } from './controller-card'
import { FanCard } from './fan-card'

export function CoolingPage() {
  const status = useCoolingStatus()
  const cooling = useCooling()
  const [zonesOpen, setZonesOpen] = useState(false)
  const now = Date.now()
  return (
    <>
      <PageHeader crumbs={[{ label: 'Fleet', to: '/' }, { label: 'Cooling' }]} title="Cooling" description={<StatusLine items={status} />} />
      <PageBody>
        <QueryState query={cooling} skeleton={<Skeleton className="h-64 w-full" />}>
          {(c) => (
            <>
              {/* Task 6: <ShelfHero …/> */}
              <div className="grid gap-4 md:grid-cols-3">
                {c.fans.map((f) => (
                  <FanCard key={f.id} fan={f} maxRpm={c.maxRpm} />
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
                {/* Task 7: <CurveEditor …/> */}
                <ControllerCard controller={c.controller} now={now} onEditZones={() => setZonesOpen(true)} />
              </div>
              {/* Task 8: <CoolingHistory/> and <ZonesDialog open={zonesOpen} …/> */}
            </>
          )}
        </QueryState>
      </PageBody>
    </>
  )
}
```

(`zonesOpen` is read by Task 8; until then reference it in the JSX as `data-zones-open={zonesOpen}` on the outer grid if the linter flags it as unused.)

- [ ] **Step 3: Run checks and the new e2e**

Run: `pnpm typecheck && pnpm lint && pnpm test && CI=1 pnpm exec playwright test e2e/cooling.spec.ts e2e/all-routes.spec.ts e2e/shell.spec.ts e2e/mobile.spec.ts`
Expected: PASS. (`pnpm e2e` builds first; if running playwright directly needs a fresh build, use `CI=1 pnpm e2e -- e2e/cooling.spec.ts …`.)

- [ ] **Step 4: Commit**

```bash
git add src e2e
git commit -m "feat(cooling): Cooling page — fan cards with manual override, Pico card, live status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Shelf hero — faceplates, spinning fans, zones and temperatures

**Files:**
- Create: `src/features/cooling/fan-blade.tsx`, `src/features/cooling/shelf-hero.tsx`
- Modify: `src/features/cooling/cooling-page.tsx`, `src/index.css` (one keyframe)
- Test: `e2e/cooling.spec.ts`

**Interfaces:**
- Consumes: `useNodes()`, `CoolingState`, `Faceplate`, `curveDuty`.
- Produces: `FanBlade({ rpm, maxRpm, stalled, className })`, `ShelfHero({ cooling, nodes })`; testids `shelf-hero`, `hero-fan` (`data-fan`, `data-spinning`), `hero-box` (`data-node`), `hero-temp`.

- [ ] **Step 1: Write the failing e2e** — append to `e2e/cooling.spec.ts`

```ts
test('the shelf shows every top-shelf box under its fan', async ({ page }) => {
  await page.goto('/cooling')
  const hero = page.getByTestId('shelf-hero')
  await expect(hero.getByTestId('hero-box')).toHaveCount(7)
  await expect(hero.getByTestId('hero-fan')).toHaveCount(3)
  await expect(hero.locator('[data-testid=hero-box][data-node=spark-02] [data-testid=hero-temp]')).toHaveText(/\d+ °C/)
  await expect(hero.locator('[data-testid=hero-fan][data-fan=fan-2]')).toHaveAttribute('data-spinning', 'true')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `CI=1 pnpm e2e -- e2e/cooling.spec.ts`
Expected: FAIL — no `shelf-hero`.

- [ ] **Step 3: Implement**

`src/index.css` — next to the other keyframes:

```css
@keyframes fan-spin {
  to { transform: rotate(360deg); }
}
```

`src/features/cooling/fan-blade.tsx`:

```tsx
import { useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'

/** A 140 mm fan seen from the front. Spins at a speed proportional to RPM (not literally — 1500 rpm would blur). */
export function FanBlade({ rpm, maxRpm, stalled, className }: { rpm: number; maxRpm: number; stalled: boolean; className?: string }) {
  const reduce = useReducedMotion()
  const spinning = !reduce && rpm > 0
  // full speed ≈ one turn every 0.35 s; minimum spin ≈ one every 1.8 s
  const period = rpm > 0 ? Math.min(1.8, 0.35 * (maxRpm / rpm)) : 0
  return (
    <svg viewBox="-50 -50 100 100" className={cn('text-foreground/70', stalled && 'text-level-error', className)} aria-hidden>
      <rect x={-48} y={-48} width={96} height={96} rx={10} className="fill-surface-2 stroke-border" strokeWidth={2} />
      {[[-38, -38], [38, -38], [-38, 38], [38, 38]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={3} className="fill-background stroke-border" />
      ))}
      <circle r={44} className="fill-background/60 stroke-border" strokeWidth={1.5} />
      <g style={spinning ? { animation: `fan-spin ${period}s linear infinite`, transformOrigin: 'center', transformBox: 'fill-box' } : undefined}>
        <g>
          {Array.from({ length: 7 }, (_, i) => (
            <path key={i} d="M0 -12 C 14 -20, 30 -26, 38 -14 C 30 -10, 16 -6, 6 -2 Z" transform={`rotate(${(360 / 7) * i})`} className="fill-current" opacity={0.85} />
          ))}
          <circle r={12} className="fill-surface-2 stroke-current" strokeWidth={1.5} />
        </g>
      </g>
    </svg>
  )
}
```

(If the spin wobbles because `transformBox: fill-box` centres on the blades' bounding box, wrap the blades in a `<g>` that includes an invisible `<circle r={44} fill="none" />` so the box is symmetric — that is why the inner `<g>` exists; put the invisible circle inside it.)

`src/features/cooling/shelf-hero.tsx`:

```tsx
import type { CoolingState, FleetNode } from '@/api/types'
import { Faceplate } from '@/components/faceplate'
import { curveDuty } from '@/lib/cooling'
import { formatTemp } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FanBlade } from './fan-blade'

/** temperature chip colour from where the reading sits on the fan curve */
function heat(node: FleetNode, curve: CoolingState['policy']['curve']): string {
  if (!node.live) return 'bg-muted text-muted-foreground'
  const d = curveDuty(curve, node.live.gpuTempC)
  if (d >= 85) return 'bg-level-error/15 text-level-error'
  if (d >= 55) return 'bg-level-warn/15 text-level-warn'
  return 'bg-brand/15 text-brand'
}

export function ShelfHero({ cooling, nodes }: { cooling: CoolingState; nodes: FleetNode[] }) {
  const shelf = nodes.filter((n) => n.rack.shelf === 1).sort((a, b) => a.rack.slot - b.rack.slot)
  const slots = shelf.length
  return (
    <div className="overflow-hidden rounded-xl border bg-card p-3 md:p-5" data-testid="shelf-hero">
      <div className="mx-auto grid max-w-3xl gap-1.5 md:gap-2.5" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}>
        {/* zone brackets */}
        {cooling.fans.map((f) => {
          const cols = f.nodeIds.map((id) => shelf.findIndex((n) => n.id === id)).filter((i) => i >= 0)
          if (!cols.length) return null
          return (
            <div
              key={f.id}
              className="row-start-1 flex items-end justify-center border-x-2 border-t-2 border-brand/40 pb-0.5 text-[10px] font-medium text-muted-foreground md:text-xs"
              style={{ gridColumn: `${Math.min(...cols) + 1} / ${Math.max(...cols) + 2}` }}
            >
              {f.name}
            </div>
          )
        })}
        {/* boxes */}
        {shelf.map((n) => (
          <div key={n.id} className="row-start-2 flex flex-col items-center gap-1" data-testid="hero-box" data-node={n.id}>
            <Faceplate model={n.model} className={cn('w-full', !n.live && 'opacity-40 grayscale')} />
            <span className="w-full truncate text-center font-mono text-[9px] text-muted-foreground md:text-[11px]">{n.id}</span>
            <span className={cn('rounded px-1 font-mono text-[9px] tabular-nums md:text-xs', heat(n, cooling.policy.curve))} data-testid="hero-temp">
              {n.live ? formatTemp(n.live.gpuTempC) : 'no data'}
            </span>
          </div>
        ))}
        {/* fans, centred under their zone */}
        {cooling.fans.map((f) => {
          const cols = f.nodeIds.map((id) => shelf.findIndex((n) => n.id === id)).filter((i) => i >= 0)
          if (!cols.length) return null
          return (
            <div
              key={f.id}
              className="row-start-3 flex flex-col items-center gap-1 pt-2"
              style={{ gridColumn: `${Math.min(...cols) + 1} / ${Math.max(...cols) + 2}` }}
              data-testid="hero-fan"
              data-fan={f.id}
              data-spinning={f.rpm > 0 ? 'true' : 'false'}
            >
              <FanBlade rpm={f.rpm} maxRpm={cooling.maxRpm} stalled={f.stalled} className="size-16 md:size-24" />
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground md:text-xs">
                {f.duty}% · {f.rpm.toLocaleString()} rpm
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

In `cooling-page.tsx`, add `useNodes` to the hooks import, `const nodes = useNodes()`, and replace the Task 6 marker with:

```tsx
              {nodes.data ? <ShelfHero cooling={c} nodes={nodes.data} /> : <Skeleton className="h-64 w-full" />}
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm lint && CI=1 pnpm e2e -- e2e/cooling.spec.ts e2e/mobile.spec.ts`
Expected: PASS. Then look at it: `pnpm dev`, open `http://localhost:5173/cooling` at desktop width and at 390 px, in light and dark. Blades must spin smoothly around their centre, brackets must line up over their boxes, nothing scrolls sideways.

- [ ] **Step 5: Commit**

```bash
git add src e2e
git commit -m "feat(cooling): shelf hero — real faceplates, zone brackets, spinning fans by RPM

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Curve editor

**Files:**
- Create: `src/features/cooling/curve-editor.tsx`, `src/features/cooling/curve-geometry.ts`, `src/features/cooling/curve-geometry.test.ts`
- Modify: `src/features/cooling/cooling-page.tsx`
- Test: `e2e/cooling.spec.ts`

**Interfaces:**
- Consumes: `CoolingPolicy`, `CurvePoint`, `validatePolicy`, `DEFAULT_POLICY`, `CURVE_TEMP_MIN/MAX`, `useSetCoolingPolicy`.
- Produces: `CurveEditor({ policy, nodes })`; geometry helpers `toPx(p: CurvePoint, box: Box): { x: number; y: number }`, `fromPx(x: number, y: number, box: Box): CurvePoint` (rounded to whole °C / %), `type Box = { w: number; h: number; pad: number }`; testids `curve-editor`, `curve-point` (`data-index`), `curve-save`, `curve-reset`, `curve-error`, `curve-node-dot`.

- [ ] **Step 1: Write the failing unit test** — `src/features/cooling/curve-geometry.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { fromPx, toPx } from './curve-geometry'

const box = { w: 600, h: 300, pad: 30 }

describe('curve geometry', () => {
  it('round-trips points through pixels', () => {
    for (const p of [{ tempC: 30, duty: 0 }, { tempC: 95, duty: 100 }, { tempC: 60, duty: 40 }]) {
      const { x, y } = toPx(p, box)
      expect(fromPx(x, y, box)).toEqual(p)
    }
  })
  it('clamps to the chart and rounds', () => {
    expect(fromPx(-50, 999, box)).toEqual({ tempC: 30, duty: 0 })
    expect(fromPx(10_000, -10, box)).toEqual({ tempC: 95, duty: 100 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/features/cooling/curve-geometry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement geometry** — `src/features/cooling/curve-geometry.ts`

```ts
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
```

Run: `pnpm vitest run src/features/cooling/curve-geometry.test.ts` → PASS.

- [ ] **Step 4: Write the failing e2e** — append to `e2e/cooling.spec.ts`

```ts
test('drag a curve point, save, and the fans follow the new curve', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  const point = editor.locator('[data-testid=curve-point][data-index="1"]')
  await point.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowUp') // 40 % → 50 %
  await expect(point).toHaveAttribute('aria-valuetext', '60 °C, 50%')
  await editor.getByTestId('curve-save').click()
  await expect(page.getByText('Fan curve saved')).toBeVisible()
  // the saved policy comes back from the simulator: same point, nothing left to save
  await expect(point).toHaveAttribute('aria-valuetext', '60 °C, 50%')
  await expect(editor.getByTestId('curve-save')).toBeDisabled()
})

test('a curve that slows down when hotter cannot be saved', async ({ page }) => {
  await page.goto('/cooling')
  const editor = page.getByTestId('curve-editor')
  const point = editor.locator('[data-testid=curve-point][data-index="1"]')
  await point.focus()
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown') // 40 % → 20 %, below point 0 (25 %)
  await expect(editor.getByTestId('curve-error')).toHaveText('A hotter point can’t run the fans slower')
  await expect(editor.getByTestId('curve-save')).toBeDisabled()
  await editor.getByTestId('curve-reset').click()
  await expect(editor.getByTestId('curve-error')).toHaveCount(0)
})
```

- [ ] **Step 5: Implement the editor** — `src/features/cooling/curve-editor.tsx`

```tsx
import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useSetCoolingPolicy } from '@/api/hooks'
import type { CoolingPolicy, CurvePoint, FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CURVE_TEMP_MAX, CURVE_TEMP_MIN, DEFAULT_POLICY, curveDuty, validatePolicy } from '@/lib/cooling'
import { fromPx, toPx, type Box } from './curve-geometry'

const BOX: Box = { w: 600, h: 260, pad: 32 }
const TEMP_TICKS = [30, 45, 60, 75, 90]
const DUTY_TICKS = [0, 25, 50, 75, 100]
const same = (a: CoolingPolicy, b: CoolingPolicy) => JSON.stringify(a) === JSON.stringify(b)

export function CurveEditor({ policy, nodes }: { policy: CoolingPolicy; nodes: FleetNode[] }) {
  const save = useSetCoolingPolicy()
  const [draft, setDraft] = useState(policy)
  const [dragging, setDragging] = useState<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  // adopt the saved policy whenever it changes and nothing is being edited
  const dirty = !same(draft, policy)
  useEffect(() => {
    if (!dirty) setDraft(policy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy])
  const error = validatePolicy(draft)

  const move = (i: number, p: CurvePoint) => setDraft((d) => ({ ...d, curve: d.curve.map((q, j) => (j === i ? p : q)) }))

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (dragging === null || !svg.current) return
    const r = svg.current.getBoundingClientRect()
    move(dragging, fromPx(((e.clientX - r.left) / r.width) * BOX.w, ((e.clientY - r.top) / r.height) * BOX.h, BOX))
  }
  const onKey = (i: number) => (e: KeyboardEvent) => {
    const p = draft.curve[i]
    const step = e.shiftKey ? 5 : 1
    const next = { ArrowUp: { ...p, duty: p.duty + step }, ArrowDown: { ...p, duty: p.duty - step }, ArrowRight: { ...p, tempC: p.tempC + step }, ArrowLeft: { ...p, tempC: p.tempC - step } }[e.key]
    if (!next) return
    e.preventDefault()
    move(i, { tempC: Math.min(CURVE_TEMP_MAX, Math.max(CURVE_TEMP_MIN, next.tempC)), duty: Math.min(100, Math.max(0, next.duty)) })
  }

  const path = draft.curve.map((p, i) => `${i ? 'L' : 'M'}${toPx(p, BOX).x},${toPx(p, BOX).y}`).join(' ')
  const ends = `M${BOX.pad},${toPx(draft.curve[0], BOX).y} L${toPx(draft.curve[0], BOX).x},${toPx(draft.curve[0], BOX).y} M${toPx(draft.curve.at(-1)!, BOX).x},${toPx(draft.curve.at(-1)!, BOX).y} L${BOX.w - BOX.pad},${toPx(draft.curve.at(-1)!, BOX).y}`
  const shelf = nodes.filter((n) => n.rack.shelf === 1 && n.live)

  return (
    <Card className="gap-3 py-4" data-testid="curve-editor">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-sm font-medium">Fan curve</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(structuredClone(DEFAULT_POLICY))} data-testid="curve-reset">
            <RotateCcw /> Default
          </Button>
          <Button size="sm" disabled={!dirty || error !== null || save.isPending} onClick={() => save.mutate(draft)} data-testid="curve-save">
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <svg
          ref={svg}
          viewBox={`0 0 ${BOX.w} ${BOX.h}`}
          className="w-full touch-none select-none"
          onPointerMove={onPointerMove}
          onPointerUp={() => setDragging(null)}
          onPointerLeave={() => setDragging(null)}
          role="group"
          aria-label="Fan speed by GPU temperature"
        >
          {DUTY_TICKS.map((d) => {
            const y = toPx({ tempC: CURVE_TEMP_MIN, duty: d }, BOX).y
            return (
              <g key={d}>
                <line x1={BOX.pad} x2={BOX.w - BOX.pad} y1={y} y2={y} className="stroke-border" strokeDasharray="3 3" />
                <text x={BOX.pad - 6} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">{d}%</text>
              </g>
            )
          })}
          {TEMP_TICKS.map((t) => (
            <text key={t} x={toPx({ tempC: t, duty: 0 }, BOX).x} y={BOX.h - 10} textAnchor="middle" className="fill-muted-foreground text-[11px]">{t} °C</text>
          ))}
          <path d={ends} className="stroke-brand/40" strokeWidth={2} strokeDasharray="4 4" fill="none" />
          <path d={path} className="stroke-brand" strokeWidth={2.5} fill="none" />
          {shelf.map((n) => {
            const { x, y } = toPx({ tempC: Math.min(CURVE_TEMP_MAX, Math.max(CURVE_TEMP_MIN, n.live!.gpuTempC)), duty: curveDuty(draft.curve, n.live!.gpuTempC) }, BOX)
            return (
              <g key={n.id} data-testid="curve-node-dot">
                <circle cx={x} cy={y} r={4} className="fill-foreground/70" />
                <title>{`${n.id} ${Math.round(n.live!.gpuTempC)} °C`}</title>
              </g>
            )
          })}
          {draft.curve.map((p, i) => {
            const { x, y } = toPx(p, BOX)
            return (
              <g key={i}>
                {/* big invisible hit target for touch */}
                <circle cx={x} cy={y} r={18} fill="transparent" onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); setDragging(i) }} className="cursor-grab" />
                <circle
                  cx={x}
                  cy={y}
                  r={dragging === i ? 8 : 6.5}
                  className="fill-background stroke-brand outline-none focus-visible:stroke-[4]"
                  strokeWidth={2.5}
                  tabIndex={0}
                  role="slider"
                  aria-label={`Curve point ${i + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={p.duty}
                  aria-valuetext={`${p.tempC} °C, ${p.duty}%`}
                  onKeyDown={onKey(i)}
                  onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); setDragging(i) }}
                  data-testid="curve-point"
                  data-index={i}
                />
              </g>
            )
          })}
        </svg>
        {error && (
          <p className="text-sm text-level-error" data-testid="curve-error">{error}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField id="lf-util" label="Load floor at" suffix="% GPU" value={draft.loadFloor.util} onChange={(v) => setDraft((d) => ({ ...d, loadFloor: { ...d.loadFloor, util: v } }))} />
          <NumberField id="lf-duty" label="…runs at least" suffix="%" value={draft.loadFloor.duty} onChange={(v) => setDraft((d) => ({ ...d, loadFloor: { ...d.loadFloor, duty: v } }))} />
          <NumberField id="min-duty" label="Never below" suffix="%" value={draft.minDuty} onChange={(v) => setDraft((d) => ({ ...d, minDuty: v }))} />
        </div>
      </CardContent>
    </Card>
  )
}

function NumberField({ id, label, suffix, value, onChange }: { id: string; label: string; suffix: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8 w-20 font-mono" />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </div>
    </div>
  )
}
```

Notes for the implementer:
- Only the visible circle has `role="slider"` and `tabIndex`; the transparent one is only a touch target.
- The project lints with oxlint; if it doesn't know `react-hooks/exhaustive-deps`, delete that disable comment.
- The two `onPointerDown` handlers are identical; extract `const grab = (i: number) => (e: PointerEvent<SVGCircleElement>) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(i) }` and use it on both.

In `cooling-page.tsx`, replace the Task 7 marker with `{nodes.data && <CurveEditor policy={c.policy} nodes={nodes.data} />}`.

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test && CI=1 pnpm e2e -- e2e/cooling.spec.ts e2e/mobile.spec.ts`
Expected: PASS. Then by hand in `pnpm dev`: drag a point with the mouse and with touch emulation, check the dashed end segments, live box dots, the error message, light and dark.

- [ ] **Step 7: Commit**

```bash
git add src e2e
git commit -m "feat(cooling): drag-to-edit fan curve with live box dots, load floor and minimum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: History, zones dialog, Simulator controls, docs and screenshots

**Files:**
- Create: `src/features/cooling/cooling-history.tsx`, `src/features/cooling/zones-dialog.tsx`
- Modify: `src/features/cooling/cooling-page.tsx`, `src/features/cooling/fan-card.tsx` (sparkline), `src/features/settings/settings-page.tsx` (Simulator group), `e2e/cooling.spec.ts`, `e2e/screenshots.spec.ts`, `README.md`
- Regenerate: `docs/screenshots/cooling-{dark,light}.png`

**Interfaces:**
- Consumes: `useCoolingSeries`, `useSetFanZones`, `useFailures`, `useSetFailures`, `TimeRangeToggle`, `ChartContainer`.
- Produces: `CoolingHistory({ fans })`, `ZonesDialog({ open, onOpenChange, fans, nodes })`; testids `cooling-history`, `zones-dialog`, `zone-save`; Settings controls labelled **Disconnect the Pico** (switch, id `sim-pico`) and **Stall a fan** (select, id `sim-stall`).

- [ ] **Step 1: Write the failing e2e** — append to `e2e/cooling.spec.ts`

```ts
test('unplugging the Pico fails safe and raises an alert', async ({ page }) => {
  await page.goto('/settings?section=simulator')
  await page.getByRole('switch', { name: 'Disconnect the Pico' }).click()
  // client-side navigation keeps the in-memory simulator
  await page.getByRole('link', { name: 'Cooling', exact: true }).click()
  // the Pico holds the last speeds until its 10 s watchdog fires
  await expect(page.getByTestId('controller-state')).toHaveText('Failsafe — all fans 100%', { timeout: 15_000 })
  await expect(page.getByTestId('status-line')).toContainText('Pico offline — failsafe 100%')
  await expect(page.locator('[data-testid=fan-card] [data-testid=fan-duty]')).toHaveText(['100%', '100%', '100%'])
  await expect(page.getByTestId('alert-count')).toHaveText('2')
})

test('move a box to another fan', async ({ page }) => {
  await page.goto('/cooling')
  await page.getByRole('button', { name: 'Edit zones' }).click()
  const dialog = page.getByTestId('zones-dialog')
  await dialog.getByRole('radio', { name: 'spark-01 on Fan 2' }).click()
  await dialog.getByTestId('zone-save').click()
  await expect(page.locator('[data-testid=fan-card][data-fan=fan-2]')).toContainText('spark-01')
})

test('history chart renders', async ({ page }) => {
  await page.goto('/cooling')
  // three fan lines and the hottest-box temperature
  await expect(page.getByTestId('cooling-history').locator('.recharts-line')).toHaveCount(4)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `CI=1 pnpm e2e -- e2e/cooling.spec.ts`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

Settings → Simulator, in `Simulator()` after the Xid row:

```tsx
      <Row label="Disconnect the Pico" htmlFor="sim-pico" hint="The fan controller stops answering; after 10 s its watchdog runs every fan at 100%.">
        <Switch id="sim-pico" checked={failures.data?.picoDisconnected ?? false} onCheckedChange={(v) => setFailures.mutate({ picoDisconnected: v })} />
      </Row>
      <Row label="Stall a fan" htmlFor="sim-stall" hint="Its tach reads 0 RPM while driven, as if a cable came loose.">
        <Select value={failures.data?.fanStalled ?? NONE} onValueChange={(v) => setFailures.mutate({ fanStalled: v === NONE ? null : v })}>
          <SelectTrigger id="sim-stall" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {['fan-1', 'fan-2', 'fan-3'].map((id, i) => (
              <SelectItem key={id} value={id}>Fan {i + 1}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
```

`src/features/cooling/cooling-history.tsx`:

```tsx
import { useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { useCoolingSeries } from '@/api/hooks'
import type { CoolingPoint, Fan, TimeRange } from '@/api/types'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatTimeTick } from '@/lib/format'

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)']

export function CoolingHistory({ fans }: { fans: Fan[] }) {
  const [range, setRange] = useState<TimeRange>('15m')
  const series = useCoolingSeries(range)
  const config: ChartConfig = Object.fromEntries([
    ...fans.map((f, i) => [`duty_${f.id}`, { label: `${f.name} %`, color: COLORS[i % COLORS.length] }]),
    ['hottest', { label: 'Hottest °C', color: 'var(--level-warn)' }],
  ])
  const hottest = (p: CoolingPoint) => {
    const temps = fans.flatMap((f) => (p.zoneTempC[f.id] == null ? [] : [p.zoneTempC[f.id]!]))
    return temps.length ? Math.max(...temps) : null
  }
  const data = (series.data ?? []).map((p) => ({
    t: p.t,
    ...Object.fromEntries(fans.map((f) => [`duty_${f.id}`, p.duty[f.id] ?? null])),
    hottest: hottest(p),
  }))
  return (
    <Card className="gap-3 py-4" data-testid="cooling-history">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-sm font-medium">Fan speed and hottest box</CardTitle>
        <TimeRangeToggle value={range} onChange={setRange} ranges={['15m', '1h']} />
      </CardHeader>
      <CardContent className="px-2">
        {series.data ? (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <LineChart data={data} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => formatTimeTick(t, range)} tickLine={false} axisLine={false} minTickGap={40} fontSize={11} />
              <YAxis yAxisId="duty" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={40} fontSize={11} />
              <YAxis yAxisId="temp" orientation="right" domain={[30, 'auto']} tickFormatter={(v: number) => `${v} °C`} tickLine={false} axisLine={false} width={48} fontSize={11} />
              <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, p) => (p?.[0]?.payload?.t ? formatDateTime(p[0].payload.t) : '')} />} />
              {fans.map((f) => (
                <Line key={f.id} yAxisId="duty" dataKey={`duty_${f.id}`} type="stepAfter" stroke={`var(--color-duty_${f.id})`} strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
              <Line yAxisId="temp" dataKey="hottest" type="monotone" stroke="var(--color-hottest)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        ) : (
          <Skeleton className="h-56 w-full" />
        )}
      </CardContent>
    </Card>
  )
}
```

Check the chart colour variable names against `src/index.css` (`--chart-1…` and `--level-warn`); use the names that exist there.

Fan card sparkline — in `cooling-page.tsx`, call `useCoolingSeries('15m')` once and pass each card its points as children:

```tsx
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'
// inside FanCard children slot:
<div className="h-10" aria-hidden>
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={points}>
      <YAxis hide domain={[0, 100]} />
      <Line dataKey="d" type="stepAfter" stroke="var(--brand)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
    </LineChart>
  </ResponsiveContainer>
</div>
```

where `points = series.data?.map((p) => ({ t: p.t, d: p.duty[f.id] })) ?? []`. Put this in a `FanSparkline({ points })` component in `fan-card.tsx` and render `<FanCard …><FanSparkline points={…} /></FanCard>`.

`src/features/cooling/zones-dialog.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useSetFanZones } from '@/api/hooks'
import type { Fan, FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Faceplate } from '@/components/faceplate'

/** One row per top-shelf box; pick the fan in front of it. */
export function ZonesDialog({ open, onOpenChange, fans, nodes }: { open: boolean; onOpenChange: (o: boolean) => void; fans: Fan[]; nodes: FleetNode[] }) {
  const save = useSetFanZones()
  const shelf = nodes.filter((n) => n.rack.shelf === 1).sort((a, b) => a.rack.slot - b.rack.slot)
  const current = () => Object.fromEntries(shelf.map((n) => [n.id, fans.find((f) => f.nodeIds.includes(n.id))?.id ?? null]))
  const [pick, setPick] = useState<Record<string, string | null>>(current)
  useEffect(() => {
    if (open) setPick(current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const submit = () => {
    const zones = Object.fromEntries(fans.map((f) => [f.id, shelf.filter((n) => pick[n.id] === f.id).map((n) => n.id)]))
    save.mutate(zones, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="zones-dialog">
        <DialogHeader>
          <DialogTitle>Fan zones</DialogTitle>
          <DialogDescription>Each fan follows the hottest box in its zone. Boxes with no fan aren’t cooled by the front fans.</DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-lg border">
          {shelf.map((n) => (
            <div key={n.id} className="flex items-center gap-3 px-3 py-2" role="radiogroup" aria-label={`Fan for ${n.id}`}>
              <Faceplate model={n.model} className="h-9 w-auto" />
              <span className="flex-1 font-mono text-sm">{n.id}</span>
              <div className="flex gap-1">
                {[...fans.map((f) => ({ id: f.id as string | null, label: f.name.replace('Fan ', '') })), { id: null, label: 'None' }].map((o) => (
                  <button
                    key={o.id ?? 'none'}
                    type="button"
                    role="radio"
                    aria-checked={pick[n.id] === o.id}
                    aria-label={o.id ? `${n.id} on ${fans.find((f) => f.id === o.id)!.name}` : `${n.id} on no fan`}
                    onClick={() => setPick((p) => ({ ...p, [n.id]: o.id }))}
                    className="h-7 min-w-8 rounded-md border px-2 text-xs transition-colors aria-checked:border-brand aria-checked:bg-brand/15 aria-checked:text-brand"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending} data-testid="zone-save">Save zones</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

(Same lint note as Task 7 about the disable comment. Use the shadcn `ToggleGroup` instead of hand-rolled radio buttons if it renders `role="radio"` items with accessible names — it does in single mode; either is acceptable as long as the e2e's `getByRole('radio', { name: 'spark-01 on Fan 2' })` resolves.)

In `cooling-page.tsx`, replace the Task 8 marker with:

```tsx
              <CoolingHistory fans={c.fans} />
              {nodes.data && <ZonesDialog open={zonesOpen} onOpenChange={setZonesOpen} fans={c.fans} nodes={nodes.data} />}
```

and remove the temporary `data-zones-open` attribute if Task 5 added it.

`e2e/screenshots.spec.ts` — add after `node-detail`:

```ts
  { name: 'cooling', run: async (p) => { await p.goto('/cooling'); await settle(p) } },
```

`README.md`:
- In the "What's in it" table, after the **Nodes** row:
  `| **Cooling** | Three 140 mm fans in front of the top shelf on a Raspberry Pi Pico. SparkMan sets each fan from the hottest box in its zone (a drag-to-edit temperature curve plus a load floor that spins up before the heat shows), with manual override, live RPM, history, and a watchdog failsafe on the Pico. |`
- In "The simulator" bullets, extend the Settings → Simulator line with "disconnects the Pico or stalls a fan".
- In "Deploy on the SparkMan host", add a bullet: `- **Fans:** wiring, the serial protocol and the bridge are in [the cooling spec](docs/superpowers/specs/2026-10-09-sparkman-cooling-design.md#6-phase-2-the SparkMan host--not-built-now).`

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && CI=1 pnpm e2e`
Expected: all PASS (unit count up by the new tests; e2e up by the new cooling tests).
Then: `SHOTS=1 CI=1 pnpm shots -- -g cooling` (or `pnpm shots` and keep only the cooling images if the rest are unchanged) and look at `docs/screenshots/cooling-dark.png` / `cooling-light.png`.

- [ ] **Step 5: Commit**

```bash
git add src e2e README.md docs/screenshots/cooling-dark.png docs/screenshots/cooling-light.png
git commit -m "feat(cooling): history chart, sparklines, zone editor, Pico/stall simulator controls, README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
