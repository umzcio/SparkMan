import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import snmp, { type Session, type Varbind } from 'net-snmp'
import type { SwitchHealthReading, SwitchHealthStatus, SwitchPort } from '../../src/api/types.ts'

/** A switch in the site config (fleet.json `switches`). */
export interface SwitchConfig {
  id: string
  name?: string
  role: 'fleet' | 'fabric'
  /** snmp: SNMPv3 (IF-MIB, BRIDGE-MIB, LLDP-MIB; TP-Link's system MIB when present); routeros: MikroTik's REST API */
  kind: 'snmp' | 'routeros'
  host: string
  /** root-only file: snmp `user=`/`auth=`/`priv=` lines (SHA / AES-128); routeros the password alone */
  secretFile: string
  /** routeros account (read-only group); default sparkman */
  user?: string
  /** routeros: the HTTPS certificate's SHA-256 fingerprint (hex, colons optional); without it any certificate is accepted */
  tlsFingerprint?: string
  /** the speed a node's port should run at (10000 on the fleet switch, 200000 on the fabric) */
  expectMbps?: number
  /** the model, for its faceplate before SparkMan first reaches it (the switch's own answer wins after) */
  model?: string
  /** the switch's serial console as plugged into SparkMan's host (a /dev/serial/by-id path), and its jack */
  console?: string
  consoleJack?: 'usb-c' | 'rj45'
}

/** One port as read, before rates and peers: counters are cumulative. */
export type PortReading = Omit<SwitchPort, 'rxBps' | 'txBps' | 'peer' | 'problem'> & { rxOctets: number | null; txOctets: number | null }

/** One poll of a switch. */
export interface SwitchReading {
  model: string
  firmware: string
  serial: string
  uptimeS: number | null
  /** the switch's own MACs: another switch's MAC table shows them on the uplink */
  macs: string[]
  health: SwitchHealthReading[]
  ports: PortReading[]
  /** MAC → port id, from the forwarding table */
  fdb: Map<string, string>
  /** port id → the neighbour's LLDP system name */
  lldp: Map<string, string>
}

export interface SwitchReader {
  read(): Promise<SwitchReading>
  close(): void
}

export function createReader(cfg: SwitchConfig): SwitchReader {
  return cfg.kind === 'routeros' ? new RouterOsReader(cfg) : new SnmpReader(cfg)
}

function secretLines(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8')
  return Object.fromEntries(text.split('\n').flatMap((l) => {
    const i = l.indexOf('=')
    return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : []
  }))
}

const mac = (s: string) => s.toLowerCase().replace(/-/g, ':')
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// ---------- SNMPv3 (the TP-Link SX3832; any IF-MIB switch) ----------

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifMtu: '1.3.6.1.2.1.2.2.1.4',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifInDiscards: '1.3.6.1.2.1.2.2.1.13',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutDiscards: '1.3.6.1.2.1.2.2.1.19',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  /** BRIDGE-MIB: MAC → bridge port, bridge port → ifIndex */
  fdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  basePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  /** LLDP-MIB lldpRemSysName, indexed timeMark.localPort.remIndex (localPort = bridge port) */
  lldpRemSysName: '1.0.8802.1.1.2.1.4.1.1.9',
  // TP-Link (Omada / JetStream) system and monitor MIBs
  tpHwVersion: '1.3.6.1.4.1.11863.6.1.1.5.0',
  tpFwVersion: '1.3.6.1.4.1.11863.6.1.1.6.0',
  tpMac: '1.3.6.1.4.1.11863.6.1.1.7.0',
  tpSerial: '1.3.6.1.4.1.11863.6.1.1.8.0',
  tpCpu5s: '1.3.6.1.4.1.11863.6.4.1.1.1.1.2.1',
  tpMemory: '1.3.6.1.4.1.11863.6.4.1.2.1.1.2.1',
}
/** values per GetBulk: the SX3832 drops replies that outgrow one 1,500-byte packet */
const BULK = 8
/** the forwarding table and LLDP change slowly: read them every few polls */
const SLOW_EVERY = 4

