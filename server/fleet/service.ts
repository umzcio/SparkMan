import { createInterface } from 'node:readline'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type {
  ActivityEvent, FleetNode, FleetSummary, GpuProcess, LogLine, LogQueryInput, LogQueryResult, MetricPoint, NodeHealth,
  NodeInventory, NodeLiveStats, NodeStatus, SimEvent, SparkToolEnvelope, TimeRange, Topic,
} from '../../src/api/types.ts'
import type { FleetConfigResolved, FleetHost } from './config.ts'
import type { FleetDb } from './db.ts'
import { LogCollector, type LogStore } from './logs.ts'
import { AlertEngine, type NodeState } from './alerts.ts'
import { UpdateManager } from './updates.ts'
import { CoolingManager } from './cooling.ts'
import { NetworkManager } from './network.ts'
import { DeploymentManager } from './deployments.ts'
import type { GatewayDb } from '../gateway/store.ts'
import { deploymentRates, recentTokensPerSec } from '../gateway/stats.ts'
import { BenchManager, type ResolvedTarget } from '../bench/manager.ts'
import { runToolEval, type ToolEvalOptions } from '../bench/tooleval.ts'
import { SAMPLER_INTERVAL_S, SAMPLER_SCRIPT } from './sampler-script.ts'
import { derivePoint, isFacts, isRawSample, liveStats, type NodeFacts, type RawSample } from './sample.ts'
import { shq, type SshRunner } from './ssh.ts'
import {
  PROCESSES_SCRIPT, firmwareRows, healthChecks, healthStatus, parsePackages, parseProcesses, parseToolOutput, toEnvelope, type ToolOutput,
} from './tools.ts'

/** A node counts as offline when no sample arrived for this long. */
const STALE_MS = 10_000
/** How long a reboot may take before the node is simply "offline". */
const REBOOT_GRACE_MS = 15 * 60_000
const INVENTORY_TTL_MS = 5 * 60_000

export class FleetError extends Error {
  readonly kind: 'not-found' | 'conflict' | 'failed'
  constructor(kind: 'not-found' | 'conflict' | 'failed', message: string) {
    super(message)
    this.kind = kind
  }
}

interface NodeRuntime {
  host: FleetHost
  facts: NodeFacts | null
  prev: RawSample | null
  last: RawSample | null
  point: MetricPoint | null
  lastSeen: number
  child: ChildProcessWithoutNullStreams | null
  retryMs: number
  restartTimer: NodeJS.Timeout | null
  rebootingSince: number | null
  status: NodeStatus
  inventory: { at: number; value: NodeInventory } | null
}

export interface FleetServiceOptions {
  now?: () => number
  /** start the per-node samplers (off in tests) */
  sample?: boolean
  /** journald lines from every box; collected when set */
  logs?: LogStore
  /** where lines older than a week go (an existing directory, normally an NFS mount on a storage host) */
  logArchiveDir?: string
  /** rollouts really apply updates and reboot; otherwise every step is a dry run */
  rolloutApply?: boolean
  /** state shared with the gateway process: routes, keys, request rows */
  gateway?: GatewayDb
  /** tool-eval-bench on this host (the Tool Eval bench is off without it) */
  toolEval?: ToolEvalOptions
  /** drive the rack's front fans through the Pico on USB */
  cooling?: boolean
}

/** The live fleet behind SparkMan's node pages: samplers, history and NVIDIA's tools over SSH. */
export class FleetService {
  private nodes = new Map<string, NodeRuntime>()
  private listeners = new Set<(e: SimEvent) => void>()
  private tickTimer: NodeJS.Timeout | null = null
  private stopped = false
  private now: () => number
  private cfg: FleetConfigResolved
  private db: FleetDb
  private ssh: SshRunner
  private opts: FleetServiceOptions

