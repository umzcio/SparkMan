# SparkMan Cooling — fan control design

**Status:** approved in conversation 2026-10-09 · **Phase:** 1 (UI prototype on simulated fans)

## Goal

Three 140 mm PWM fans stand in front of the top rack shelf. A Raspberry Pi Pico, plugged into **the SparkMan host** over USB, drives them. **SparkMan decides** each fan's speed from the GPU temperature and utilization of the boxes in front of it; the Pico only applies PWM, reads tach and fails safe. SparkMan gets a **Cooling** page to show it off.

Phase 1 builds the control logic for real and the fans on the in-browser simulator, like every other fleet page. The serial bridge and Pico firmware are specified here (section 6) for the SparkMan host to build.

### Decisions

| Question | Decision |
|---|---|
| Where the Pico plugs in | the SparkMan host, over USB serial |
| Who decides speed | SparkMan (it has every box's telemetry); the Pico has a watchdog failsafe |
| Fan ↔ box mapping | Zones: each fan follows the hottest box in front of it, editable |
| Scope now | Cooling page on simulated fans; bridge + firmware documented only |

## 1. Control logic — `src/lib/cooling.ts`

Pure and dependency-free (no React, no `@/api/mock`), so the phase-2 server controller imports it unchanged.

```ts
export interface CurvePoint { tempC: number; duty: number }          // duty 0–100
export interface CoolingPolicy {
  curve: CurvePoint[]          // 2–6 points, tempC strictly increasing, duty non-decreasing
  loadFloor: { util: number; duty: number }   // gpuUtil ≥ util ⇒ duty ≥ duty
  minDuty: number              // never below (fans never stop)
  holdMs: number               // how long a fan holds before coming down
  rampDownPerSec: number       // duty points per second once the hold expires
}
export const DEFAULT_POLICY: CoolingPolicy = {
  curve: [ { tempC: 45, duty: 25 }, { tempC: 60, duty: 40 }, { tempC: 72, duty: 65 }, { tempC: 82, duty: 100 } ],
  loadFloor: { util: 80, duty: 50 },
  minDuty: 20,
  holdMs: 30_000,
  rampDownPerSec: 2,
}
```

- **`curveDuty(curve, tempC)`** — piecewise linear between points; below the first point ⇒ first point's duty, above the last ⇒ last point's duty.
- **`nodeDemand(policy, live)`** — for one box: `max(curveDuty(temp), loadFloor if util ≥ threshold, minDuty)`, clamped 0–100, plus the reason (`temp` or `load`). **`live === null` (offline, rebooting, no telemetry) ⇒ demand 100, reason `no-data`** — unknown counts as hot.
- **`zoneTarget(policy, zoneNodes)`** — the highest demand in the zone and the box that set it (ties: higher temperature wins). An empty zone ⇒ `minDuty`, reason `idle`.
- **`stepDuty(prev, target, now, policy)`** — smoothing. Rising: jump to the target immediately and restart the hold. Falling: hold `holdMs` from the last rise, then drop at most `rampDownPerSec × elapsed` toward the target. Returns the new duty and the hold timestamp.
- **`FanReason`** — `{ kind: 'temp' | 'load' | 'no-data' | 'idle' | 'manual' | 'failsafe', nodeId?: string, value?: number }`, rendered as e.g. "**spark-02** 78 °C", "Load floor · **spark-03** 92% GPU", "**dell-02** offline — running safe", "Manual", "Pico failsafe".
- **`validateCurve(points)`** — the rules above; the setter rejects invalid curves.

## 2. Types and client — `src/api/types.ts`, `src/api/client.tsx`

```ts
export interface Fan {
  id: string                 // 'fan-1' … 'fan-3'
  name: string               // 'Fan 1'
  nodeIds: string[]          // its zone
  duty: number               // commanded, 0–100
  rpm: number                // measured (tach)
  mode: 'auto' | 'manual'
  manualDuty: number | null
  reason: FanReason
  stalled: boolean           // commanded ≥ 20% but rpm 0 for 5 s
}
export interface CoolingController {
  connected: boolean
  port: string               // '/dev/ttyACM0'
  firmware: string           // 'sparkman-fan 0.1.0'
  lastHeartbeatAt: number | null
  watchdogMs: number         // 10_000
  failsafe: boolean          // Pico has taken over at 100%
}
export interface CoolingState { controller: CoolingController; fans: Fan[]; policy: CoolingPolicy; maxRpm: number }
export interface CoolingPoint { t: number; duty: Record<string, number>; rpm: Record<string, number>; zoneTempC: Record<string, number | null> }
```

`SparkManClient` gains:

- `getCooling(): Promise<CoolingState>`
- `getCoolingSeries(range: TimeRange): Promise<CoolingPoint[]>`
- `setFanOverride(fanId: string, duty: number | null): Promise<void>` — `null` returns the fan to auto
- `setCoolingPolicy(patch: Partial<CoolingPolicy>): Promise<void>` — rejects an invalid curve
- `setFanZones(zones: Record<string, string[]>): Promise<void>` — a box belongs to at most one fan; only shelf-1 boxes are accepted

Hooks in `src/api/hooks.ts`: `useCooling`, `useCoolingSeries`, and mutations, invalidated on a new `'cooling'` topic. `FailureInjection` gains `picoDisconnected: boolean` and `fanStalled: string | null`.

## 3. Simulator — `src/api/mock/`

- **Fans:** `fan-1` → gx10-01, spark-01 · `fan-2` → spark-02, spark-03, spark-04 · `fan-3` → dell-01, dell-02. Shelf 2 is not fan-cooled.
- **Each tick (2 s):** compute each zone's target with `cooling.ts`, apply `stepDuty` (or the manual duty), then RPM moves toward `duty/100 × 1500` with a first-order lag (~4 s) and ±1.5% jitter; min spin ~300 RPM at 20%.
- **Airflow cools:** each shelf-1 box's temperature model gets a cooling term that grows with its fan's RPM, so 20% vs 100% is ~12 °C apart under load. Forcing a fan low makes its boxes climb within a minute; existing node behaviour (incl. the spark-05 thermal incident on shelf 2) is unchanged.
- **History:** a ring buffer of `CoolingPoint` per tick, back-filled for 1 h at start like node metrics.
- **Failures (Settings → Simulator):**
  - *Pico disconnected* — `connected: false`, `lastHeartbeatAt` freezes, after `watchdogMs` the simulated Pico sets every fan to 100% (`failsafe: true`, reason `failsafe`); SparkMan's commands are ignored. Opens incident *Cooling controller offline* (critical); resolves on reconnect.
  - *Stall fan N* — that fan's RPM drops to 0 while commanded; after 5 s `stalled: true` and incident *Fan N stalled* (critical) naming its boxes.
- **Alert rules** added: *Cooling controller offline*, *Fan stalled*.
- **Activity** entries for override set/cleared, curve changed, zones changed.

## 4. The Cooling page — `/cooling`

Nav: **Fleet → Cooling** (lucide `Fan`). Carries the Simulated fleet data badge.

- **Status line** (`useCoolingStatus`): `3 fans · avg 54%` · `driven by spark-02 78 °C` · `Pico connected` (ok) / `Pico offline — failsafe 100%` (error) / `Fan 2 stalled` (error) / `1 manual` (info).
- **Shelf hero:** the top shelf's photo faceplates in rack order with three fans drawn in front. Blades spin at a rate proportional to RPM (CSS rotation, duration from RPM; static under `prefers-reduced-motion`); a stalled fan stops and turns red. A bracket over each zone; each box shows its GPU temperature chip coloured by the curve (cool → hot). Fits the width on phones (same approach as the rack view).
- **Fan cards (×3):** duty % (large), RPM, the reason line, a 15-min sparkline, a manual override slider (0–100, step 5) with **Back to auto**. A manual fan shows a "Manual" badge.
- **Curve editor:** an SVG chart, temp 30–95 °C × duty 0–100%. Drag points (pointer events with capture; keyboard: focus a point, arrows move 1 °C / 1%). Live dots for each shelf-1 box at its current temperature on the curve. Load floor (util threshold + duty) and min duty as inputs beside it. **Save** / **Reset to default**; invalid curves can't be saved (inline message).
- **History chart:** duty per fan (lines) with the hottest zone temperature on a second axis; 15m / 1h.
- **Controller card:** connected dot, port, firmware, last heartbeat (relative), watchdog timeout, failsafe state; **Edit zones** opens a dialog — one column per fan, each shelf-1 box assigned to one fan.
- **Mobile:** single column; hero scales; curve editor full-width with larger hit targets.

## 5. Testing

- **Unit (`cooling.test.ts`):** curve interpolation and ends, load floor, minDuty, `no-data` ⇒ 100, zone max + tie-break, instant rise, hold then ramp-down, `validateCurve` rejections.
- **Simulator:** fans follow targets; forcing 20% raises zone temps vs 100%; Pico disconnect ⇒ failsafe 100% after watchdog + incident, reconnect resolves; stall ⇒ rpm 0, `stalled`, incident; zone validation.
- **e2e (`cooling.spec.ts`):** page renders three fans and a status line; override a fan → Manual badge and duty change → Back to auto; drag a curve point and save; Settings → Simulator → Pico disconnected ⇒ failsafe status; mobile no-overflow list and all-routes include `/cooling`; README screenshots add `cooling`.

## 6. Phase 2 (the SparkMan host) — built 2026-11-03

**Wiring (Pico → 4-pin fans, fans on their own 12 V supply, grounds common):**

| SparkMan fan (as you face the rack) | Pico channel | PWM (pin 4) | Tach (pin 3) |
|---|---|---|---|
| Fan 1 (left) | 2 | GP16 | GP17 |
| Fan 2 (middle) | 1 | GP22 | GP19 |
| Fan 3 (right) | 0 | GP21 | GP20 |

- PWM at 25 kHz, open-drain from a PIO program: the Pico only pulls the line low or lets go, and the fan's own pull-up takes it high. No transistor needed.
- Measured on Arctic P14 PWM PST: 100% ≈ 1,800 RPM, 50% ≈ 1,030, 30% ≈ 650, 20% ≈ 390; 0% stops the fan; spin-up from stopped takes 6–8 s.
- **Tach is open-collector: pull it up to 3.3 V (≈10 kΩ), never 12 V** — 12 V on a GPIO damages the Pico. Two pulses per revolution.

**Serial protocol** (USB CDC, newline-delimited JSON):

- Host → Pico, every 1 s: `{"duty":[40,55,70]}`
- Pico → host, every 1 s and after each command: `{"rpm":[812,1004,1220],"duty":[40,55,70],"fw":"sparkman-fan 0.1.0","failsafe":false}`
- Pico watchdog: no valid command for 10 s ⇒ all fans 100%, `"failsafe":true` until the next command. On boot, fans start at 100%. A hardware watchdog resets a hung Pico, which lets go of every PWM line (100%).
- `{"cmd":"maint"}` reboots the Pico without the controller, to a free REPL for updating `main.py` (`firmware/pico-fan/`); the next reset starts the controller again.

**Server bridge:** `server/fleet/cooling.ts` opens the port (`SPARKMAN_FAN_PORT`, default auto-detect the Pico's USB VID `2E8A`), runs the same `cooling.ts` loop against real telemetry, and serves `/api/cooling` with the same shapes as section 2; the real `SparkManClient` reads it in place of the simulator. Differences from the simulator: a stall needs 15 s (spin-up from 0% takes 6–8 s), and a box that is both in maintenance and offline drops out of its zone instead of running its fan at 100%. Incidents *Cooling controller offline* (30 s without a report) and *Fan N stalled* go through the alert engine. `SPARKMAN_FAN=0` turns the bridge off.

## Out of scope

Fans for shelf 2, per-fan curves, fan profiles/schedules, controlling fans inside the boxes, writing the firmware or bridge in phase 1.