class SnmpReader implements SwitchReader {
  private session: Session | null = null
  private polls = 0
  private slow: { fdb: Map<string, string>; lldp: Map<string, string> } = { fdb: new Map(), lldp: new Map() }
  private readonly cfg: SwitchConfig
  constructor(cfg: SwitchConfig) {
    this.cfg = cfg
  }

  private open(): Session {
    if (this.session) return this.session
    const s = secretLines(this.cfg.secretFile)
    if (!s.user || !s.auth || !s.priv) throw new Error(`${this.cfg.secretFile}: expected user=, auth= and priv= lines`)
    const session = snmp.createV3Session(this.cfg.host, {
      name: s.user, level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha, authKey: s.auth, privProtocol: snmp.PrivProtocols.aes, privKey: s.priv,
    }, { timeout: 4000, retries: 2 })
    session.on('error', () => this.close())
    this.session = session
    return session
  }

  close(): void {
    try {
      this.session?.close()
    } catch {
      // already closed
    }
    this.session = null
  }

  private get(oids: string[]): Promise<Map<string, unknown>> {
    const s = this.open()
    return new Promise((resolve, reject) => s.get(oids, (err, vbs) => {
      if (err) return reject(err)
      resolve(new Map(vbs.filter((v) => !snmp.isVarbindError(v)).map((v) => [v.oid, v.value])))
    }))
  }

  /** column → index (the OID past the column) → value */
  private walk(column: string): Promise<Map<string, unknown>> {
    const s = this.open()
    const out = new Map<string, unknown>()
    return new Promise((resolve, reject) => s.subtree(column, BULK, (vbs: Varbind[]) => {
      for (const v of vbs) if (!snmp.isVarbindError(v)) out.set(v.oid.slice(column.length + 1), v.value)
    }, (err) => (err ? reject(err) : resolve(out))))
  }

  async read(): Promise<SwitchReading> {
    try {
      return await this.poll()
    } catch (e) {
      // a fresh session (and engine discovery) next time
      this.close()
      throw e
    }
  }

  private async poll(): Promise<SwitchReading> {
    const sys = await this.get([OID.sysDescr, OID.sysUpTime, OID.tpHwVersion, OID.tpFwVersion, OID.tpMac, OID.tpSerial, OID.tpCpu5s, OID.tpMemory])
    const text = (k: string) => {
      const v = sys.get(k)
      return Buffer.isBuffer(v) ? v.toString('utf8').trim() : typeof v === 'string' ? v.trim() : ''
    }
    const cols: Record<string, Map<string, unknown>> = {}
    for (const c of ['ifName', 'ifOperStatus', 'ifHighSpeed', 'ifMtu', 'ifHCInOctets', 'ifHCOutOctets', 'ifInErrors', 'ifOutErrors', 'ifInDiscards', 'ifOutDiscards'] as const) cols[c] = await this.walk(OID[c])
    const descr = text(OID.sysDescr)
    // "24-Port 10GBASE-T … with 8 10GE SFP+ Slots": the copper ports come first
    const copper = Number(/(\d+)-Port 10GBASE-T/i.exec(descr)?.[1] ?? Infinity)
    const ports: PortReading[] = []
    for (const [ifIndex, nameV] of cols.ifName) {
      const name = Buffer.isBuffer(nameV) ? nameV.toString('utf8') : String(nameV)
      if (/vlan|loopback|cpu|null/i.test(name)) continue
      const n = Number(/(\d+)\s*$/.exec(name)?.[1] ?? NaN)
      const drops = sum(counter(cols.ifInDiscards.get(ifIndex)), counter(cols.ifOutDiscards.get(ifIndex)))
      ports.push({
        id: ifIndex, name, label: Number.isFinite(n) ? String(n) : name, kind: Number.isFinite(n) && n > copper ? 'sfp' : 'rj45', lane: null,
        up: num(cols.ifOperStatus.get(ifIndex)) === 1, speedMbps: num(cols.ifHighSpeed.get(ifIndex)) || null, mtu: num(cols.ifMtu.get(ifIndex)),
        rxOctets: counter(cols.ifHCInOctets.get(ifIndex)), txOctets: counter(cols.ifHCOutOctets.get(ifIndex)),
        rxErrors: counter(cols.ifInErrors.get(ifIndex)), txErrors: counter(cols.ifOutErrors.get(ifIndex)), drops,
        pauseRx: null, pauseTx: null, fecUncorrected: null, module: null,
      })
    }
    if (this.polls++ % SLOW_EVERY === 0) this.slow = await this.readSlow()
    const health: SwitchHealthReading[] = []
    const cpu = num(sys.get(OID.tpCpu5s))
    const memory = num(sys.get(OID.tpMemory))
    if (cpu !== null) health.push({ label: 'CPU', value: cpu, unit: '%', status: pct(cpu) })
    if (memory !== null) health.push({ label: 'Memory', value: memory, unit: '%', status: pct(memory) })
    const uptime = num(sys.get(OID.sysUpTime))
    return {
      model: text(OID.tpHwVersion).replace(/\s+[\d.]+$/, '') || descr, firmware: text(OID.tpFwVersion), serial: text(OID.tpSerial),
      uptimeS: uptime === null ? null : Math.round(uptime / 100), macs: text(OID.tpMac) ? [mac(text(OID.tpMac))] : [],
      health, ports, ...this.slow,
    }
  }