  constructor(cfg: FleetConfigResolved, db: FleetDb, ssh: SshRunner, opts: FleetServiceOptions = {}) {
    this.cfg = cfg
    this.db = db
    this.ssh = ssh
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.alerts = new AlertEngine(db, () => {
      this.changed('incidents')
      this.changed('activity')
    }, this.now)
    this.alerts.muted = (id) => this.inMaintenance(id)
    this.cooling = opts.cooling
      ? new CoolingManager({
          fanShelf: () => this.cfg.hosts.filter((h) => h.rack.shelf === 1).sort((a, b) => a.rack.slot - b.rack.slot).map((h) => h.id),
          thermal: (id) => {
            const rt = this.nodes.get(id)
            const status = rt ? this.statusOf(rt) : 'offline'
            const live = rt && (status === 'online' || status === 'degraded') ? this.live(rt) : null
            return live ? { gpuTempC: live.gpuTempC, gpuUtil: live.gpuUtil } : null
          },
          away: (id) => {
            const rt = this.nodes.get(id)
            return this.inMaintenance(id) && (!rt || this.statusOf(rt) === 'offline')
          },
          activity: (text) => {
            this.db.addActivity('system', text, null)
            this.changed('activity')
          },
          incident: (ruleId, key, title, detail) => this.alerts.report(ruleId, key, title, detail),
          changed: () => this.changed('cooling'),
        }, db, { now: this.now })
      : null
    this.network = cfg.switches.length
      ? new NetworkManager({
          nodes: () => [...this.nodes.values()].map((rt) => {
            const status = this.statusOf(rt)
            return {
              id: rt.host.id, online: status === 'online' || status === 'degraded', fleetMac: rt.host.mac,
              mgmt: rt.facts?.mgmt ?? null, cx7: rt.facts?.cx7 ?? [], macs: rt.facts?.macs ?? {}, ifaces: rt.last?.ifaces ?? null,
            }
          }),
          incident: (ruleId, key, title, detail) => this.alerts.report(ruleId, key, title, detail),
          changed: () => this.changed('network'),
        }, cfg.switches, { now: this.now, db })
      : null
    this.updates = new UpdateManager({
      nodes: () => [...this.nodes.values()].map((rt) => ({ id: rt.host.id, model: rt.host.model, dgxOs: rt.host.dgxOs, ring: rt.host.ring, status: this.statusOf(rt), maintenance: this.inMaintenance(rt.host.id), busy: this.deployments?.launchers.holding(rt.host.id)?.name })),
      tool: (id, script, args, timeoutMs) => this.tool(this.require(id), script, args, timeoutMs),
      sh: async (id, command, timeoutMs) => {
        const r = await this.ssh.run(this.require(id).host, command, { timeoutMs })
        return { code: r.code, stdout: r.stdout }
      },
      health: (id) => this.getNodeHealth(id),
      reboot: (id) => this.rebootNode(id),
      setOs: (id, version) => {
        const rt = this.nodes.get(id)
        if (rt) rt.host.dgxOs = version
        this.changed('nodes')
      },
      launcherOn: (nodeId) => {
        const l = this.deployments?.launchers.holding(nodeId)
        return l && { id: l.id, name: l.name, nodeIds: l.nodeIds, state: l.state }
      },
      launcherState: (id) => this.deployments?.launchers.list().find((l) => l.id === id)?.state ?? null,
      stopLauncher: async (id) => {
        await this.deployments?.stopDeployment(id)
      },
      startLauncher: async (id) => {
        if (!this.deployments) throw new Error('No gateway: launchers are unavailable')
        await this.deployments.startLauncher(id)
      },
      activity: (kind, text, nodeId) => this.db.addActivity(kind, text, nodeId),
      changed: (topic) => this.changed(topic),
    }, db, { apply: opts.rolloutApply === true, now: this.now })
    const gw = opts.gateway
    this.deployments = gw
      ? new DeploymentManager({
          nodes: () => [...this.nodes.values()].map((rt) => {
            const live = this.live(rt)
            return { id: rt.host.id, ip: rt.host.ip, status: this.statusOf(rt), drained: this.db.get(`drained:${rt.host.id}`) === '1', memoryGB: rt.last?.mem.MemTotal ? Math.round((rt.last.mem.MemTotal * 1024) / 1e9) : 128, memUsedGB: live?.memUsedGB ?? null, reported: rt.last !== null }
          }),
          groups: () => this.cfg.groups,
          sh: async (id, command, o) => {
            const r = await this.ssh.run(this.require(id).host, command, { timeoutMs: o?.timeoutMs, input: o?.input })
            return { code: r.code, stdout: r.stdout }
          },
          activity: (text, nodeId) => this.db.addActivity('deploy', text, nodeId),
          changed: (topic) => this.changed(topic),
        }, db, gw, { now: this.now, rates: () => deploymentRates(gw, this.now()) })
      : null
    // each deployment's live rate (its engine's token counter, else its finished gateway requests); the gateway's own
    // figure only counts a request once it ends, so it reads 0 while long requests stream
    if (gw) this.tokensPerSec = () => this.deployments?.list().reduce((s, d) => s + d.tokensPerSec, 0) ?? recentTokensPerSec(gw, this.now())
    const te = opts.toolEval
    this.benches = gw && this.deployments
      ? new BenchManager({
          resolve: (input) => this.resolveBench(input),
          changed: () => this.changed('benchmarks'),
          activity: (text, nodeId) => this.db.addActivity('bench', text, nodeId),
          ...(te ? { toolEval: (t: ResolvedTarget, suite: 'quick' | 'full', runId: string, signal: AbortSignal, onProgress: Parameters<typeof runToolEval>[5]) => runToolEval(te, t, suite, runId, signal, onProgress) } : {}),
        }, db, this.now)
      : null
    for (const host of cfg.hosts) {
      this.nodes.set(host.id, {
        host, facts: null, prev: null, last: null, point: null, lastSeen: 0, child: null, retryMs: 2000, restartTimer: null,
        rebootingSince: null, status: 'offline', inventory: null,
      })
    }
  }

