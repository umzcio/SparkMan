import type { AlertRule, Incident, IncidentSeverity, LogIncidentBand, LogLine, NodeLiveStats, NodeStatus } from '../../src/api/types.ts'
import type { FleetDb } from './db.ts'
import type { RawSample } from './sample.ts'

/** What the engine sees of a node each tick. */
export interface NodeState {
  id: string
  status: NodeStatus
  live: NodeLiveStats | null
  sample: RawSample | null
}

interface RuleDef extends Omit<AlertRule, 'enabled'> {
  defaultEnabled: boolean
  /** seconds the condition must hold before an incident opens */
  holdS: number
  /** per-node check: a detail string while the condition holds, null otherwise */
  check?: (n: NodeState, ctx: RuleContext) => string | null
  title: (nodeId: string) => string
}

interface RuleContext {
  /** ConnectX-7 netdevs seen up on this node since SparkMan started */
  everUp: Set<string>
}

export const RULES: RuleDef[] = [
  {
    id: 'rule-offline', name: 'Node offline', condition: 'no sample for 60 s (not during a requested reboot)', severity: 'critical', defaultEnabled: true, holdS: 60,
    check: (n) => (n.status === 'offline' ? 'No telemetry over SSH' : null),
    title: (id) => `${id} offline`,
  },
  {
    id: 'rule-gpu-temp', name: 'GPU temperature high', condition: 'gpu_temp ≥ 85 °C for 2 min', severity: 'warning', defaultEnabled: true, holdS: 120,
    check: (n) => (n.live && n.live.gpuTempC >= 85 ? `GPU ${Math.round(n.live.gpuTempC)} °C` : null),
    title: (id) => `${id} GPU running hot`,
  },
  {
    id: 'rule-throttle', name: 'GPU clocks throttled', condition: 'thermal or hardware slowdown for 2 min', severity: 'warning', defaultEnabled: true, holdS: 120,
    check: (n) => (n.live?.throttling ? `Clocks throttled at GPU ${Math.round(n.live.gpuTempC)} °C` : null),
    title: (id) => `${id} thermal throttling`,
  },
  {
    id: 'rule-xid', name: 'GPU Xid error', condition: 'kernel log matches NVRM: Xid (clears after 30 min without one)', severity: 'critical', defaultEnabled: true, holdS: 0,
    title: (id) => `${id} GPU Xid error`,
  },
  {
    id: 'rule-cx7', name: 'ConnectX-7 link down', condition: 'a QSFP link that was up goes down for 30 s', severity: 'critical', defaultEnabled: true, holdS: 30,
    check: (n, ctx) => {
      const links = n.sample?.links
      if (!links || n.status === 'offline' || n.status === 'rebooting') return null
      const down = [...ctx.everUp].filter((i) => links[i] !== undefined && links[i] !== 'up')
      return down.length ? `${down.join(', ')} down` : null
    },
    title: (id) => `${id} ConnectX-7 link down`,
  },
  {
    id: 'rule-disk', name: 'Disk almost full', condition: 'disk_used ≥ 90 %', severity: 'warning', defaultEnabled: true, holdS: 60,
    check: (n) => (n.live && n.live.diskUsedPct >= 90 ? `Root disk ${Math.round(n.live.diskUsedPct)}% used` : null),
    title: (id) => `${id} disk almost full`,
  },
  {
    id: 'rule-memory', name: 'Unified memory exhausted', condition: 'MemAvailable < 2 GB for 5 min', severity: 'warning', defaultEnabled: true, holdS: 300,
    check: (n) => {
      const m = n.sample?.mem
      if (!m?.MemAvailable || n.status === 'offline') return null
      const availGB = (m.MemAvailable * 1024) / 1e9
      return availGB < 2 ? `${availGB.toFixed(1)} GB available` : null
    },
    title: (id) => `${id} out of unified memory`,
  },
  {
    id: 'rule-nvme-temp', name: 'NVMe temperature high', condition: 'nvme ≥ 75 °C for 5 min', severity: 'warning', defaultEnabled: true, holdS: 300,
    check: (n) => {
      const t = n.sample?.hwmon.nvme ?? []
      const c = t.length ? Math.max(...t) / 1000 : 0
      return c >= 75 ? `NVMe ${Math.round(c)} °C` : null
    },
    title: (id) => `${id} NVMe running hot`,
  },
  // fleet-level: the cooling loop reports these (CoolingManager)
  {
    id: 'rule-cooling-link', name: 'Cooling controller offline', condition: 'no report from the fan Pico for 30 s', severity: 'critical', defaultEnabled: true, holdS: 0,
    title: () => 'Cooling controller offline',
  },
  {
    id: 'rule-fan-stall', name: 'Fan stalled', condition: 'a fan driven at ≥ 20 % reads ~0 RPM for 15 s', severity: 'critical', defaultEnabled: true, holdS: 0,
    title: (id) => `${id} stalled`,
  },
  // fleet-level: the network page's switch poller reports these (NetworkManager)
  {
    id: 'rule-switch-down', name: 'Switch unreachable', condition: 'a switch misses 2 polls in a row (30 s)', severity: 'critical', defaultEnabled: true, holdS: 0,
    title: (id) => `${id} unreachable`,
  },
  {
    id: 'rule-switch-port', name: 'Node link below speed', condition: "a node's switch port runs below its expected speed for 60 s", severity: 'warning', defaultEnabled: true, holdS: 0,
    title: (id) => `${id} link slow`,
  },
]