  private async readSlow(): Promise<{ fdb: Map<string, string>; lldp: Map<string, string> }> {
    const basePorts = await this.walk(OID.basePortIfIndex)
    const ifOf = (bridgePort: string) => {
      const v = basePorts.get(bridgePort)
      return v === undefined ? null : String(v)
    }
    const fdb = new Map<string, string>()
    for (const [idx, bp] of await this.walk(OID.fdbPort)) {
      const port = ifOf(String(bp))
      if (port) fdb.set(idx.split('.').map((o) => Number(o).toString(16).padStart(2, '0')).join(':'), port)
    }
    const lldp = new Map<string, string>()
    for (const [idx, nameV] of await this.walk(OID.lldpRemSysName).catch(() => new Map<string, unknown>())) {
      const port = ifOf(idx.split('.')[1] ?? '')
      const name = Buffer.isBuffer(nameV) ? nameV.toString('utf8') : String(nameV)
      if (port && name) lldp.set(port, name)
    }
    return { fdb, lldp }
  }
}

/** Counter32 arrives as a number, Counter64 as a big-endian Buffer. */
function counter(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (Buffer.isBuffer(v)) {
    let n = 0
    for (const b of v) n = n * 256 + b
    return n
  }
  return null
}

const sum = (a: number | null, b: number | null) => (a === null && b === null ? null : (a ?? 0) + (b ?? 0))
const pct = (v: number): SwitchHealthStatus => (v >= 95 ? 'bad' : v >= 85 ? 'warn' : 'ok')

// ---------- MikroTik RouterOS REST (the CRS804) ----------

/** link monitor (rate, module) is a heavier call: once every few polls */
const MONITOR_EVERY = 4
const REST_TIMEOUT_MS = 8000
/** far above any real reply (a bridge host table of thousands of MACs is well under 1 MB) */
const MAX_REST_BYTES = 16e6

type Row = Record<string, string | undefined>

class RouterOsReader implements SwitchReader {
  private polls = 0
  private monitor = new Map<string, Row>()
  private readonly cfg: SwitchConfig
  constructor(cfg: SwitchConfig) {
    this.cfg = cfg
  }

  close(): void {}