  readonly alerts: AlertEngine
  readonly updates: UpdateManager
  readonly cooling: CoolingManager | null
  /** the switches' read-only view (null without `switches` in the site config) */
  readonly network: NetworkManager | null
  readonly deployments: DeploymentManager | null
  readonly benches: BenchManager | null
  private logCollector: LogCollector | null = null
  private archiveTimer: NodeJS.Timeout | null = null
  private archiving = false
  /** live log lines (the alert engine watches for Xid errors) */
  private logListeners = new Set<(l: LogLine) => void>()

  start(): void {
    if (this.opts.sample !== false) for (const rt of this.nodes.values()) this.startSampler(rt)
    this.tickTimer = setInterval(() => this.tick(), SAMPLER_INTERVAL_S * 1000)
    if (this.opts.sample !== false) {
      this.updates.start()
      this.deployments?.start()
      this.cooling?.start()
      this.network?.start()
    }
    if (this.opts.logs && this.opts.sample !== false) {
      this.logCollector = new LogCollector(this.opts.logs, this.ssh, (l) => {
        this.alerts.onLog(l)
        for (const fn of this.logListeners) fn(l)
      })
      this.logCollector.start(this.cfg.hosts)
      if (this.opts.logArchiveDir) {
        this.archiveTimer = setInterval(() => void this.archiveLogs(), 3_600_000)
        setTimeout(() => void this.archiveLogs(), 60_000)
      }
    }
  }

  onLogLine(fn: (l: LogLine) => void): () => void {
    this.logListeners.add(fn)
    return () => this.logListeners.delete(fn)
  }

  /** Hourly: move days older than a week to the archive. */
  async archiveLogs(): Promise<void> {
    if (!this.opts.logs || !this.opts.logArchiveDir || this.archiving) return
    this.archiving = true
    try {
      const r = await this.opts.logs.archive(this.opts.logArchiveDir, this.now())
      if ('skipped' in r) {
        const key = `log-archive-skip:${new Date(this.now()).toISOString().slice(0, 10)}`
        if (!this.db.get(key)) {
          this.db.set(key, '1')
          this.db.addActivity('system', `Log archive skipped: ${r.skipped}`, null)
          this.changed('activity')
        }
      } else if (r.files > 0) {
        this.db.addActivity('system', `Archived ${r.lines.toLocaleString('en-US')} log lines (${r.files} files) to ${this.opts.logArchiveDir}`, null)
        this.changed('activity')
      }
    } catch (e) {
      console.error('[fleet] log archive failed', e)
    } finally {
      this.archiving = false
    }
  }

  queryLogs(input: LogQueryInput): LogQueryResult {
    if (!this.opts.logs) throw new FleetError('not-found', 'Log collection is off on this host')
    return this.opts.logs.query(input, this.now(), this.alerts.bands())
  }