const XID_QUIET_MS = 30 * 60_000
const KEEP_INCIDENTS = 500

/** Built-in rules over live telemetry and the kernel log; incidents persist in SQLite. */
export class AlertEngine {
  private db: FleetDb
  private now: () => number
  private since = new Map<string, number>()
  private everUp = new Map<string, Set<string>>()
  private lastXid = new Map<string, number>()
  private onChange: () => void
  /** nodes in maintenance: no new incidents, open ones close */
  muted: (nodeId: string) => boolean = () => false

  constructor(db: FleetDb, onChange: () => void, now: () => number = Date.now) {
    this.db = db
    this.onChange = onChange
    this.now = now
    db.db.exec('CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, started INTEGER NOT NULL, open INTEGER NOT NULL, data TEXT NOT NULL)')
  }

  rules(): AlertRule[] {
    return RULES.map((r) => ({ id: r.id, name: r.name, condition: r.condition, severity: r.severity, enabled: this.enabled(r.id) }))
  }

  private enabled(id: string): boolean {
    const v = this.db.get(`rule:${id}`)
    return v === null ? (RULES.find((r) => r.id === id)?.defaultEnabled ?? false) : v === '1'
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!RULES.some((r) => r.id === id)) throw new Error(`Unknown rule ${id}`)
    this.db.set(`rule:${id}`, enabled ? '1' : '0')
    // a disabled rule's open incidents close with it
    if (!enabled) for (const inc of this.open().filter((i) => i.ruleId === id)) this.resolve(inc, 'Rule disabled')
    this.onChange()
  }

  list(): Incident[] {
    const rows = this.db.db.prepare('SELECT data FROM incidents ORDER BY started DESC LIMIT ?').all(KEEP_INCIDENTS) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Incident)
  }

  private open(): Incident[] {
    return (this.db.db.prepare('SELECT data FROM incidents WHERE open = 1').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Incident)
  }

  activeCount(): number {
    return (this.db.db.prepare('SELECT count(*) AS n FROM incidents WHERE open = 1').get() as { n: number }).n
  }

  /** Incident windows for the log histogram. */
  bands(): LogIncidentBand[] {
    const now = this.now()
    return this.list().map((i) => ({ from: i.startedAt, to: i.resolvedAt ?? now, label: i.title }))
  }

  private save(inc: Incident): void {
    this.db.db
      .prepare('INSERT OR REPLACE INTO incidents (id, started, open, data) VALUES (?, ?, ?, ?)')
      .run(inc.id, inc.startedAt, inc.status === 'ongoing' ? 1 : 0, JSON.stringify(inc))
  }

  private openIncident(ruleId: string, severity: IncidentSeverity, nodeId: string | null, title: string, detail: string): void {
    const now = this.now()
    const id = `inc-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    this.save({ id, title, severity, status: 'ongoing', nodeId, ruleId, startedAt: now, resolvedAt: null, timeline: [{ ts: now, text: detail }] })
    this.db.addActivity('alert', `${title}: ${detail}`, nodeId)
    this.onChange()
  }

  private resolve(inc: Incident, why: string): void {
    const now = this.now()
    inc.status = 'resolved'
    inc.resolvedAt = now
    inc.timeline.push({ ts: now, text: why })
    this.save(inc)
    this.db.addActivity('alert', `${inc.title} resolved`, inc.nodeId)
  }

  resolveById(id: string): void {
    const inc = this.open().find((i) => i.id === id)
    if (!inc) throw new Error('No ongoing incident with that id')
    this.resolve(inc, 'Resolved by operator')
    this.since.delete(`${inc.ruleId}|${inc.nodeId}`)
    this.onChange()
  }

  /** Every tick: open incidents for conditions that held long enough, resolve the ones that cleared. */
  evaluate(nodes: NodeState[]): void {
    const now = this.now()
    const open = this.open()
    let changed = false
    for (const n of nodes) {
      if (this.muted(n.id)) {
        for (const inc of open.filter((i) => i.nodeId === n.id)) {
          this.resolve(inc, 'Node in maintenance')
          changed = true
        }
        for (const rule of RULES) this.since.delete(`${rule.id}|${n.id}`)
        continue
      }
      const up = this.everUp.get(n.id) ?? new Set<string>()
      for (const [i, s] of Object.entries(n.sample?.links ?? {})) if (s === 'up') up.add(i)
      this.everUp.set(n.id, up)
      for (const rule of RULES) {
        if (!rule.check || !this.enabled(rule.id)) continue
        const key = `${rule.id}|${n.id}`
        const detail = rule.check(n, { everUp: up })
        const current = open.find((i) => i.ruleId === rule.id && i.nodeId === n.id)
        if (detail) {
          const t0 = this.since.get(key) ?? now
          this.since.set(key, t0)
          if (!current && now - t0 >= rule.holdS * 1000) {
            this.openIncident(rule.id, rule.severity, n.id, rule.title(n.id), detail)
            changed = true
          }
        } else {
          this.since.delete(key)
          if (current) {
            this.resolve(current, 'Condition cleared')
            changed = true
          }
        }
      }
    }
    for (const inc of open.filter((i) => i.ruleId === 'rule-xid')) {
      if (now - (this.lastXid.get(inc.nodeId ?? '') ?? inc.startedAt) > XID_QUIET_MS) {
        this.resolve(inc, 'No Xid for 30 min')
        changed = true
      }
    }
    if (changed) this.onChange()
  }

  /** last state reported per fleet-level condition, so a steady one costs no query */
  private external = new Map<string, boolean>()

  /** A condition that isn't about one box (the cooling controller, a fan): open with a detail, clear with null. */
  report(ruleId: string, key: string, title: string, detail: string | null): void {
    const k = `${ruleId}|${key}`
    const on = detail !== null && this.enabled(ruleId)
    if (this.external.get(k) === on) return
    this.external.set(k, on)
    const current = this.open().find((i) => i.ruleId === ruleId && i.nodeId === null && i.title === title)
    if (on && !current) this.openIncident(ruleId, RULES.find((r) => r.id === ruleId)?.severity ?? 'warning', null, title, detail)
    else if (!on && current) {
      this.resolve(current, 'Condition cleared')
      this.onChange()
    }
  }

  /** Kernel lines: an Xid opens (or extends) the node's Xid incident. */
  onLog(l: LogLine): void {
    if (l.source !== 'kernel' || !l.attributes.xid || !this.enabled('rule-xid') || this.muted(l.host)) return
    // backfilled history doesn't open incidents
    if (this.now() - l.ts > XID_QUIET_MS) return
    this.lastXid.set(l.host, l.ts)
    const current = this.open().find((i) => i.ruleId === 'rule-xid' && i.nodeId === l.host)
    if (current) {
      if (current.timeline.length < 50) {
        current.timeline.push({ ts: l.ts, text: `Xid ${l.attributes.xid}: ${l.message.slice(0, 160)}` })
        this.save(current)
        this.onChange()
      }
      return
    }
    this.openIncident('rule-xid', 'critical', l.host, `${l.host} GPU Xid ${l.attributes.xid}`, l.message.slice(0, 200))
  }
}