  /**
   * The switch's certificate is self-signed, so it's pinned by its SHA-256 fingerprint. The pin is checked on a
   * bare TLS connection before anything is sent: the request (and the password in it) is only written to a
   * socket whose certificate matched. Without a pin nothing is sent.
   */
  private connect(): Promise<TLSSocket> {
    const hex = (s: string) => s.replace(/:/g, '').toUpperCase()
    const pin = this.cfg.tlsFingerprint ? hex(this.cfg.tlsFingerprint) : ''
    if (!/^[0-9A-F]{64}$/.test(pin)) return Promise.reject(new Error('RouterOS switch needs tlsFingerprint (the certificate\'s SHA-256) in the site config'))
    return new Promise((resolve, reject) => {
      const sock = tlsConnect({ host: this.cfg.host, port: 443, rejectUnauthorized: false, timeout: REST_TIMEOUT_MS })
      sock.once('secureConnect', () => {
        const fp = sock.getPeerCertificate().fingerprint256 ?? ''
        if (hex(fp) === pin) return resolve(sock)
        sock.destroy()
        reject(new Error(`TLS fingerprint ${fp} is not the pinned one`))
      })
      sock.once('timeout', () => sock.destroy(new Error('TLS connect timed out')))
      sock.once('error', reject)
    })
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const sock = await this.connect()
    const password = readFileSync(this.cfg.secretFile, 'utf8').trim()
    const auth = Buffer.from(`${this.cfg.user ?? 'sparkman'}:${password}`).toString('base64')
    const data = body === undefined ? undefined : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request({
        host: this.cfg.host, method, path: `/rest${path}`, timeout: REST_TIMEOUT_MS,
        // the already verified socket (with no agent, so it is used as is)
        createConnection: () => sock,
        headers: { authorization: `Basic ${auth}`, accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_REST_BYTES) return req.destroy(new Error(`${method} ${path}: reply over ${MAX_REST_BYTES / 1e6} MB`))
          chunks.push(c)
        })
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`${method} ${path}: HTTP ${res.statusCode} ${text.slice(0, 120)}`))
          try {
            resolve(text ? JSON.parse(text) : null)
          } catch {
            reject(new Error(`${method} ${path}: not JSON`))
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error(`${method} ${path}: timed out`)))
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  private rows = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Row[]> => {
    const v = await this.call(method, path, body)
    return Array.isArray(v) ? (v as Row[]) : v && typeof v === 'object' ? [v as Row] : []
  }

  async read(): Promise<SwitchReading> {
    const [resource] = await this.rows('GET', '/system/resource')
    const [board] = await this.rows('GET', '/system/routerboard').catch(() => [{} as Row])
    const health = await this.rows('GET', '/system/health').catch(() => [])
    const ifaces = (await this.rows('GET', '/interface')).filter((r) => r.type === 'ether')
    // ethernet counters (pause, drops, FEC); absent when the account can't print stats
    const stats = new Map((await this.rows('POST', '/interface/ethernet/print', { stats: '' }).catch(() => [])).map((r) => [r.name ?? '', r]))
    const running = ifaces.filter((r) => r.running === 'true').map((r) => r.name).filter((n): n is string => !!n)
    if (this.polls++ % MONITOR_EVERY === 0 && running.length) {
      const mon = await this.rows('POST', '/interface/ethernet/monitor', { numbers: running.join(','), once: '' }).catch(() => [])
      this.monitor = new Map(mon.map((r) => [r.name ?? '', r]))
    }
    const hosts = await this.rows('GET', '/interface/bridge/host').catch(() => [])
    const neighbors = await this.rows('GET', '/ip/neighbor').catch(() => [])
    const ports: PortReading[] = []
    for (const r of ifaces) {
      const name = r.name ?? ''
      const m = /^qsfp\d*(?:-dd)?-(\d+)-(\d+)$/.exec(r['default-name'] ?? name)
      const up = r.running === 'true'
      // a cage's other lanes only matter when something runs on them
      if (m && m[2] !== '1' && !up) continue
      const s = stats.get(name) ?? {}
      const mon = up ? this.monitor.get(name) : undefined
      ports.push({
        id: name, name, label: m ? (m[2] === '1' ? m[1] : `${m[1]}·${m[2]}`) : name.replace(/^ether/, 'e'), kind: m ? 'qsfp' : 'mgmt', lane: m ? Number(m[2]) : null,
        up, speedMbps: up ? rateMbps(mon?.rate) : null, mtu: num(r.mtu),
        rxOctets: num(r['rx-byte']), txOctets: num(r['tx-byte']),
        rxErrors: num(r['rx-error']) ?? num(s['rx-fcs-error']), txErrors: num(r['tx-error']),
        drops: sum(num(s['tx-drop-packet']) ?? num(r['tx-drop']), num(s['rx-drop-packet']) ?? num(r['rx-drop'])),
        pauseRx: num(s['rx-pause']), pauseTx: num(s['tx-pause']), fecUncorrected: num(s['rs-fec-uncorrected']),
        module: mon?.['sfp-vendor-name'] ? { vendor: mon['sfp-vendor-name'] ?? '', part: mon['sfp-vendor-part-number'] ?? '', type: mon['sfp-type'] ?? '' } : null,
      })
    }
    const fdb = new Map<string, string>()
    for (const h of hosts) if (h.local !== 'true' && h['mac-address'] && h['on-interface']) fdb.set(mac(h['mac-address']), h['on-interface'])
    const lldp = new Map<string, string>()
    for (const n of neighbors) if (n.interface && n.identity) lldp.set(n.interface.split(',')[0], n.identity)
    return {
      model: board.model ?? resource['board-name'] ?? 'RouterOS', firmware: resource.version ?? '', serial: board['serial-number'] ?? '',
      uptimeS: rosDuration(resource.uptime), macs: ifaces.map((r) => r['mac-address']).filter((m): m is string => !!m).map(mac),
      health: health.map(rosHealth).filter((h): h is SwitchHealthReading => h !== null), ports, fdb, lldp,
    }
  }
}

