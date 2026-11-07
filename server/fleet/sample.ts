import type { MetricPoint, NodeLiveStats } from '../../src/api/types.ts'

/** First line the sampler prints: facts that don't change while it runs. */
export interface NodeFacts {
  cpus: number
  kernel: string
  driver: string
  cuda: string
  /** ConnectX-7 netdevs (driver mlx5_core) */
  cx7: string[]
  /** the interface holding the default route (the fleet LAN port) */
  mgmt: string | null
  /** the fleet port's and each ConnectX-7 netdev's MAC (absent from samplers older than the network page) */
  macs?: Record<string, string>
}

/** One line of raw counters (see sampler-script.ts). */
export interface RawSample {
  /** seconds since the epoch, box clock */
  t: number
  /** /proc/stat cpu: user nice system idle iowait irq softirq steal (jiffies) */
  cpu: number[]
  mem: { MemTotal?: number; MemAvailable?: number }
  /** nvidia-smi CSV, or null when it failed */
  gpu: string | null
  /** ACPI thermal zones, millidegrees C */
  acpi: number[]
  hwmon: Record<string, number[]>
  /** iface → [rx bytes, tx bytes] */
  net: Record<string, [number, number]>
  /** whole NVMe disk → [sectors read, sectors written] */
  disk: Record<string, [number, number]>
  /** root filesystem [size, used] bytes */
  fs: [number, number]
  /** ConnectX-7 netdev → operstate ('up', 'down', …) */
  links?: Record<string, string>
  /** ConnectX-7 netdev → its RDMA port's [received, sent] data in 4-byte units (RoCE traffic /proc/net/dev misses) */
  rdma?: Record<string, [number | null, number | null]>
  /** the fleet port and each ConnectX-7 netdev → [operstate, speed Mb/s (-1 when down), MTU] */
  ifaces?: Record<string, [string, number | null, number | null]>
  /** seconds since boot */
  up: number
}

export interface GpuReading {
  util: number | null
  powerW: number | null
  tempC: number | null
  throttling: boolean
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const v = Number.parseFloat(s.trim())
  return Number.isFinite(v) ? v : null
}

/**
 * utilization.gpu, power.draw, temperature.gpu, clocks.sm, clocks.max.sm, then the throttle reasons
 * hw_thermal, sw_thermal, hw_slowdown, sw_power_cap. An idle GB10 reports sw_power_cap Active at
 * 208 MHz, so only the thermal and hardware reasons count as throttling.
 */
export function parseGpu(csv: string | null): GpuReading | null {
  if (!csv) return null
  const f = csv.split('\n')[0].split(',').map((x) => x.trim())
  if (f.length < 5) return null
  return {
    util: num(f[0]),
    powerW: num(f[1]),
    tempC: num(f[2]),
    throttling: f.slice(5, 8).some((r) => r === 'Active'),
  }
}

const KB = 1024
const GB = 1e9
const SECTOR = 512

export function isRawSample(v: unknown): v is RawSample {
  const o = v as RawSample
  return typeof o === 'object' && o !== null && typeof o.t === 'number' && Array.isArray(o.cpu) && typeof o.net === 'object' && Array.isArray(o.fs)
}

export function isFacts(v: unknown): v is { facts: NodeFacts } {
  const o = v as { facts?: NodeFacts }
  return typeof o === 'object' && o !== null && typeof o.facts === 'object' && o.facts !== null && Array.isArray(o.facts.cx7)
}

const sumNet = (s: RawSample, ifaces: string[], i: 0 | 1) => ifaces.reduce((a, n) => a + (s.net[n]?.[i] ?? 0), 0)
/** a ConnectX-7's bytes: kernel traffic (NFS, ssh) plus RDMA, which only the port's own counters see */
const sumFabric = (s: RawSample, ifaces: string[], i: 0 | 1) => sumNet(s, ifaces, i) + ifaces.reduce((a, n) => a + (s.rdma?.[n]?.[i] ?? 0) * 4, 0)
const sumDisk = (s: RawSample, i: 0 | 1) => Object.values(s.disk).reduce((a, d) => a + d[i], 0)
const rate = (now: number, prev: number, dt: number) => (dt > 0 && now >= prev ? (now - prev) / dt : null)

/**
 * A MetricPoint from two consecutive samples (rates need both). CPU and rate fields are null on the
 * first sample. Timestamps use the SparkMan host's clock (`at`) so every node shares one timeline.
 */
export function derivePoint(prev: RawSample | null, cur: RawSample, facts: NodeFacts, at: number): MetricPoint {
  const gpu = parseGpu(cur.gpu)
  const memTotal = cur.mem.MemTotal ?? 0
  const memAvail = cur.mem.MemAvailable ?? memTotal
  const acpi = cur.acpi.length ? Math.max(...cur.acpi) / 1000 : null
  const dt = prev ? cur.t - prev.t : 0

  let cpuUser: number | null = null
  let cpuSystem: number | null = null
  if (prev && prev.cpu.length >= 8 && cur.cpu.length >= 8) {
    const d = cur.cpu.map((v, i) => v - (prev.cpu[i] ?? 0))
    const total = d.reduce((a, b) => a + b, 0)
    if (total > 0) {
      cpuUser = ((d[0] + d[1]) / total) * 100
      cpuSystem = ((d[2] + d[5] + d[6]) / total) * 100
    }
  }
  const mgmt = facts.mgmt ? [facts.mgmt] : []
  const r = (a: number, b: number) => (prev ? rate(a, b, dt) : null)
  return {
    t: at,
    gpuUtil: gpu?.util ?? null,
    memUsedGB: memTotal ? ((memTotal - memAvail) * KB) / GB : null,
    gpuPowerW: gpu?.powerW ?? null,
    gpuTempC: gpu?.tempC ?? null,
    acpiTempC: acpi,
    cpuUser,
    cpuSystem,
    netRxBps: prev ? r(sumNet(cur, mgmt, 0), sumNet(prev, mgmt, 0)) : null,
    netTxBps: prev ? r(sumNet(cur, mgmt, 1), sumNet(prev, mgmt, 1)) : null,
    cx7RxBps: prev ? r(sumFabric(cur, facts.cx7, 0), sumFabric(prev, facts.cx7, 0)) : null,
    cx7TxBps: prev ? r(sumFabric(cur, facts.cx7, 1), sumFabric(prev, facts.cx7, 1)) : null,
    diskReadBps: prev ? r(sumDisk(cur, 0) * SECTOR, sumDisk(prev, 0) * SECTOR) : null,
    diskWriteBps: prev ? r(sumDisk(cur, 1) * SECTOR, sumDisk(prev, 1) * SECTOR) : null,
    diskUsedPct: cur.fs[0] ? (cur.fs[1] / cur.fs[0]) * 100 : null,
  }
}

/** The node card's live block from the latest point and sample. */
export function liveStats(p: MetricPoint, cur: RawSample): NodeLiveStats {
  const gpu = parseGpu(cur.gpu)
  return {
    gpuUtil: p.gpuUtil ?? 0,
    memUsedGB: p.memUsedGB ?? 0,
    gpuPowerW: p.gpuPowerW ?? 0,
    gpuTempC: p.gpuTempC ?? 0,
    acpiTempC: p.acpiTempC ?? 0,
    cpuUtil: (p.cpuUser ?? 0) + (p.cpuSystem ?? 0),
    diskUsedPct: p.diskUsedPct ?? 0,
    throttling: gpu?.throttling ?? false,
  }
}
