import { execFileSync } from 'node:child_process'
import { closeSync, constants, createReadStream, existsSync, openSync, readdirSync, readFileSync, realpathSync, writeSync, type ReadStream } from 'node:fs'
import path from 'node:path'
import type { CoolingPoint, CoolingState, Fan, TimeRange } from '../../src/api/types.ts'
import { DEFAULT_POLICY, stepDuty, validatePolicy, zoneTarget, type CoolingPolicy, type DutyState, type FanReason, type Thermal } from '../../src/lib/cooling.ts'
import { RANGE_MS, SERIES_POINTS, type FleetDb } from './db.ts'

// The rack's front fans: a Pico on USB (firmware/pico-fan) applies PWM and reads tach; this decides the speeds.

const PICO_VID = '2e8a'
const FAN_IDS = ['fan-1', 'fan-2', 'fan-3']
/** the Pico's channel for each fan above: its first channel (GP21/GP20) is the right-hand fan, so the order runs backwards */
const PICO_CHANNEL = [2, 1, 0]
/** P14s top out near 1,800 RPM on the tach */
export const FAN_MAX_RPM = 1850
export const WATCHDOG_MS = 10_000
/** the Pico reports every second; three missed reports and it counts as gone */
const SILENT_MS = 3_000
/** a stopped P14 takes 6–8 s to spin up, so a stall needs longer than that */
const STALL_MS = 15_000
const STALL_RPM = 50
const HISTORY_MS = 2 * 3_600_000
const RETRY_MS = 5_000
const LINK_ALERT_MS = 30_000

export interface PicoReport {
  rpm: number[]
  duty: number[]
  fw: string
  failsafe: boolean
}

/** The serial side, swappable in tests. */
export interface PicoLink {
  /** the device in use, or null while there is none */
  readonly port: string | null
  /** open (or re-open) when closed; called every tick */
  poll(): void
  send(duty: number[]): void
  /** any other firmware command ({"cmd": …}) */
  command(msg: Record<string, unknown>): void
  close(): void
}

/** The Pico's tty: SPARKMAN_FAN_PORT, else the first ttyACM whose USB vendor is Raspberry Pi. */
export function findPicoPort(env = process.env): string | null {
  if (env.SPARKMAN_FAN_PORT) return existsSync(env.SPARKMAN_FAN_PORT) ? env.SPARKMAN_FAN_PORT : null
  let ttys: string[] = []
  try {
    ttys = readdirSync('/sys/class/tty').filter((t) => t.startsWith('ttyACM')).sort()
  } catch {
    return null
  }
  for (const t of ttys) {
    try {
      // .../usb1/1-2/1-2:1.0 is the interface; the vendor id lives on the device above it
      const iface = realpathSync(`/sys/class/tty/${t}/device`)
      if (readFileSync(path.join(iface, '..', 'idVendor'), 'utf8').trim() === PICO_VID) return `/dev/${t}`
    } catch {
      // not a USB tty
    }
  }
  return null
}

/** Newline-delimited JSON over the Pico's USB CDC tty. */
export class SerialPicoLink implements PicoLink {
  port: string | null = null
  private fd: number | null = null
  private stream: ReadStream | null = null
  private buf = ''
  private retryAt = 0
  private find: () => string | null
  private onReport: (r: PicoReport) => void

  constructor(onReport: (r: PicoReport) => void, find: () => string | null = findPicoPort) {
    this.onReport = onReport
    this.find = find
  }

