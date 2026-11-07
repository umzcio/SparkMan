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
    const { sim, run, now } = setup({ 'spark-04': { gpuTempC: 78, gpuUtil: 60 } })
    run(20_000)
    const f2 = fan(sim, 'fan-2', now())
    expect(f2.reason).toMatchObject({ kind: 'temp', nodeId: 'spark-04' })
    expect(f2.duty).toBeCloseTo(86, 0) // 78 °C sits between 72 °C→65 % and 82 °C→100 %
    expect(f2.rpm).toBeGreaterThan(rpmFor(f2.duty) * 0.95)
    expect(fan(sim, 'fan-1', now()).duty).toBeLessThan(40)
  })

  it('runs safe when a zone box goes silent', () => {
    const { sim, run, now } = setup({ 'dell-02': null })
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
    // before the first sample, the oldest one stands in (no step at the history edge)
    expect(sim.airflowAt('dell-02', T0 - 60_000)).toBe(sim.airflowAt('dell-02', T0))
  })

  it('serves a downsampled series with zone temperatures', () => {
    const { sim, run, now } = setup({ 'spark-01': { gpuTempC: 66, gpuUtil: 30 } })
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

  it('a short drop-out does not make a cooling-down fan jump on reconnect', () => {
    const { sim, run, now, temps } = setup({ 'spark-01': { gpuTempC: 80, gpuUtil: 50 } })
    run(4000)
    temps['spark-01'] = { gpuTempC: 50, gpuUtil: 10 }
    run(40_000) // hold over, ramping down at 2 %/s
    const before = sim.state(now()).fans[0].duty
    sim.connected = false
    run(8000) // under the watchdog
    sim.connected = true
    run(2000)
    expect(before - sim.state(now()).fans[0].duty).toBeLessThanOrEqual(5)
  })

  it('zone edits change the future, not the past', () => {
    const { sim, run, now } = setup()
    sim.setManual('fan-3', 100, now())
    sim.setManual('fan-1', 20, now())
    run(30_000)
    const past = now()
    const before = sim.airflowAt('dell-02', past)!
    sim.setZones({ 'fan-1': ['gx10-01', 'spark-01', 'dell-02'], 'fan-2': ['spark-02', 'spark-03', 'spark-04'], 'fan-3': ['dell-01'] })
    expect(sim.airflowAt('dell-02', past)).toBe(before)
    run(30_000)
    expect(sim.airflowAt('dell-02', now())!).toBeLessThan(0.3)
  })

  it('a top-shelf box with no fan gets no airflow (hotter), uncooled shelves stay neutral', () => {
    const { sim, run, now } = setup()
    sim.setZones({ 'fan-1': ['gx10-01', 'spark-01'], 'fan-2': ['spark-02', 'spark-03', 'spark-04'], 'fan-3': ['dell-01'] })
    run(2000)
    expect(sim.airflowAt('dell-02', now())).toBe(0)
    expect(sim.airflowAt('spark-05', now())).toBeNull()
  })
})
