import { existsSync, realpathSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import type { NetworkState, NetworkSwitch, NodeLink, NodeNetwork, SwitchPort, SwitchPortPeer } from '../../src/api/types.ts'
import type { FleetDb } from './db.ts'
import { createReader, type SwitchConfig, type SwitchReader, type SwitchReading } from './switches.ts'

/** What the network page needs of a node, from the leases and its sampler. */
export interface NetworkNode {
  id: string
  online: boolean
  /** the fleet LAN MAC from the DHCP leases */
  fleetMac: string | null
  /** the sampler's facts: fleet port, ConnectX-7 netdevs, their MACs */
  mgmt: string | null
  cx7: string[]
  macs: Record<string, string>
  /** its last sample: iface → [operstate, speed Mb/s, MTU] */
  ifaces: Record<string, [string, number | null, number | null]> | null
}

export interface NetworkHost {
  nodes(): NetworkNode[]
  incident(ruleId: 'rule-switch-down' | 'rule-switch-port', key: string, title: string, detail: string | null): void
  changed(): void
}

const POLL_MS = 15_000
/** polls in a row that must fail before a switch counts as unreachable */
const DOWN_AFTER = 2
/** a node's port below its expected speed this long opens an incident */
const SLOW_HOLD_MS = 60_000

interface SwitchRuntime {
  cfg: SwitchConfig
  reader: SwitchReader
  reading: SwitchReading | null
  /** port id → last octet counters, for rates */
  octets: Map<string, { t: number; rx: number | null; tx: number | null }>
  rates: Map<string, { rx: number | null; tx: number | null }>
  failures: number
  error: string | null
  lastPollAt: number | null
  busy: boolean
  /** answered at least once (kept across restarts): a switch not cabled yet raises no alert */
  everReached: boolean
}

/** A peer as identified by MAC: a node's interface, SparkMan's host, or another switch. */
interface KnownMac {
  nodeId: string | null
  label: string
  iface: string | null
  /** the network a node's interface sits on; null for anything else */
  role: 'fleet' | 'fabric' | null
}

/**
 * Some Dell GB10 boxes ship their 10G port and their first ConnectX-7 port with the same MAC (separate networks, so
 * no clash): a MAC maps to every interface carrying it, and each switch picks the one on its own network.
 */
type MacBook = Map<string, KnownMac[]>
const pick = (book: MacBook, m: string, role: 'fleet' | 'fabric'): KnownMac | undefined => {
  const ks = book.get(m)
  return ks?.find((k) => k.role === role) ?? ks?.[0]
}

export class NetworkManager {
  private readonly switches: SwitchRuntime[]
  private timer: ReturnType<typeof setInterval> | null = null
  /** `${switch}|${port}` → when the port's node first ran below speed */
  private slowSince = new Map<string, number>()
  /** open slow-link incidents by key → their title (reports match on it) */
  private slowOpen = new Map<string, string>()
  private readonly now: () => number
  private readonly localMacs: Map<string, string>

  private readonly host: NetworkHost

  private readonly db: Pick<FleetDb, 'get' | 'set'> | null

  constructor(host: NetworkHost, configs: SwitchConfig[], opts: { now?: () => number; reader?: (cfg: SwitchConfig) => SwitchReader; db?: Pick<FleetDb, 'get' | 'set'> } = {}) {
    this.host = host
    this.now = opts.now ?? Date.now
    this.db = opts.db ?? null
    const reader = opts.reader ?? createReader
    this.switches = configs.map((cfg) => ({
      cfg, reader: reader(cfg), reading: null, octets: new Map(), rates: new Map(), failures: 0, error: null, lastPollAt: null, busy: false,
      everReached: this.db?.get(`network:reached:${cfg.id}`) === '1',
    }))
    this.localMacs = new Map(Object.entries(networkInterfaces()).flatMap(([iface, addrs]) => (addrs ?? []).filter((a) => !a.internal && a.mac !== '00:00:00:00:00:00').map((a) => [a.mac.toLowerCase(), iface] as [string, string])))
  }

  get configured(): boolean {
    return this.switches.length > 0
  }

  start(): void {
    if (this.timer || !this.switches.length) return
    this.pollAll()
    this.timer = setInterval(() => this.pollAll(), POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const s of this.switches) s.reader.close()
  }

  private pollAll(): void {
    for (const s of this.switches) void this.poll(s)
  }

  private async poll(s: SwitchRuntime): Promise<void> {
    if (s.busy) return
    s.busy = true
    try {
      const reading = await s.reader.read()
      const t = this.now()
      for (const p of reading.ports) {
        const prev = s.octets.get(p.id)
        const rate = (cur: number | null, old: number | null | undefined) =>
          prev && cur !== null && old != null && cur >= old && t > prev.t ? ((cur - old) * 8 * 1000) / (t - prev.t) : null
        s.rates.set(p.id, { rx: rate(p.rxOctets, prev?.rx), tx: rate(p.txOctets, prev?.tx) })
        s.octets.set(p.id, { t, rx: p.rxOctets, tx: p.txOctets })
      }
      s.reading = reading
      s.failures = 0
      s.error = null
      if (!s.everReached) {
        s.everReached = true
        this.db?.set(`network:reached:${s.cfg.id}`, '1')
      }
    } catch (e) {
      s.failures++
      s.error = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = false
      s.lastPollAt = this.now()
    }
    this.evaluate()
    this.host.changed()
  }

  private name(s: SwitchRuntime): string {
    return s.cfg.name ?? s.cfg.id
  }

  private reachable(s: SwitchRuntime): boolean {
    return s.reading !== null && s.failures < DOWN_AFTER
  }

  /** MAC → who it belongs to: the nodes' ports, SparkMan's host, the switches themselves. */
  private knownMacs(nodes: NetworkNode[]): MacBook {
    const book: MacBook = new Map()
    const add = (m: string, k: KnownMac) => {
      const list = book.get(m) ?? []
      if (!list.some((x) => x.nodeId === k.nodeId && x.iface === k.iface)) book.set(m, [...list, k])
    }
    const self = hostname().split('.')[0]
    for (const [m, iface] of this.localMacs) add(m, { nodeId: null, label: self, iface, role: null })
    for (const s of this.switches) for (const m of s.reading?.macs ?? []) add(m, { nodeId: null, label: this.name(s), iface: null, role: null })
    for (const n of nodes) {
      if (n.fleetMac) add(n.fleetMac, { nodeId: n.id, label: n.id, iface: n.mgmt, role: 'fleet' })
      for (const [iface, m] of Object.entries(n.macs)) if (m) add(m.toLowerCase(), { nodeId: n.id, label: n.id, iface, role: iface === n.mgmt ? 'fleet' : 'fabric' })
    }
    return book
  }

  /** The peer on each port: the MACs the switch learned there, else the neighbour's LLDP name. */
  private peers(s: SwitchRuntime, known: MacBook, nodeIds: Set<string>): Map<string, SwitchPortPeer> {
    const byPort = new Map<string, KnownMac[]>()
    for (const [m, port] of s.reading?.fdb ?? []) {
      const k = pick(known, m, s.cfg.role)
      if (k) byPort.set(port, [...(byPort.get(port) ?? []), k])
    }
    const out = new Map<string, SwitchPortPeer>()
    for (const [port, ks] of byPort) {
      const nodes = [...new Set(ks.map((k) => k.nodeId).filter((id): id is string => id !== null))]
      // a port facing one node (both halves of a ConnectX-7 land on one QSFP port); several nodes is an uplink
      if (nodes.length === 1) {
        const ifaces = [...new Set(ks.filter((k) => k.nodeId === nodes[0]).map((k) => k.iface).filter((i): i is string => !!i))]
        out.set(port, { nodeId: nodes[0], label: nodes[0], iface: ifaces.join(' + ') || null, via: 'mac' })
      } else if (!nodes.length) {
        out.set(port, { nodeId: null, label: ks[0].label, iface: ks[0].iface, via: 'mac' })
      }
    }
    for (const [port, sysName] of s.reading?.lldp ?? []) {
      if (out.has(port)) continue
      const short = sysName.split('.')[0]
      out.set(port, { nodeId: nodeIds.has(short) ? short : null, label: short, iface: null, via: 'lldp' })
    }
    return out
  }

  private problem(s: SwitchRuntime, port: { up: boolean; speedMbps: number | null }, peer: SwitchPortPeer | undefined): string | null {
    const expect = s.cfg.expectMbps
    if (!peer?.nodeId || !expect || !port.up || port.speedMbps === null || port.speedMbps >= expect) return null
    return `${fmtMbps(port.speedMbps)}, expected ${fmtMbps(expect)}`
  }

  state(): NetworkState {
    const nodes = this.host.nodes()
    const known = this.knownMacs(nodes)
    const nodeIds = new Set(nodes.map((n) => n.id))
    /** `${role}|${MAC}` → where it lands, for the nodes' own view */
    const landing = new Map<string, { switchId: string; portName: string }>()
    const switches: NetworkSwitch[] = this.switches.map((s) => {
      const peers = this.peers(s, known, nodeIds)
      for (const [m, port] of s.reading?.fdb ?? []) {
        const p = s.reading?.ports.find((x) => x.id === port)
        // a node's MAC seen across an uplink is not where its cable is
        if (p && peers.get(port)?.nodeId === pick(known, m, s.cfg.role)?.nodeId) landing.set(`${s.cfg.role}|${m}`, { switchId: s.cfg.id, portName: p.name })
      }
      const ports: SwitchPort[] = (s.reading?.ports ?? []).map(({ rxOctets: _rx, txOctets: _tx, ...p }) => {
        const peer = peers.get(p.id) ?? null
        const rate = s.rates.get(p.id)
        return { ...p, rxBps: rate?.rx ?? null, txBps: rate?.tx ?? null, peer, problem: this.problem(s, p, peer ?? undefined) }
      })
      return {
        id: s.cfg.id, name: this.name(s), role: s.cfg.role, kind: s.cfg.kind, host: s.cfg.host,
        model: s.reading?.model ?? s.cfg.model ?? '', everReached: s.everReached, firmware: s.reading?.firmware ?? '', serial: s.reading?.serial ?? '', uptimeS: s.reading?.uptimeS ?? null,
        reachable: this.reachable(s), error: s.error, lastPollAt: s.lastPollAt, health: s.reading?.health ?? [], ports,
        console: consoleOf(s.cfg),
      }
    })
    const nodeViews: NodeNetwork[] = nodes.map((n) => {
      const link = (iface: string, role: 'fleet' | 'fabric'): NodeLink => {
        const [state, speed, mtu] = n.ifaces?.[iface] ?? ['', null, null]
        const m = (n.macs[iface] || (role === 'fleet' ? n.fleetMac : null) || '').toLowerCase() || null
        const at = m ? landing.get(`${role}|${m}`) : undefined
        return { iface, role, up: state === 'up', speedMbps: speed !== null && speed > 0 ? speed : null, mtu, mac: m, switchId: at?.switchId ?? null, portName: at?.portName ?? null }
      }
      return { nodeId: n.id, links: [...(n.mgmt ? [link(n.mgmt, 'fleet')] : []), ...n.cx7.map((i) => link(i, 'fabric'))] }
    })
    return { switches, nodes: nodeViews }
  }

  /** Incidents: a switch that stopped answering, a node's port below its expected speed. */
  private evaluate(): void {
    const t = this.now()
    const online = new Set(this.host.nodes().filter((n) => n.online).map((n) => n.id))
    const state = this.state()
    const seen = new Set<string>()
    for (const sw of state.switches) {
      const s = this.switches.find((x) => x.cfg.id === sw.id)!
      // a switch that has never answered (added before its cable) is waiting, not down
      this.host.incident('rule-switch-down', sw.id, `${sw.name} unreachable`,
        s.everReached && s.failures >= DOWN_AFTER ? `${sw.name} (${sw.host}) has not answered ${s.failures} polls in a row: ${s.error ?? 'no reply'}` : null)
      if (!sw.reachable) continue
      for (const p of sw.ports) {
        if (!p.peer?.nodeId) continue
        const key = `${sw.id}|${p.id}`
        const slow = p.problem !== null && online.has(p.peer.nodeId)
        if (slow) {
          seen.add(key)
          if (!this.slowSince.has(key)) this.slowSince.set(key, t)
        }
        const held = slow && t - (this.slowSince.get(key) ?? t) >= SLOW_HOLD_MS
        const title = `${p.peer.nodeId} link slow on ${sw.name} port ${p.label}`
        if (held) this.slowOpen.set(key, title)
        if (held || this.slowOpen.has(key)) this.host.incident('rule-switch-port', key, this.slowOpen.get(key) ?? title, held ? `${p.name}: ${p.problem}` : null)
        if (!held) this.slowOpen.delete(key)
      }
    }
    for (const k of this.slowSince.keys()) if (!seen.has(k)) this.slowSince.delete(k)
    // a port that lost its node (or a switch gone quiet) clears what it had open
    for (const [k, title] of this.slowOpen) {
      if (seen.has(k)) continue
      this.host.incident('rule-switch-port', k, title, null)
      this.slowOpen.delete(k)
    }
  }
}

/** Whether the switch's console cable is plugged into this host: its serial device exists. */
function consoleOf(cfg: SwitchConfig): NetworkSwitch['console'] {
  if (!cfg.console) return null
  const connected = existsSync(cfg.console)
  let tty: string | null = null
  try {
    tty = connected ? realpathSync(cfg.console) : null
  } catch {
    // unplugged between the two calls
  }
  return { device: cfg.console, tty, jack: cfg.consoleJack ?? 'rj45', connected, host: hostname().split('.')[0] }
}

export function fmtMbps(mbps: number): string {
  return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`
}