/** "200Gbps", "10Gbps", "1Gbps", "100Mbps" → Mb/s */
function rateMbps(rate: string | undefined): number | null {
  const m = /^([\d.]+)\s*([GM])bps$/i.exec(rate ?? '')
  return m ? Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1000 : 1) : null
}

/** RouterOS "1w2d03:04:05" or "3h4m5s" → seconds */
function rosDuration(s: string | undefined): number | null {
  if (!s) return null
  let total = 0
  for (const [, n, u] of s.matchAll(/(\d+)([wdhms])/g)) total += Number(n) * { w: 604_800, d: 86_400, h: 3600, m: 60, s: 1 }[u as 'w' | 'd' | 'h' | 'm' | 's']
  const clock = /(\d+):(\d+):(\d+)$/.exec(s)
  if (clock) total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  return total
}

/** /system/health rows ({ name: 'cpu-temperature', value: '42', type: 'C' }) → readings */
function rosHealth(r: Row): SwitchHealthReading | null {
  const name = r.name ?? ''
  if (!name) return null
  const label = name.replace(/^psu(\d)/, 'PSU $1').replace(/^fan(\d)/, 'Fan $1').replace(/^cpu/, 'CPU').replace(/^phy/, 'PHY').replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
  const value = num(r.value)
  const unit = ({ C: '°C', RPM: 'RPM', W: 'W', V: 'V', '%': '%' } as const)[r.type as 'C' | 'RPM' | 'W' | 'V' | '%'] ?? ''
  if (value === null) {
    const state = r.value ?? ''
    return { label, value: null, unit: '', state, status: state === 'ok' ? 'ok' : 'bad' }
  }
  const status: SwitchHealthStatus = unit === '°C' ? (value >= 85 ? 'bad' : value >= 75 ? 'warn' : 'ok') : unit === 'RPM' && /fan/i.test(name) ? (value <= 0 ? 'bad' : 'ok') : 'ok'
  return { label, value, unit, status }
}