  stop(): void {
    this.stopped = true
    if (this.tickTimer) clearInterval(this.tickTimer)
    if (this.archiveTimer) clearInterval(this.archiveTimer)
    this.updates.stop()
    this.deployments?.stop()
    this.cooling?.stop()
    this.network?.stop()
    this.logCollector?.stop()
    this.opts.logs?.close()
    for (const rt of this.nodes.values()) {
      if (rt.restartTimer) clearTimeout(rt.restartTimer)
      rt.child?.kill()
    }
    this.ssh.close()
  }

  subscribe(listener: (e: SimEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(e: SimEvent): void {
    for (const l of this.listeners) l(e)
  }

  private changed(topic: Topic): void {
    this.emit({ type: 'changed', topic })
  }

  private tick(): void {
    let statusChanged = false
    for (const rt of this.nodes.values()) {
      const s = this.statusOf(rt)
      if (s !== rt.status) {
        if (rt.status === 'rebooting' && s === 'online') this.db.addActivity('reboot', `${rt.host.id} is back online`, rt.host.id)
        else if (s === 'offline' && rt.status !== 'rebooting') this.db.addActivity('system', `${rt.host.id} stopped reporting`, rt.host.id)
        rt.status = s
        statusChanged = true
      }
    }
    if (statusChanged) {
      this.changed('nodes')
      this.changed('activity')
    }
    if (this.opts.sample !== false) this.alerts.evaluate(this.nodeStates())
    this.emit({ type: 'tick', now: this.now() })
  }

  // ---------- samplers ----------

  private startSampler(rt: NodeRuntime): void {
    if (this.stopped) return
    const child = this.ssh.stream(rt.host, 'python3 -u -', SAMPLER_SCRIPT)
    rt.child = child
    const lines = createInterface({ input: child.stdout })
    let stall: NodeJS.Timeout | null = null
    const armStall = () => {
      if (stall) clearTimeout(stall)
      stall = setTimeout(() => child.kill(), STALE_MS + 5000)
    }
    armStall()
    lines.on('line', (line) => {
      let v: unknown
      try {
        v = JSON.parse(line)
      } catch {
        return
      }
      armStall()
      if (isFacts(v)) {
        rt.facts = v.facts
        rt.prev = null
        rt.retryMs = 2000
        return
      }
      if (isRawSample(v) && rt.facts) this.onSample(rt, v)
    })
    child.stderr.resume()
    child.on('close', () => {
      if (stall) clearTimeout(stall)
      rt.child = null
      if (this.stopped) return
      rt.restartTimer = setTimeout(() => this.startSampler(rt), rt.retryMs)
      rt.retryMs = Math.min(rt.retryMs * 2, 60_000)
    })
  }

  private onSample(rt: NodeRuntime, s: RawSample): void {
    const at = this.now()
    const point = derivePoint(rt.prev, s, rt.facts!, at)
    rt.prev = s
    rt.last = s
    rt.point = point
    rt.lastSeen = at
    // a fresh boot (uptime shorter than the time since we asked) ends "rebooting"
    if (rt.rebootingSince !== null && s.up * 1000 < at - rt.rebootingSince + 30_000) rt.rebootingSince = null
    if (point.cpuUser !== null) this.db.addSample(rt.host.id, point)
  }

  private statusOf(rt: NodeRuntime): NodeStatus {
    const now = this.now()
    if (rt.rebootingSince !== null) {
      if (now - rt.rebootingSince < REBOOT_GRACE_MS) return 'rebooting'
      rt.rebootingSince = null
    }
    if (!rt.last || now - rt.lastSeen > STALE_MS) return 'offline'
    const live = this.live(rt)
    if (live && (live.throttling || live.gpuTempC > 85)) return 'degraded'
    return 'online'
  }

  private live(rt: NodeRuntime): NodeLiveStats | null {
    return rt.point && rt.last ? liveStats(rt.point, rt.last) : null
  }

  // ---------- nodes ----------

  private require(id: string): NodeRuntime {
    const rt = this.nodes.get(id)
    if (!rt) throw new FleetError('not-found', `Unknown node ${id}`)
    return rt
  }

  private toNode(rt: NodeRuntime): FleetNode {
    const status = this.statusOf(rt)
    const s = rt.last
    const memoryGB = s?.mem.MemTotal ? Math.round((s.mem.MemTotal * 1024) / 1e9) : 128
    return {
      id: rt.host.id,
      hostname: rt.host.id,
      model: rt.host.model,
      ip: rt.host.ip,
      status,
      drained: this.db.get(`drained:${rt.host.id}`) === '1',
      maintenance: this.inMaintenance(rt.host.id),
      os: { dgxOs: rt.host.dgxOs, kernel: rt.facts?.kernel ?? '', driver: rt.facts?.driver ?? '', cuda: rt.facts?.cuda ?? '', uefi: rt.host.uefi },
      memoryGB,
      cpuCores: rt.facts?.cpus ?? 20,
      diskGB: s ? Math.round(s.fs[0] / 1e9) : 0,
      assetTag: rt.host.assetTag,
      serial: rt.host.serial,
      bootedAt: s ? rt.lastSeen - s.up * 1000 : 0,
      lastSeen: rt.lastSeen,
      ...(this.deployments?.nodeDeployment(rt.host.id) ?? { deploymentId: null, groupId: null }),
      rack: rt.host.rack,
      live: status === 'online' || status === 'degraded' ? this.live(rt) : null,
    }
  }

  listNodes(): FleetNode[] {
    return [...this.nodes.values()].map((rt) => this.toNode(rt)).sort((a, b) => a.rack.shelf - b.rack.shelf || a.rack.slot - b.rack.slot)
  }

  getNode(id: string): FleetNode | null {
    const rt = this.nodes.get(id)
    return rt ? this.toNode(rt) : null
  }

  getNodeMetrics(id: string, range: TimeRange): MetricPoint[] {
    const rt = this.require(id)
    const points = this.db.series(id, range, this.now())
    // series points are step-aligned; append the newest sample so live tiles react within one tick
    if (rt.point && rt.point.cpuUser !== null && rt.point.t > points[points.length - 1].t) points.push(rt.point)
    return points
  }

  private reachable(rt: NodeRuntime): void {
    const s = this.statusOf(rt)
    if (s === 'offline' || s === 'rebooting') throw new FleetError('conflict', `${rt.host.id} is ${s}`)
  }

  private async tool(rt: NodeRuntime, script: string, args: string[], timeoutMs = 120_000): Promise<{ out: ToolOutput | null; rc: number; ms: number }> {
    const started = this.now()
    const cmd = `sudo -n python3 ${shq(`${this.cfg.toolsDir}/bin/${script}`)} ${args.map(shq).join(' ')}`
    const r = await this.ssh.run(rt.host, cmd, { timeoutMs })
    return { out: parseToolOutput(r.stdout), rc: r.code, ms: this.now() - started }
  }

  async getNodeProcesses(id: string): Promise<GpuProcess[]> {
    const rt = this.require(id)
    this.reachable(rt)
    const r = await this.ssh.run(rt.host, 'sudo -n bash -s', { input: PROCESSES_SCRIPT, timeoutMs: 20_000 })
    return parseProcesses(r.stdout)
  }

  async getNodeInventory(id: string): Promise<NodeInventory> {
    const rt = this.require(id)
    if (rt.inventory && this.now() - rt.inventory.at < INVENTORY_TTL_MS) return rt.inventory.value
    this.reachable(rt)
    const [fw, pk] = await Promise.all([
      this.tool(rt, 'firmware_reporter.py', ['--print']),
      this.ssh.run(rt.host, "dpkg-query -W -f='${Package}\\t${Version}\\n'", { timeoutMs: 30_000 }),
    ])
    const firmware = firmwareRows(fw.out?.data ?? null)
    const packages = parsePackages(pk.stdout)
    const value: NodeInventory = {
      firmware,
      packages,
      envelope: toEnvelope('firmware_reporter.py', id, fw.out, fw.rc, fw.ms, { components: firmware.length, packages: packages.length }),
    }
    rt.inventory = { at: this.now(), value }
    return value
  }

  async getNodeHealth(id: string): Promise<NodeHealth> {
    const rt = this.require(id)
    const node = this.toNode(rt)
    let updateStatus: Record<string, unknown> | null = null
    let diag: Record<string, unknown> | null = null
    let diagRun: Awaited<ReturnType<FleetService['tool']>> | null = null
    if (node.status !== 'offline' && node.status !== 'rebooting') {
      const [u, d] = await Promise.all([this.tool(rt, 'spark_updatectl.py', ['status'], 60_000), this.tool(rt, 'spark_diagctl.py', ['health'], 60_000)])
      updateStatus = u.out?.data ?? null
      diag = d.out?.data ?? null
      diagRun = d
    }
    const checks = healthChecks({ live: node.live, memoryGB: node.memoryGB, diskGB: node.diskGB, facts: rt.facts, sample: rt.last, updateStatus, diag })
    const flagged = checks.filter((c) => c.status !== 'pass').map((c) => `${c.name}: ${c.detail}`)
    const envelope = toEnvelope('spark_diagctl.py', id, diagRun?.out ?? null, diagRun?.rc ?? 255, diagRun?.ms ?? 0, {
      level: 'L1', checks: checks.length, failed: checks.filter((c) => c.status === 'fail').length, warned: checks.filter((c) => c.status === 'warn').length,
    }, flagged)
    if (diagRun) envelope.status = envelope.status === 'error' ? 'error' : healthStatus(checks)
    return { checks, envelope }
  }

  async rebootNode(id: string): Promise<void> {
    const rt = this.require(id)
    this.reachable(rt)
    const plan = await this.tool(rt, 'spark_updatectl.py', ['reboot', 'plan', '--reason', 'SparkMan operator reboot'], 30_000)
    const data = plan.out?.data as { safe_to_proceed?: boolean; block_reasons?: string[] } | undefined
    if (!plan.out?.ok || data?.safe_to_proceed === false) {
      throw new FleetError('conflict', `Reboot blocked on ${id}: ${(data?.block_reasons ?? []).join('; ') || 'spark_updatectl reboot plan failed'}`)
    }
    // --delay-sec lets the SSH command return before the box goes down
    void this.tool(rt, 'spark_updatectl.py', ['reboot', 'now', '--reason', 'SparkMan operator reboot', '--delay-sec', '3'], 30_000).catch(() => undefined)
    rt.rebootingSince = this.now()
    rt.status = 'rebooting'
    rt.inventory = null
    this.db.addActivity('reboot', `Reboot requested for ${id}`, id)
    this.changed('nodes')
    this.changed('activity')
  }

  inMaintenance(id: string): boolean {
    return this.db.get(`maintenance:${id}`) === '1'
  }

  /** Maintenance mutes the node's alerts, keeps rollouts off it and drains it; leaving undrains it. */
  setNodeMaintenance(id: string, on: boolean): void {
    this.require(id)
    this.db.set(`maintenance:${id}`, on ? '1' : null)
    this.db.set(`drained:${id}`, on ? '1' : null)
    void this.deployments?.refresh()
    this.db.addActivity('maintenance', `${id} ${on ? 'entered maintenance: alerts muted, drained' : 'left maintenance'}`, id)
    this.alerts.evaluate(this.nodeStates())
    this.changed('nodes')
    this.changed('incidents')
    this.changed('activity')
  }

  setNodeDrained(id: string, drained: boolean): void {
    this.require(id)
    this.db.set(`drained:${id}`, drained ? '1' : null)
    // drained nodes leave the gateway's routes at once
    void this.deployments?.refresh()
    this.db.addActivity('drain', `${id} ${drained ? 'drained' : 'returned to service'}`, id)
    this.changed('nodes')
    this.changed('activity')
  }

  async runDiagnostics(id: string): Promise<SparkToolEnvelope> {
    const rt = this.require(id)
    this.reachable(rt)
    const h = await this.getNodeHealth(id)
    this.db.addActivity('diag', `Diagnostics on ${id}: ${h.envelope.status}`, id)
    this.changed('activity')
    return h.envelope
  }

  async collectBundle(id: string): Promise<SparkToolEnvelope> {
    const rt = this.require(id)
    this.reachable(rt)
    const r = await this.tool(rt, 'spark_diagctl.py', ['collect-all', '--tarball'], 10 * 60_000)
    if (!r.out) throw new FleetError('failed', `spark_diagctl collect-all printed no result on ${id} (exit ${r.rc})`)
    const env = toEnvelope('spark_diagctl.py', id, r.out, r.rc, r.ms, { level: 'L2', mode: 'collect-all' })
    this.db.addActivity('diag', `L2 bundle collected on ${id}${env.artifacts[0] ? `: ${env.artifacts[0]}` : ''}`, id)
    this.changed('activity')
    return env
  }

  // ---------- fleet ----------

  /** tokens/s comes from the gateway once it is attached */
  tokensPerSec: () => number = () => 0

  nodeStates(): NodeState[] {
    return [...this.nodes.values()].map((rt) => {
      const status = this.statusOf(rt)
      return { id: rt.host.id, status, live: status === 'online' || status === 'degraded' ? this.live(rt) : null, sample: rt.last }
    })
  }

  getFleetSummary(): FleetSummary {
    const nodes = this.listNodes()
    const live = nodes.flatMap((n) => (n.live ? [n.live] : []))
    return {
      online: nodes.filter((n) => n.status === 'online' || n.status === 'degraded').length,
      total: nodes.length,
      gpuUtilAvg: live.length ? live.reduce((a, l) => a + l.gpuUtil, 0) / live.length : 0,
      memUsedGB: live.reduce((a, l) => a + l.memUsedGB, 0),
      memTotalGB: nodes.reduce((a, n) => a + n.memoryGB, 0),
      powerW: live.reduce((a, l) => a + l.gpuPowerW, 0),
      tokensPerSec: this.tokensPerSec(),
      activeIncidents: this.alerts.activeCount(),
    }
  }

  /** Areas this backend serves (the UI turns their pages live). */
  liveAreas(): string[] {
    return ['nodes', 'alerts', 'updates', ...(this.opts.logs ? ['logs'] : []), ...(this.opts.gateway ? ['deployments', 'gateway', 'usage', 'keys', 'benchmarks'] : []), ...(this.cooling ? ['cooling'] : []), ...(this.network ? ['network'] : []), ...this.extraAreas]
  }

  /** areas added by the other backends as they attach (alerts, updates, gateway, …) */
  extraAreas: string[] = []

  getFleetConfig() {
    return { sshUser: this.cfg.sshUser, sshKeyPath: this.cfg.sshKeyPath, hosts: this.cfg.hosts.map((h) => ({ id: h.id, ip: h.ip })) }
  }

  /** A gateway key the benches use for gateway-scope runs (created once, kept in the fleet db). */
  private benchKey(): string {
    const gw = this.opts.gateway!
    const saved = this.db.get('bench-key')
    if (saved) {
      const { id, secret } = JSON.parse(saved) as { id: string; secret: string }
      if (gw.listKeys().some((k) => k.id === id && k.revokedAt === null)) return secret
    }
    const created = gw.createKey('SparkMan benchmarks', 100_000)
    this.db.set('bench-key', JSON.stringify({ id: created.key.id, secret: created.secret }))
    return created.secret
  }

  private resolveBench(input: Parameters<BenchManager['start']>[0]): ResolvedTarget {
    const gw = this.opts.gateway!
    const dep = this.deployments!.list().find((d) => d.id === input.deploymentId)
    if (!dep) throw new FleetError('not-found', 'Deployment not found')
    if (dep.status !== 'serving' && dep.status !== 'degraded') throw new FleetError('conflict', `${dep.model} is ${dep.status}`)
    const routes = Object.entries(gw.routes().models).flatMap(([name, ts]) => ts.filter((t) => t.deploymentId === dep.id).map((t) => ({ name, t })))
    if (!routes.length) throw new FleetError('conflict', `${dep.model} has no route (drained or offline nodes?)`)
    const base = { deploymentId: dep.id, engine: dep.engine, quant: dep.quant, contextLength: dep.contextLength }
    if (input.scope === 'gateway') {
      return { ...base, baseUrl: `http://127.0.0.1:${process.env.SPARKMAN_GATEWAY_PORT ?? 4200}/v1`, model: routes[0].name, apiKey: this.benchKey(), nodeId: 'gateway', nodeIds: dep.replicas.flatMap((r) => r.nodeIds) }
    }
    const replica = dep.replicas.find((r) => r.nodeIds.includes(input.nodeId)) ?? dep.replicas[0]
    const route = routes.find((r) => r.t.nodeIds[0] === replica.nodeIds[0]) ?? routes[0]
    return { ...base, baseUrl: route.t.baseUrl, model: route.t.upstreamModel, nodeId: replica.nodeIds[0], nodeIds: replica.nodeIds }
  }

  recordActivity(kind: ActivityEvent['kind'], text: string, nodeId: string | null = null): void {
    this.db.addActivity(kind, text, nodeId)
    this.changed('activity')
    if (kind === 'key') this.changed('keys')
  }

  listActivity(limit = 50): ActivityEvent[] {
    return this.db.activity(limit)
  }
}