  poll(): void {
    if (this.fd !== null || Date.now() < this.retryAt) return
    this.retryAt = Date.now() + RETRY_MS
    const port = this.find()
    if (!port) return
    try {
      // raw, no echo, and no hang-up on close (that would reset nothing on a Pico, but keeps the line quiet)
      execFileSync('stty', ['-F', port, '115200', 'raw', '-echo', '-hupcl'], { stdio: 'ignore' })
      this.fd = openSync(port, constants.O_RDWR | constants.O_NOCTTY)
    } catch (e) {
      console.warn(`[cooling] can't open ${port}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    this.port = port
    this.buf = ''
    this.stream = createReadStream('', { fd: this.fd, autoClose: false, encoding: 'utf8' })
    this.stream.on('data', (chunk) => this.read(String(chunk)))
    this.stream.on('error', () => this.close())
    this.stream.on('end', () => this.close())
    console.log(`[cooling] Pico on ${port}`)
  }

  private read(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      try {
        const v = JSON.parse(line) as Partial<PicoReport>
        if (Array.isArray(v.rpm) && Array.isArray(v.duty)) this.onReport({ rpm: v.rpm, duty: v.duty, fw: String(v.fw ?? ''), failsafe: v.failsafe === true })
      } catch {
        // a line cut by a reconnect
      }
    }
    if (this.buf.length > 4096) this.buf = ''
  }

  send(duty: number[]): void {
    this.command({ duty })
  }

  command(msg: Record<string, unknown>): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, JSON.stringify(msg) + '\n')
    } catch {
      this.close()
    }
  }

  close(): void {
    this.stream?.destroy()
    this.stream = null
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // already gone with the device
      }
    }
    if (this.port) console.warn(`[cooling] lost the Pico on ${this.port}`)
    this.fd = null
    this.port = null
  }
}

/** What the cooling loop needs from the fleet. */
export interface CoolingHost {
  /** shelf-1 boxes in rack order */
  fanShelf(): string[]
  /** null when the box is offline, rebooting or silent */
  thermal(nodeId: string): Thermal
  /** in maintenance and down: left out of its zone instead of running the fan flat out */
  away(nodeId: string): boolean
  activity(text: string): void
  /** open (detail) or clear (null) a fleet-level cooling incident */
  incident(ruleId: 'rule-cooling-link' | 'rule-fan-stall', key: string, title: string, detail: string | null): void
  changed(): void
}

interface FanRuntime {
  id: string
  name: string
  nodeIds: string[]
  state: DutyState | null
  manualDuty: number | null
  reason: FanReason
  zeroSince: number | null
}

export class CoolingManager {
  private host: CoolingHost
  private db: FleetDb
  private now: () => number
  readonly link: PicoLink
  policy: CoolingPolicy
  private fans: FanRuntime[]
  private report: (PicoReport & { at: number }) | null = null
  private history: CoolingPoint[] = []
  private timer: NodeJS.Timeout | null = null
  private ticks = 0
  private silentSince: number | null = null

  constructor(host: CoolingHost, db: FleetDb, opts: { now?: () => number; link?: PicoLink } = {}) {
    this.host = host
    this.db = db
    this.now = opts.now ?? Date.now
    this.link = opts.link ?? new SerialPicoLink((r) => this.onReport(r))
    this.policy = this.load('cooling:policy', structuredClone(DEFAULT_POLICY))
    const zones = this.load<Record<string, string[]> | null>('cooling:zones', null) ?? this.defaultZones()
    const manual = this.load<Record<string, number | null>>('cooling:manual', {})
    this.fans = FAN_IDS.map((id, i) => ({
      id, name: `Fan ${i + 1}`, nodeIds: zones[id] ?? [], state: null, manualDuty: manual[id] ?? null, reason: { kind: 'idle' }, zeroSince: null,
    }))
  }

  private load<T>(key: string, fallback: T): T {
    const v = this.db.get(key)
    if (v === null) return fallback
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  }

  /** the fan shelf in rack order, split into three runs of boxes */
  private defaultZones(): Record<string, string[]> {
    const shelf = this.host.fanShelf()
    const per = Math.ceil(shelf.length / FAN_IDS.length)
    return Object.fromEntries(FAN_IDS.map((id, i) => [id, shelf.slice(i * per, (i + 1) * per)]))
  }

  start(): void {
    this.link.poll()
    this.timer = setInterval(() => this.step(), 1_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.link.close()
  }

  onReport(r: PicoReport): void {
    this.report = { ...r, at: this.now() }
  }

  private connected(now: number): boolean {
    return this.report !== null && this.link.port !== null && now - this.report.at < SILENT_MS
  }

  /** the Pico's own failsafe, or ours by its rules when it has gone quiet */
  private failsafe(now: number): boolean {
    if (this.connected(now)) return this.report!.failsafe
    return this.silentSince !== null && now - this.silentSince >= WATCHDOG_MS
  }

  step(): void {
    const now = this.now()
    this.link.poll()
    const connected = this.connected(now)
    this.silentSince = connected ? null : (this.silentSince ?? now)
    const failsafe = this.failsafe(now)
    const point: CoolingPoint = { t: now, duty: {}, rpm: {}, zoneTempC: {} }
    this.fans.forEach((f, i) => {
      const zone = f.nodeIds.filter((id) => !this.host.away(id)).map((id) => ({ id, thermal: this.host.thermal(id) }))
      if (f.manualDuty !== null) {
        f.state = { duty: f.manualDuty, heldAt: now, at: now }
        f.reason = { kind: 'manual' }
      } else {
        const target = zoneTarget(this.policy, zone)
        f.state = stepDuty(f.state, target.duty, now, this.policy)
        f.reason = target.reason
      }
      // what the fan really gets: the Pico's word while it talks, 100 % once its watchdog has fired
      const ch = PICO_CHANNEL[i]
      const applied = failsafe ? 100 : connected ? (this.report!.duty[ch] ?? f.state.duty) : f.state.duty
      if (failsafe) f.reason = { kind: 'failsafe' }
      const rpm = connected ? (this.report!.rpm[ch] ?? 0) : 0
      f.zeroSince = connected && applied >= 20 && rpm < STALL_RPM ? (f.zeroSince ?? now) : null
      const temps = zone.flatMap((z) => (z.thermal ? [z.thermal.gpuTempC] : []))
      point.duty[f.id] = Math.round(applied)
      point.rpm[f.id] = rpm
      point.zoneTempC[f.id] = temps.length ? Math.max(...temps) : null
    })
    const duty: number[] = []
    this.fans.forEach((f, i) => (duty[PICO_CHANNEL[i]] = Math.round(f.state?.duty ?? 100)))
    this.link.send(duty)
    this.history.push(point)
    while (this.history.length && this.history[0].t < now - HISTORY_MS) this.history.shift()
    this.alerts(now)
    // the page polls on this topic; every other second is plenty for spinning blades
    if (++this.ticks % 2 === 0) this.host.changed()
  }

  private alerts(now: number): void {
    const silent = this.silentSince !== null && now - this.silentSince >= LINK_ALERT_MS
    this.host.incident('rule-cooling-link', 'pico', 'Cooling controller offline', silent ? `No report from the Pico${this.link.port ? ` on ${this.link.port}` : ' (no Pico on USB)'}; it runs every fan at 100 %` : null)
    for (const f of this.fans) {
      const stalled = f.zeroSince !== null && now - f.zeroSince >= STALL_MS
      this.host.incident('rule-fan-stall', f.id, `${f.name} stalled`, stalled ? `Tach reads 0 RPM at ${Math.round(f.state?.duty ?? 0)}% — cooling ${f.nodeIds.join(', ') || 'no boxes'}` : null)
    }
  }

  state(): CoolingState {
    const now = this.now()
    const last = this.history.at(-1)
    return {
      controller: {
        connected: this.connected(now),
        port: this.link.port ?? findPicoPort() ?? 'not found',
        firmware: this.report?.fw ?? 'unknown',
        lastHeartbeatAt: this.report?.at ?? null,
        watchdogMs: WATCHDOG_MS,
        failsafe: this.failsafe(now),
      },
      fans: this.fans.map(
        (f): Fan => ({
          id: f.id,
          name: f.name,
          nodeIds: [...f.nodeIds],
          duty: last?.duty[f.id] ?? Math.round(f.state?.duty ?? 100),
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

  /** SERIES_POINTS buckets over the range, each the latest sample at or before its time */
  series(range: TimeRange): CoolingPoint[] {
    const now = this.now()
    const step = RANGE_MS[range] / SERIES_POINTS
    const end = Math.floor(now / step) * step
    const out: CoolingPoint[] = []
    let j = 0
    for (let i = 0; i < SERIES_POINTS; i++) {
      const t = end - (SERIES_POINTS - 1 - i) * step
      while (j + 1 < this.history.length && this.history[j + 1].t <= t) j++
      const p = this.history[j]
      if (p && p.t <= t) out.push({ t, duty: { ...p.duty }, rpm: { ...p.rpm }, zoneTempC: { ...p.zoneTempC } })
    }
    return out
  }

  setOverride(fanId: string, duty: number | null): void {
    const f = this.fans.find((x) => x.id === fanId)
    if (!f) throw new CoolingError('not-found', `Fan ${fanId} not found`)
    if (duty !== null && !(Number.isFinite(duty) && duty >= 0 && duty <= 100)) throw new CoolingError('invalid', 'Fan speed must be 0–100 %')
    if (!this.connected(this.now())) throw new CoolingError('unavailable', 'The Pico isn’t answering — fan speeds can change once it’s back')
    f.manualDuty = duty === null ? null : Math.round(duty)
    this.db.set('cooling:manual', JSON.stringify(Object.fromEntries(this.fans.map((x) => [x.id, x.manualDuty]))))
    this.host.activity(duty === null ? `${f.name} back to auto` : `${f.name} pinned to ${Math.round(duty)}%`)
    this.step()
    this.host.changed()
  }

  /** The Pico holds this fan's tach line low: it reads 0 RPM while still spinning, so the stall alert can be tested. */
  tachTest(fanId: string, seconds: number): void {
    const i = this.fans.findIndex((x) => x.id === fanId)
    if (i < 0) throw new CoolingError('not-found', `Fan ${fanId} not found`)
    if (!(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60)) throw new CoolingError('invalid', 'Test length must be 1–60 s')
    if (!this.connected(this.now())) throw new CoolingError('unavailable', 'The Pico isn’t answering')
    this.link.command({ cmd: 'tach-test', ch: PICO_CHANNEL[i], s: Math.round(seconds) })
    this.host.activity(`${this.fans[i].name}: tach held at 0 for ${Math.round(seconds)} s (stall alert test)`)
  }

  setPolicy(patch: Partial<CoolingPolicy>): void {
    const next: CoolingPolicy = { ...this.policy, ...structuredClone(patch) }
    const err = validatePolicy(next)
    if (err) throw new CoolingError('invalid', err)
    this.policy = next
    this.db.set('cooling:policy', JSON.stringify(next))
    this.host.activity('Fan curve updated')
    this.host.changed()
  }

  setZones(zones: Record<string, string[]>): void {
    if (FAN_IDS.some((id) => !Array.isArray(zones[id])) || Object.keys(zones).some((k) => !FAN_IDS.includes(k))) throw new CoolingError('invalid', 'Give every fan a zone')
    const shelf = new Set(this.host.fanShelf())
    const seen = new Set<string>()
    for (const nodeId of Object.values(zones).flat()) {
      if (!shelf.has(nodeId)) throw new CoolingError('invalid', `${nodeId} isn’t on the fan shelf`)
      if (seen.has(nodeId)) throw new CoolingError('invalid', `${nodeId} is in two zones`)
      seen.add(nodeId)
    }
    for (const f of this.fans) f.nodeIds = [...zones[f.id]]
    this.db.set('cooling:zones', JSON.stringify(zones))
    this.host.activity('Fan zones updated')
    this.host.changed()
  }
}

export class CoolingError extends Error {
  readonly kind: 'not-found' | 'invalid' | 'unavailable'
  constructor(kind: CoolingError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}
