// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { derivePoint, isFacts, isRawSample, liveStats, parseGpu, type NodeFacts, type RawSample } from './sample.ts'

// Two lines captured from a GB10 serving a model, trimmed.
const facts: NodeFacts = { cpus: 20, kernel: '6.17.0-1032-nvidia', driver: '580.173.02', cuda: '13.0', cx7: ['enp1s0f0np0', 'enP2p1s0f0np0'], mgmt: 'enP7s7' }
const a: RawSample = {
  t: 1000,
  cpu: [765192, 26873, 837040, 1256306163, 147947, 0, 31526, 0],
  mem: { MemTotal: 127600752, MemAvailable: 11060496 },
  gpu: '0, 11.30, 43, 2405, 3003, Not Active, Not Active, Not Active, Not Active',
  acpi: [45800, 44300, 45300],
  hwmon: { mlx5: [54000] },
  net: { enP7s7: [1000, 2000], enp1s0f0np0: [0, 0], enP2p1s0f0np0: [10, 10] },
  disk: { nvme0n1: [100, 200] },
  fs: [2_000_000_000_000, 500_000_000_000],
  up: 600_000,
}
const b: RawSample = {
  ...a,
  t: 1002,
  cpu: [765292, 26873, 837090, 1256306963, 147947, 0, 31576, 0],
  gpu: '87, 64.5, 71, 2405, 3003, Not Active, Active, Not Active, Not Active',
  net: { enP7s7: [3000, 6000], enp1s0f0np0: [2_000_000, 4_000_000], enP2p1s0f0np0: [10, 2_000_010] },
  disk: { nvme0n1: [104, 210] },
}

describe('parseGpu', () => {
  it('reads GB10 fields and treats N/A as null', () => {
    expect(parseGpu(a.gpu)).toEqual({ util: 0, powerW: 11.3, tempC: 43, throttling: false })
    expect(parseGpu('[N/A], [N/A], 40, 1, 2, Not Active')).toEqual({ util: null, powerW: null, tempC: 40, throttling: false })
    expect(parseGpu(null)).toBeNull()
  })
  it('flags thermal and hardware throttling, not the idle power cap', () => {
    expect(parseGpu(b.gpu)?.throttling).toBe(true)
    expect(parseGpu('0, 4.0, 39, 208, 3003, Not Active, Not Active, Not Active, Active')?.throttling).toBe(false)
  })
})

describe('derivePoint', () => {
  it('leaves rates null on the first sample', () => {
    const p = derivePoint(null, a, facts, 5)
    expect(p.t).toBe(5)
    expect(p.cpuUser).toBeNull()
    expect(p.netRxBps).toBeNull()
    expect(p.memUsedGB).toBeCloseTo(((127600752 - 11060496) * 1024) / 1e9, 6)
    expect(p.acpiTempC).toBe(45.8)
    expect(p.diskUsedPct).toBe(25)
  })
  it('derives CPU shares and byte rates from deltas', () => {
    const p = derivePoint(a, b, facts, 7)
    // deltas: user 100, system 50, idle 800, softirq 50 → total 1000
    expect(p.cpuUser).toBeCloseTo(10)
    expect(p.cpuSystem).toBeCloseTo(10)
    expect(p.netRxBps).toBe(1000)
    expect(p.netTxBps).toBe(2000)
    expect(p.cx7RxBps).toBe(1_000_000)
    expect(p.cx7TxBps).toBe(3_000_000)
    // RDMA counts in 4-byte units on top of the kernel's bytes: 2 s of 50 MB/s in, 100 MB/s out
    const q = derivePoint({ ...a, rdma: { enp1s0f0np0: [0, 0] } }, { ...b, rdma: { enp1s0f0np0: [25_000_000, 50_000_000] } }, facts, 7)
    expect(q.cx7RxBps).toBe(1_000_000 + 50_000_000)
    expect(q.cx7TxBps).toBe(3_000_000 + 100_000_000)
    expect(p.diskReadBps).toBe(1024)
    expect(p.diskWriteBps).toBe(2560)
    expect(p.gpuUtil).toBe(87)
  })
  it('drops rates when a counter went backwards (reboot or reset)', () => {
    const reset = { ...b, net: { enP7s7: [0, 0] as [number, number] } }
    expect(derivePoint(a, reset, facts, 1).netRxBps).toBeNull()
  })
})

describe('liveStats and guards', () => {
  it('builds the live block', () => {
    const s = liveStats(derivePoint(a, b, facts, 1), b)
    expect(s.cpuUtil).toBeCloseTo(20)
    expect(s.throttling).toBe(true)
  })
  it('recognises the two line kinds', () => {
    expect(isFacts({ facts })).toBe(true)
    expect(isRawSample(a)).toBe(true)
    expect(isRawSample({ facts })).toBe(false)
  })
})
