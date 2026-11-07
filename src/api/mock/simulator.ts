import { validatePolicy, type CoolingPolicy, type Thermal } from '@/lib/cooling'
import { parseLogQuery } from '@/lib/log-query'
import { BENCH_KIND_LABEL, CONCURRENCY_OPTIONS, CONTEXT_SIZES, MAX_TOKENS_RANGE, QUALITY_CATEGORIES, fittingContextSizes } from '@/lib/bench'
import type {
  ActivityEvent, ActivityKind, AlertRule, ApiKey, BenchConfig, BenchKind, BenchRun, BenchScope, BenchRunFilter, BenchStatus, CoolingPoint, CoolingState, CreateDeploymentInput, Deployment, DeploymentStatus, FailureInjection,
  FirmwareUpdate, FleetNode, FleetSummary, GatewayInfo, GatewayPoint, GatewayRoute, GpuProcess, HealthCheck, Incident,
  Launcher, LauncherInput, LauncherState, LogQueryInput, LogQueryResult, MetricPoint, NodeHealth, NodeInventory, NodeStatus, NodeUpdateStatus, OsInfo, Rollout,
  Replica, RolloutStep, SimEvent, SparkToolEnvelope, StartBenchInput, StartRolloutInput, TimeRange, Topic, UsageReport,
} from '../types'
import { GATEWAY_TARGET } from '../types'
import { CoolingSim } from './cooling'
import { partialResult, planBench, planGatewayBench, type BenchPlan } from './bench'
import {
  ACTIVITY_SPECS, ALERT_RULES, APT_PENDING, BASE_OS, DEPLOYMENT_SPECS, ENGINE_PORT, FIRMWARE_PENDING, FLEET_CONFIG,
  GATEWAY_BASE_URL, INCIDENT_SPECS, KEY_SPECS, MODEL_CATALOG, NODE_SPECS, PACKAGES, RINGS, ROLLOUT_HISTORY, SIM_SEED,
  TARGET_OS, type DeploymentSpec, type NodeSpec,
} from './fixtures'
import { logHistogram, queryLogs, type LogWindow, type LogWorld } from './logs'
import {
  RANGE_MS, deploymentLoad, gatewayPoint, gatewaySeries, isOffline, nodeSeries, sampleNode, usageReport,
  type MetricWorld, type Outage,
} from './metrics'
import { hash, mulberry32, noise } from './rng'

export const REBOOT_MS = 20_000
export const DEPLOY_PENDING_MS = 3_000
export const DEPLOY_LOADING_MS = 15_000
export const ROLLOUT_STEP_MS = 4_000
/** finished runs kept per node + model + bench kind */
export const BENCH_HISTORY_LIMIT = 20

export type SimErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable'

export class SimError extends Error {
  code: SimErrorCode
  constructor(code: SimErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'SimError'
  }
}

interface NodeRuntime {
  drained: boolean
  maintenance: boolean
  bootedAt: number
  rebootUntil: number | null
  thermal: boolean
  os: OsInfo
  aptPending: string[]
  firmwarePending: FirmwareUpdate[]
  rebootRequired: boolean
  lastChecked: number
}

interface SimDeployment extends DeploymentSpec {
  status: DeploymentStatus
  statusSince: number
  createdAt: number
  /** started by a launcher, shown under its name */
  launcherId?: string
  label?: string
}

interface SimKey extends ApiKey {
  share: number
}

interface SimRollout extends Rollout {
  stepStartedAt: number
}

interface SimBench {
  id: string
  kind: BenchKind
  scope: BenchScope
  nodeId: string
  /** every node of the replica under test; none of them may run another bench meanwhile */
  replicaNodeIds: string[]
  deploymentId: string
  model: string
  engine: Deployment['engine']
  quant: string
  contextLength: number
  config: BenchConfig
  status: BenchStatus
  startedAt: number
  finishedAt: number | null
  error: string | null
  plan: BenchPlan
  /** stages finished when a run was cancelled or failed */
  stoppedAt: number | null
}

type InjectedKind = 'nodeOffline' | 'gatewayErrors' | 'xidStorm' | 'picoDisconnected' | 'fanStalled'

const STEP_ORDER: RolloutStep[] = ['queued', 'precheck', 'apply', 'reboot', 'postcheck', 'done']
const clone = <T>(v: T): T => structuredClone(v)

export class Simulator {
  readonly seed: number
  private clock: () => number
  private listeners = new Set<(e: SimEvent) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private counter = 0
  private launchers: Launcher[] = []
  private runtime = new Map<string, NodeRuntime>()
  private deployments: SimDeployment[]
  private keys: SimKey[]
  private rules: AlertRule[]
  private incidents: Incident[]
  private windows: LogWindow[] = []
  private outages: Outage[] = []
  private gatewayErrorWindows: { from: number; to: number | null }[] = []
  private rollouts: SimRollout[]
  private activity: ActivityEvent[]
  private failures: FailureInjection = { nodeOffline: null, gatewayErrors: false, xidStorm: false, apiErrors: false, picoDisconnected: false, fanStalled: null }
  private closers = new Map<string, () => void>()
  private cooling: CoolingSim
  private benches: SimBench[] = []
  /** runs ever started per node + model + kind; seeds each run's jitter */
  private benchOrdinals = new Map<string, number>()
  /** id of the ongoing incident opened by each failure injection */
  private injected: Record<InjectedKind, string | null> = { nodeOffline: null, gatewayErrors: null, xidStorm: null, picoDisconnected: null, fanStalled: null }

  constructor(opts: { seed?: number; now?: () => number } = {}) {
    this.seed = opts.seed ?? SIM_SEED
    this.clock = opts.now ?? (() => Date.now())
    const now = this.clock()

    for (const spec of NODE_SPECS) {
      const count = 3 + Math.floor(noise(this.seed, spec.id, 'apt') * 7)
      this.runtime.set(spec.id, {
        drained: false,
        maintenance: false,
        bootedAt: now - spec.bootedAgoMs,
        rebootUntil: null,
        thermal: spec.thermalIssue,
        os: { ...BASE_OS },
        aptPending: spec.id === 'dell-02' ? APT_PENDING.slice(0, 2) : APT_PENDING.slice(0, count),
        firmwarePending: FIRMWARE_PENDING[spec.model].map((f) => ({ ...f })),
        rebootRequired: spec.id === 'dell-02',
        lastChecked: now - Math.floor(noise(this.seed, spec.id, 'chk') * 3_600_000),
      })
    }

    this.deployments = DEPLOYMENT_SPECS.map((d) => ({ ...clone(d), status: 'serving', statusSince: now - d.createdAgoMs, createdAt: now - d.createdAgoMs }))

    this.keys = KEY_SPECS.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: now - k.createdAgoMs,
      lastUsedAt: k.revokedAgoMs === null ? now - Math.floor(noise(this.seed, k.id, 'used') * 90_000) : now - k.revokedAgoMs - 86_400_000,
      rateLimitRpm: k.rateLimitRpm,
      revokedAt: k.revokedAgoMs === null ? null : now - k.revokedAgoMs,
      requests24h: 0,
      share: k.share,
    }))

    this.rules = clone(ALERT_RULES)

    this.incidents = INCIDENT_SPECS.map((s) => {
      const startedAt = now - s.startedAgoMs
      const window: LogWindow = { from: startedAt, to: s.durationMs === null ? null : startedAt + s.durationMs, nodeId: s.nodeId, kind: s.logKind, label: s.title }
      this.windows.push(window)
      if (s.logKind === 'gateway-5xx') this.gatewayErrorWindows.push({ from: window.from, to: window.to })
      if (s.durationMs === null) {
        this.closers.set(s.id, () => {
          window.to = this.now()
          if (s.logKind === 'thermal' && s.nodeId) this.rt(s.nodeId).thermal = false
        })
      }
      return {
        id: s.id,
        title: s.title,
        severity: s.severity,
        status: s.durationMs === null ? 'ongoing' : 'resolved',
        nodeId: s.nodeId,
        ruleId: s.ruleId,
        startedAt,
        resolvedAt: s.durationMs === null ? null : startedAt + s.durationMs,
        timeline: s.timeline.map((e) => ({ ts: now - e.agoMs, text: e.text })),
      }
    })

    const allNodes = (Object.keys(RINGS) as (keyof typeof RINGS)[]).flatMap((ring) => RINGS[ring].map((nodeId) => ({ nodeId, ring, step: 'done' as const })))
    this.rollouts = ROLLOUT_HISTORY.map((h) => ({
      id: h.id,
      name: h.name,
      targetOs: h.targetOs,
      rings: ['canary', 'ring1', 'ring2'],
      window: 'Sun 02:00–04:00',
      status: 'completed',
      createdAt: now - h.startedAgoMs - 3_600_000,
      startedAt: now - h.startedAgoMs,
      finishedAt: now - h.startedAgoMs + h.durationMs,
      nodes: allNodes.map((n) => ({ ...n })),
      stepStartedAt: now - h.startedAgoMs,
    }))

    this.activity = ACTIVITY_SPECS.map((a) => ({ id: this.nextId('act'), ts: now - a.agoMs, kind: a.kind, text: a.text, nodeId: a.nodeId }))

    // an hour of fan history, so charts and the temperature model have a past
    this.cooling = new CoolingSim({ seed: this.seed })
    for (let t = now - 3_600_000; t <= now; t += 30_000) this.cooling.step(t, (id) => this.thermalAt(id, t))
  }

  // ---------- lifecycle ----------

  now(): number {
    return this.clock()
  }

  start(intervalMs = 2000): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  subscribe(fn: (e: SimEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  tick(): void {
    const now = this.now()
    for (const [id, rt] of this.runtime) {
      if (rt.rebootUntil !== null && now >= rt.rebootUntil) {
        rt.rebootUntil = null
        rt.bootedAt = now
        for (const d of this.deploymentsOn(id)) this.setDeploymentStatus(d, 'loading', now)
        this.log('reboot', `${id} is back online`, id)
        this.changed('nodes', 'deployments')
      }
    }
    for (const d of this.deployments) {
      if (d.status === 'pending' && now - d.statusSince >= DEPLOY_PENDING_MS) {
        this.setDeploymentStatus(d, 'loading', now)
        this.changed('deployments')
      } else if (d.status === 'loading' && now - d.statusSince >= DEPLOY_LOADING_MS) {
        this.setDeploymentStatus(d, 'serving', now)
        this.log('deploy', `${d.model} is serving on ${d.replicas.flatMap((r) => r.nodeIds).join(', ')}`, null)
        this.changed('deployments')
      }
    }
    this.advanceRollouts(now)
    this.settleBenches(now)
    this.stepCooling()
    this.emit({ type: 'tick', now })
  }

  // ---------- reads ----------

  getNodes(): FleetNode[] {
    return NODE_SPECS.map((s) => this.toNode(s))
  }

  getNode(id: string): FleetNode | null {
    const spec = NODE_SPECS.find((s) => s.id === id)
    return spec ? this.toNode(spec) : null
  }

  getMetrics(id: string, range: TimeRange): MetricPoint[] {
    const spec = this.spec(id)
    return nodeSeries(this.metricWorld(), this.effectiveSpec(spec), this.activeDepFor(id), range, this.now())
  }

  getProcesses(id: string): GpuProcess[] {
    const node = this.requireNode(id)
    const dep = this.activeDepFor(id)
    if (!dep || !node.live) return []
    const names: Record<Deployment['engine'], string> = {
      vLLM: 'python3 -m vllm.entrypoints.openai.api_server',
      NIM: '/opt/nim/llm/nim_llm (tensorrt-llm)',
      Ollama: '/usr/bin/ollama runner',
      SGLang: 'python3 -m sglang.launch_server',
      'llama-swap': 'llama-swap --config config.yaml',
      TensorFold: 'python3 /usr/local/bin/tensorfold serve',
      'llama.cpp': 'llama-server',
      Script: 'bash ./start.sh',
    }
    return [{ pid: 40_000 + (hash(this.seed, id, dep.id) % 20_000), user: 'sparkman', name: names[dep.engine], engine: dep.engine, gpuMemMiB: Math.round(dep.memoryGBPerNode * 1024 * 0.97) }]
  }

  getInventory(id: string): NodeInventory {
    const node = this.requireNode(id)
    const updated = node.os.dgxOs === TARGET_OS.dgxOs
    const firmware = [
      { component: 'UEFI', version: node.os.uefi },
      node.model === 'ASUS GX10'
        ? { component: 'ASUS SOC capsule', version: updated ? '2.4.0' : '2.3.1' }
        : node.model === 'Dell Pro Max GB10'
          ? { component: 'Dell BIOS', version: updated ? '1.5.2' : '1.4.0' }
          : { component: 'EC', version: updated ? '0.9.21' : '0.9.18' },
      { component: 'ConnectX-7 firmware', version: '28.45.1020' },
      { component: 'NVMe firmware', version: node.model === 'ASUS GX10' ? 'GX10N201' : node.model === 'Dell Pro Max GB10' ? 'DPM4T102' : 'SPK4T110' },
    ]
    const packages = PACKAGES.map((p) => {
      if (!updated) return { ...p }
      if (p.name === 'nvidia-driver-580-open') return { ...p, version: `${TARGET_OS.driver}-0ubuntu1` }
      if (p.name === 'cuda-toolkit-13-0') return { ...p, version: `${TARGET_OS.cuda}-1` }
      if (p.name === 'dgx-release') return { ...p, version: TARGET_OS.dgxOs }
      return { ...p }
    })
    return { firmware, packages, envelope: this.envelope('firmware_reporter.py', id, 'ok', { components: firmware.length, packages: packages.length }, []) }
  }

  getHealth(id: string): NodeHealth {
    const node = this.requireNode(id)
    const rt = this.rt(id)
    const live = node.live
    const grouped = node.groupId !== null
    const checks: HealthCheck[] = [
      { name: 'GPU visible (nvidia-smi)', status: live ? 'pass' : 'fail', detail: live ? `NVIDIA GB10 · driver ${node.os.driver}` : 'Node unreachable over SSH' },
      { name: 'Unified memory', status: live ? 'pass' : 'fail', detail: live ? `${Math.round(live.memUsedGB)} GB of ${node.memoryGB} GB used (MemAvailable)` : 'No data' },
      {
        name: 'GPU temperature',
        status: !live ? 'fail' : live.gpuTempC > 85 ? 'fail' : live.gpuTempC > 78 || rt.thermal ? 'warn' : 'pass',
        detail: live ? `GPU ${Math.round(live.gpuTempC)} °C · ACPI ${Math.round(live.acpiTempC)} °C${rt.thermal ? ' · thermald throttling' : ''}` : 'No data',
      },
      { name: 'NVMe health', status: 'pass', detail: 'SMART OK · 0 media errors' },
      {
        name: 'Disk usage',
        status: !live ? 'fail' : live.diskUsedPct > 90 ? 'fail' : live.diskUsedPct > 80 ? 'warn' : 'pass',
        detail: live ? `${Math.round(live.diskUsedPct)}% of ${node.diskGB} GB` : 'No data',
      },
      { name: 'ConnectX-7 link', status: 'pass', detail: grouped ? 'enp1s0f0np0 up · 200 Gb/s' : 'Not cabled (single-node)' },
      { name: 'Pending reboot', status: rt.rebootRequired ? 'warn' : 'pass', detail: rt.rebootRequired ? 'Kernel update installed; reboot required' : 'None' },
      { name: 'Last reset reason', status: 'pass', detail: id === 'spark-05' ? 'Operator reboot after Xid 31' : 'Clean shutdown' },
    ]
    const status = checks.some((c) => c.status === 'fail') ? 'error' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
    const flagged = checks.filter((c) => c.status !== 'pass')
    return {
      checks,
      envelope: this.envelope('spark_diagctl.py', id, status, { level: 'L1', checks: checks.length, failed: checks.filter((c) => c.status === 'fail').length, warned: checks.filter((c) => c.status === 'warn').length }, flagged.map((c) => `${c.name}: ${c.detail}`)),
    }
  }

  getFleetSummary(): FleetSummary {
    const nodes = this.getNodes()
    const live = nodes.flatMap((n) => (n.live ? [n.live] : []))
    return {
      online: nodes.filter((n) => n.status === 'online' || n.status === 'degraded').length,
      total: nodes.length,
      gpuUtilAvg: live.length ? live.reduce((s, l) => s + l.gpuUtil, 0) / live.length : 0,
      memUsedGB: live.reduce((s, l) => s + l.memUsedGB, 0),
      memTotalGB: nodes.reduce((s, n) => s + n.memoryGB, 0),
      powerW: live.reduce((s, l) => s + l.gpuPowerW, 0),
      tokensPerSec: gatewayPoint(this.metricWorld(), this.servingSpecs(), this.now()).tokensPerSec,
      activeIncidents: this.incidents.filter((i) => i.status === 'ongoing').length,
    }
  }

  // ---------- launchers: the user's own scripts; here they "load" like any deployment ----------

  getLaunchers(): Launcher[] {
    return this.launchers.map((l) => {
      const d = this.deployments.find((x) => x.launcherId === l.id && x.status !== 'stopped')
      const state: LauncherState = !d ? (l.state === 'failed' ? 'failed' : 'idle') : d.status === 'serving' ? 'serving' : d.status === 'degraded' ? 'down' : 'starting'
      return { ...clone(l), state, models: state === 'serving' ? [d!.model] : [], engine: state === 'serving' ? 'TensorFold' : 'Script', contextLength: state === 'serving' ? 131072 : 0, startedAt: d ? d.createdAt : null }
    })
  }

  private launcherInput(input: Partial<LauncherInput>, id: string | null): LauncherInput {
    const name = String(input.name ?? '').trim()
    if (!name) throw new SimError('invalid', 'Name is required (64 characters at most)')
    if (this.launchers.some((l) => l.id !== id && l.name === name)) throw new SimError('conflict', `A launcher named ${name} exists`)
    const nodeIds = [...new Set(input.nodeIds ?? [])]
    if (!nodeIds.length) throw new SimError('invalid', 'Pick the head node')
    for (const n of nodeIds) this.requireNode(n)
    const dir = String(input.dir ?? '').trim()
    if (!/^(~\/|\/)/.test(dir)) throw new SimError('invalid', 'Folder must be an absolute path or start with ~/ (letters, digits, . _ - + /)')
    const startScript = String(input.startScript ?? '').trim()
    if (!/^[\w.+-]+\.sh$/.test(startScript)) throw new SimError('invalid', 'Start script must be a file name ending in .sh, in that folder')
    const port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SimError('invalid', 'Port must be 1–65535')
    return { name, nodeIds, dir, startScript, stopScript: input.stopScript?.trim() || null, port, sudo: input.sudo === true, caps: input.caps ?? ['tools'], maxOutput: input.maxOutput ?? null, notes: String(input.notes ?? '') }
  }

  createLauncher(input: Partial<LauncherInput>): Launcher {
    const v = this.launcherInput(input, null)
    const l: Launcher = { ...v, id: `ln-${++this.counter}`, state: 'idle', detail: null, startedAt: null, models: [], engine: 'Script', contextLength: 0 }
    this.launchers.push(l)
    this.log('deploy', `Added launcher ${l.name} (${l.nodeIds.join(' + ')})`, l.nodeIds[0])
    this.changed('deployments')
    return this.getLaunchers().find((x) => x.id === l.id)!
  }

  private requireLauncher(id: string, idle: string | null): Launcher {
    const l = this.getLaunchers().find((x) => x.id === id)
    if (!l) throw new SimError('not_found', 'Launcher not found')
    if (idle && l.state !== 'idle' && l.state !== 'failed') throw new SimError('conflict', `Stop ${l.name} before ${idle} it`)
    return l
  }

  updateLauncher(id: string, input: Partial<LauncherInput>): Launcher {
    this.requireLauncher(id, 'editing')
    const v = this.launcherInput(input, id)
    this.launchers = this.launchers.map((l) => (l.id === id ? { ...l, ...v } : l))
    this.changed('deployments')
    return this.getLaunchers().find((x) => x.id === id)!
  }

  deleteLauncher(id: string): void {
    const l = this.requireLauncher(id, 'deleting')
    this.launchers = this.launchers.filter((x) => x.id !== id)
    this.log('deploy', `Removed launcher ${l.name}`, l.nodeIds[0])
    this.changed('deployments')
  }

  startLauncher(id: string): Launcher {
    const l = this.requireLauncher(id, null)
    if (l.state !== 'idle' && l.state !== 'failed') throw new SimError('conflict', `${l.name} is ${l.state}`)
    for (const n of l.nodeIds) {
      const node = this.requireNode(n)
      if (node.deploymentId) throw new SimError('conflict', `${n} is serving ${node.deploymentId}; stop it first`)
      if (node.status === 'offline' || node.status === 'rebooting') throw new SimError('conflict', `${n} is ${node.status}`)
    }
    const now = this.now()
    this.deployments.push({
      id: l.id, model: 'gpt-oss-20b', engine: 'TensorFold', replicas: [{ id: `${l.id}-r0`, nodeIds: [...l.nodeIds] }], memoryGBPerNode: 60,
      trafficWeight: 0.3, peakTokensPerSec: 700, peakRps: 1, createdAgoMs: 0, status: 'pending', statusSince: now, createdAt: now, launcherId: l.id, label: l.name,
    })
    this.log('deploy', `Starting ${l.name} on ${l.nodeIds.join(' + ')}`, l.nodeIds[0])
    this.changed('deployments', 'nodes')
    return this.getLaunchers().find((x) => x.id === id)!
  }

  launcherLog(id: string): string {
    const l = this.requireLauncher(id, null)
    if (l.state === 'idle') return ''
    return [`=== SparkMan: start ${l.startScript} in ${l.dir}`, `[rank 0] loading weights on ${l.nodeIds[0]}`, ...l.nodeIds.slice(1).map((n, i) => `[rank ${i + 1}] connected from ${n}`), l.state === 'serving' ? `INFO: serving on :${l.port}` : 'loading…'].join('\n')
  }

  getDeployments(): Deployment[] {
    return this.deployments.filter((d) => d.status !== 'stopped').map((d) => this.toDeployment(d))
  }

  getGatewayInfo(): GatewayInfo {
    return { baseUrl: GATEWAY_BASE_URL, defaultModel: 'qwen3-235b-a22b', models: [...new Set(this.getDeployments().filter((d) => d.status === 'serving' || d.status === 'degraded').map((d) => d.model))] }
  }

  getGatewaySeries(range: TimeRange): GatewayPoint[] {
    const now = this.now()
    const world = this.metricWorld()
    const specs = this.servingSpecs()
    const points = gatewaySeries(world, specs, range, now)
    // series points are step-aligned; append an exact "now" sample so live tiles react within one tick
    if (points[points.length - 1].t < now) points.push(gatewayPoint(world, specs, now))
    return points
  }

  getRoutes(): GatewayRoute[] {
    return this.getDeployments().map((d) => ({
      model: d.model,
      deploymentId: d.id,
      engine: d.engine,
      replicas: d.replicas.length,
      nodeIds: d.replicas.flatMap((r) => r.nodeIds),
      healthy: d.status === 'serving',
    }))
  }

  getUsage(range: TimeRange): UsageReport {
    const now = this.now()
    const keySpecs = this.keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, rateLimitRpm: k.rateLimitRpm, createdAgoMs: now - k.createdAt, revokedAgoMs: k.revokedAt === null ? null : now - k.revokedAt, share: k.share }))
    return usageReport(this.metricWorld(), this.servingSpecs(), keySpecs, range, now)
  }

  getKeys(): ApiKey[] {
    const day = this.getUsage('24h')
    return this.keys.map(({ share: _share, ...k }) => ({ ...k, requests24h: Math.round(day.topKeys.find((t) => t.keyId === k.id)?.requests ?? 0) }))
  }

  queryLogs(input: LogQueryInput): LogQueryResult {
    const now = this.now()
    const from = input.around !== undefined ? input.around - 60_000 : now - RANGE_MS[input.range]
    const to = input.around !== undefined ? Math.min(input.around + 60_000, now) : now
    const query = parseLogQuery(input.query)
    const world = this.logWorld()
    const { lines, truncated } = queryLogs(world, { from, to, query, limit: input.limit ?? 200 })
    const histogram = logHistogram(world, { from, to, query, buckets: 60 })
    const total = histogram.reduce((s, b) => s + b.error + b.warn + b.info + b.debug, 0)
    const bands = this.windows
      .filter((w) => w.from <= to && (w.to === null || w.to >= from))
      .map((w) => ({ from: Math.max(w.from, from), to: Math.min(w.to ?? now, to), label: w.label }))
    return { lines, histogram, total, truncated, bands, from, to }
  }

  getIncidents(): Incident[] {
    return clone([...this.incidents].sort((a, b) => (a.status === b.status ? b.startedAt - a.startedAt : a.status === 'ongoing' ? -1 : 1)))
  }

  getRules(): AlertRule[] {
    return clone(this.rules)
  }

  getUpdates(): NodeUpdateStatus[] {
    return NODE_SPECS.map((s) => {
      const rt = this.rt(s.id)
      const ring = (Object.keys(RINGS) as (keyof typeof RINGS)[]).find((r) => RINGS[r].includes(s.id))!
      const pending = rt.aptPending.length + rt.firmwarePending.length
      return {
        nodeId: s.id,
        model: s.model,
        ring,
        currentOs: rt.os.dgxOs,
        targetOs: TARGET_OS.dgxOs,
        aptPending: [...rt.aptPending],
        firmwarePending: rt.firmwarePending.map((f) => ({ ...f })),
        rebootRequired: rt.rebootRequired,
        lastChecked: rt.lastChecked,
        envelope: this.envelope('spark_updatectl.py', s.id, pending > 0 || rt.rebootRequired ? 'warn' : 'ok', { mode: 'check', pending_packages: rt.aptPending.length, firmware_updates: rt.firmwarePending.length, reboot_required: rt.rebootRequired }, rt.rebootRequired ? ['reboot required to activate installed kernel'] : []),
      }
    })
  }

  getRollouts(): Rollout[] {
    return this.rollouts.map(({ stepStartedAt: _s, ...r }) => clone(r)).sort((a, b) => b.createdAt - a.createdAt)
  }

  getActivity(limit = 50): ActivityEvent[] {
    return clone(this.activity.slice(0, limit))
  }

  getFailures(): FailureInjection {
    return { ...this.failures }
  }

  getBenchRuns(filter: BenchRunFilter = {}): BenchRun[] {
    const now = this.now()
    this.settleBenches(now)
    return this.benches
      .filter((b) => (!filter.nodeId || b.nodeId === filter.nodeId) && (!filter.model || b.model === filter.model) && (!filter.kind || b.kind === filter.kind))
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((b) => this.toBenchRun(b, now))
  }

  getBenchRun(id: string): BenchRun | null {
    const now = this.now()
    this.settleBenches(now)
    const b = this.benches.find((x) => x.id === id)
    return b ? this.toBenchRun(b, now) : null
  }

  // ---------- actions ----------

  rebootNode(id: string): void {
    const rt = this.rt(id)
    const now = this.now()
    if (rt.rebootUntil !== null) throw new SimError('conflict', `${id} is already rebooting`)
    rt.rebootUntil = now + REBOOT_MS
    rt.rebootRequired = false
    this.outages.push({ nodeId: id, from: now, to: now + REBOOT_MS })
    this.log('reboot', `Reboot requested for ${id}`, id)
    this.changed('nodes', 'deployments', 'updates')
  }

  setMaintenance(id: string, on: boolean): void {
    const rt = this.rt(id)
    rt.maintenance = on
    rt.drained = on
    this.log('maintenance', on ? `${id} entered maintenance: alerts muted, drained` : `${id} left maintenance`, id)
    this.changed('nodes')
  }

  setDrained(id: string, drained: boolean): void {
    this.rt(id).drained = drained
    this.log('drain', drained ? `${id} drained: gateway stops routing new requests` : `${id} returned to service`, id)
    this.changed('nodes')
  }

  runDiagnostics(id: string): SparkToolEnvelope {
    const { envelope } = this.getHealth(id)
    this.log('diag', `L1 diagnostics on ${id}: ${envelope.status}`, id)
    return envelope
  }

  collectBundle(id: string): SparkToolEnvelope {
    const node = this.requireNode(id)
    if (node.status === 'offline' || node.status === 'rebooting') throw new SimError('conflict', `${id} is ${node.status}`)
    const health = this.getHealth(id).envelope
    const env = this.envelope('spark_diagctl.py', id, health.status, { ...health.summary, level: 'L2' }, health.warnings)
    env.artifacts = [env.artifacts[0].replace(/\.json$/, '-L2.tar.zst')]
    this.log('diag', `L2 evidence bundle collected on ${id}`, id)
    return env
  }

  createDeployment(input: CreateDeploymentInput): Deployment {
    const model = MODEL_CATALOG.find((m) => m.id === input.catalogId)
    if (!model) throw new SimError('invalid', `Unknown model ${input.catalogId}`)
    if (!model.engines.includes(input.engine)) throw new SimError('invalid', `${model.displayName} is not packaged for ${input.engine}`)
    if (input.nodeIds.length === 0) throw new SimError('invalid', 'Select at least one node')
    if (input.nodeIds.length > 1 && input.engine !== 'vLLM' && input.engine !== 'SGLang') throw new SimError('invalid', `${input.engine} cannot span multiple nodes`)
    const perNode = model.sizeGB / input.nodeIds.length
    if (perNode > 110) throw new SimError('invalid', `${model.displayName} needs at least ${Math.ceil(model.sizeGB / 110)} nodes`)
    for (const id of input.nodeIds) {
      const node = this.requireNode(id)
      if (node.deploymentId) throw new SimError('conflict', `${id} is already serving ${node.deploymentId}`)
      if (node.status === 'offline' || node.status === 'rebooting') throw new SimError('conflict', `${id} is ${node.status}`)
    }
    const now = this.now()
    const n = ++this.counter
    const dep: SimDeployment = {
      id: `dep-${model.id}-${n}`,
      model: model.id,
      engine: input.engine,
      replicas: [{ id: input.nodeIds.length > 1 ? `grp-${n}` : `rep-${n}`, nodeIds: [...input.nodeIds] }],
      memoryGBPerNode: Math.min(110, Math.ceil(perNode * 1.15) + 8),
      trafficWeight: 0.3,
      peakTokensPerSec: 800,
      peakRps: 1.2,
      createdAgoMs: 0,
      status: 'pending',
      statusSince: now,
      createdAt: now,
    }
    this.deployments.push(dep)
    this.log('deploy', `Deploying ${model.id} on ${input.nodeIds.join(', ')} (${input.engine})`, input.nodeIds.length === 1 ? input.nodeIds[0] : null)
    this.changed('deployments', 'nodes')
    return this.toDeployment(dep)
  }

  stopDeployment(id: string): void {
    const d = this.deployments.find((x) => x.id === id && x.status !== 'stopped')
    if (!d) throw new SimError('not_found', `Deployment ${id} not found`)
    this.setDeploymentStatus(d, 'stopped', this.now())
    this.log('deploy', `Stopped ${d.model} on ${d.replicas.flatMap((r) => r.nodeIds).join(', ')}`, null)
    this.changed('deployments', 'nodes')
  }

  createKey(input: { name: string; rateLimitRpm: number }): { key: ApiKey; secret: string } {
    const name = input.name.trim()
    if (!name) throw new SimError('invalid', 'Name is required')
    if (this.keys.some((k) => k.name === name && k.revokedAt === null)) throw new SimError('conflict', `An active key named ${name} exists`)
    const now = this.now()
    const rand = mulberry32(hash(this.seed, name, now))
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    const secret = `sk-spark-${Array.from({ length: 32 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('')}`
    const key: SimKey = { id: this.nextId('key'), name, prefix: secret.slice(0, 13), createdAt: now, lastUsedAt: null, rateLimitRpm: input.rateLimitRpm, revokedAt: null, requests24h: 0, share: 0 }
    this.keys.push(key)
    this.log('key', `API key ${name} created`, null)
    this.changed('keys')
    const { share: _share, ...pub } = key
    return { key: { ...pub }, secret }
  }

  revokeKey(id: string): void {
    const key = this.keys.find((k) => k.id === id)
    if (!key) throw new SimError('not_found', `Key ${id} not found`)
    if (key.revokedAt !== null) throw new SimError('conflict', `${key.name} is already revoked`)
    key.revokedAt = this.now()
    key.share = 0
    this.log('key', `API key ${key.name} revoked`, null)
    this.changed('keys')
  }

  setRuleEnabled(id: string, enabled: boolean): void {
    const rule = this.rules.find((r) => r.id === id)
    if (!rule) throw new SimError('not_found', `Rule ${id} not found`)
    rule.enabled = enabled
    this.changed('rules')
  }

  resolveIncident(id: string): void {
    const inc = this.incidents.find((i) => i.id === id)
    if (!inc) throw new SimError('not_found', `Incident ${id} not found`)
    if (inc.status === 'resolved') throw new SimError('conflict', `${inc.title} is already resolved`)
    const now = this.now()
    inc.status = 'resolved'
    inc.resolvedAt = now
    inc.timeline.push({ ts: now, text: 'Resolved by operator' })
    this.closers.get(id)?.()
    this.closers.delete(id)
    this.log('alert', `Incident resolved: ${inc.title}`, inc.nodeId)
    const kind = (Object.keys(this.injected) as InjectedKind[]).find((k) => this.injected[k] === id)
    if (kind) {
      // resolving an injected incident (e.g. from Alerts) switches its failure off too
      this.injected[kind] = null
      if (kind === 'nodeOffline' || kind === 'fanStalled') this.failures[kind] = null
      else this.failures[kind] = false
      this.changed('failures')
    }
    this.changed('incidents', 'nodes')
  }

  startRollout(input: StartRolloutInput): Rollout {
    if (this.rollouts.some((r) => r.status === 'running' || r.status === 'awaiting-approval')) throw new SimError('conflict', 'Another rollout is already active')
    if (input.rings.length === 0) throw new SimError('invalid', 'Select at least one ring')
    const now = this.now()
    const order: (keyof typeof RINGS)[] = ['canary', 'ring1', 'ring2']
    const rings = order.filter((r) => input.rings.includes(r))
    const rollout: SimRollout = {
      id: this.nextId('ro'),
      name: `DGX OS ${input.targetOs}`,
      targetOs: input.targetOs,
      rings,
      window: input.window,
      status: input.requireApproval ? 'awaiting-approval' : 'running',
      createdAt: now,
      startedAt: input.requireApproval ? null : now,
      finishedAt: null,
      nodes: rings.flatMap((ring) => RINGS[ring].map((nodeId) => ({ nodeId, ring, step: 'queued' as const }))),
      stepStartedAt: now,
    }
    this.rollouts.push(rollout)
    this.log('update', `Rollout ${rollout.name} planned for ${rings.join(' → ')}${input.requireApproval ? ' (awaiting approval)' : ''}`, null)
    this.changed('rollouts')
    const { stepStartedAt: _s, ...pub } = rollout
    return clone(pub)
  }

  approveRollout(id: string): void {
    const r = this.rollouts.find((x) => x.id === id)
    if (!r) throw new SimError('not_found', `Rollout ${id} not found`)
    if (r.status !== 'awaiting-approval') throw new SimError('conflict', `${r.name} is ${r.status}`)
    const now = this.now()
    r.status = 'running'
    r.startedAt = now
    r.stepStartedAt = now
    this.log('update', `Rollout ${r.name} approved`, null)
    this.changed('rollouts')
  }

  cancelRollout(id: string): void {
    const r = this.rollouts.find((x) => x.id === id)
    if (!r) throw new SimError('not_found', `Rollout ${id} not found`)
    if (r.status !== 'awaiting-approval') throw new SimError('conflict', `${r.name} is ${r.status}`)
    r.status = 'failed'
    r.finishedAt = this.now()
    this.log('update', `Rollout ${r.name} rejected`, null)
    this.changed('rollouts')
  }

  startBench(input: StartBenchInput): BenchRun {
    const now = this.now()
    this.settleBenches(now)
    const d = this.deployments.find((x) => x.id === input.deploymentId && x.status !== 'stopped')
    if (!d) throw new SimError('not_found', `Deployment ${input.deploymentId} not found`)
    const gateway = input.scope === 'gateway'
    let replicas: Replica[]
    if (gateway) {
      if (d.replicas.length < 2) throw new SimError('invalid', `${d.model} has one copy; bench its node instead of the gateway`)
      if (input.config.kind !== 'decode' && input.config.kind !== 'prefill') {
        throw new SimError('invalid', `${BENCH_KIND_LABEL[input.config.kind]} scores the model, which is the same on every copy; bench one node instead`)
      }
      replicas = d.replicas
    } else {
      const node = this.requireNode(input.nodeId)
      const replica = d.replicas.find((r) => r.nodeIds.includes(node.id))
      if (!replica) throw new SimError('invalid', `${d.model} is not served on ${node.id}`)
      replicas = [replica]
    }
    const nodeIds = replicas.flatMap((r) => r.nodeIds)
    for (const id of nodeIds) {
      const status = this.nodeStatus(id)
      if (status === 'offline' || status === 'rebooting') throw new SimError('conflict', `${id} is ${status}`)
    }
    if (d.status !== 'serving') throw new SimError('conflict', `${d.model} is ${d.status}; wait until it is serving`)
    const busy = this.benches.find((b) => b.status === 'running' && b.replicaNodeIds.some((id) => nodeIds.includes(id)))
    if (busy) throw new SimError('conflict', `${busy.nodeId === GATEWAY_TARGET ? 'The gateway' : busy.nodeId} is already running a ${BENCH_KIND_LABEL[busy.kind]} bench that uses ${busy.replicaNodeIds.filter((id) => nodeIds.includes(id)).join(', ')}; one bench per node at a time`)
    const cat = MODEL_CATALOG.find((m) => m.id === d.model)!
    const config = validateBenchConfig(input.config, cat.contextLength)
    // a group is benched through its head (the node serving the API), and filed under it
    const runNode = gateway ? GATEWAY_TARGET : replicas[0].nodeIds[0]
    const targetFor = (r: Replica) => ({
      nodeId: r.nodeIds[0],
      model: cat,
      engine: d.engine,
      nodesPerReplica: r.nodeIds.length,
      load: (this.getNode(r.nodeIds[0])?.live?.gpuUtil ?? 0) / 100,
      // a group runs at the pace of its hottest node
      thermal: r.nodeIds.some((id) => this.rt(id).thermal),
    })

    const ordinalKey = `${runNode}|${d.model}|${config.kind}`
    const ordinal = (this.benchOrdinals.get(ordinalKey) ?? 0) + 1
    this.benchOrdinals.set(ordinalKey, ordinal)
    const runKey = `${ordinalKey}|${ordinal}`
    const plan = gateway
      ? planGatewayBench(this.seed, runKey, replicas.map((r) => ({ target: targetFor(r), nodeIds: [...r.nodeIds] })), config)
      : planBench(this.seed, runKey, targetFor(replicas[0]), config)
    const bench: SimBench = {
      id: this.nextId('bench'),
      kind: config.kind,
      scope: gateway ? 'gateway' : 'replica',
      nodeId: runNode,
      replicaNodeIds: nodeIds,
      deploymentId: d.id,
      model: d.model,
      engine: d.engine,
      quant: cat.quant,
      contextLength: cat.contextLength,
      config,
      status: 'running',
      startedAt: now,
      finishedAt: null,
      error: null,
      plan,
      stoppedAt: null,
    }
    this.benches.push(bench)
    const where = gateway ? `the gateway (${replicas.length} copies)` : replicas[0].nodeIds.length > 1 ? `${runNode} (group of ${replicas[0].nodeIds.length})` : runNode
    this.log('bench', `${BENCH_KIND_LABEL[config.kind]} bench started on ${where} (${d.model})`, gateway ? null : runNode)
    this.changed('benchmarks')
    return this.toBenchRun(bench, now)
  }

  cancelBench(id: string): void {
    const now = this.now()
    this.settleBenches(now)
    const b = this.benches.find((x) => x.id === id)
    if (!b) throw new SimError('not_found', `Bench run ${id} not found`)
    if (b.status !== 'running') throw new SimError('conflict', `Bench run ${id} is ${b.status}`)
    this.stopBench(b, 'cancelled', now, null)
    this.log('bench', `${BENCH_KIND_LABEL[b.kind]} bench on ${b.nodeId} cancelled`, b.nodeId)
    this.changed('benchmarks')
  }

  deleteBenchRun(id: string): void {
    this.settleBenches(this.now())
    const b = this.benches.find((x) => x.id === id)
    if (!b) throw new SimError('not_found', `Bench run ${id} not found`)
    if (b.status === 'running') throw new SimError('conflict', 'Cancel the run before deleting it')
    this.benches = this.benches.filter((x) => x !== b)
    this.changed('benchmarks')
  }

  setFailures(patch: Partial<FailureInjection>): void {
    // validate before mutating anything
    if (patch.nodeOffline) this.spec(patch.nodeOffline)
    if (patch.fanStalled && !this.cooling.fan(patch.fanStalled)) throw new SimError('not_found', `Fan ${patch.fanStalled} not found`)
    const now = this.now()
    if (patch.nodeOffline !== undefined && patch.nodeOffline !== this.failures.nodeOffline) {
      this.resolveInjected('nodeOffline')
      const id = patch.nodeOffline
      if (id) {
        const outage: Outage = { nodeId: id, from: now, to: null }
        this.outages.push(outage)
        this.openInjected('nodeOffline', `inj-offline-${id}`, `${id} offline`, 'critical', id, 'rule-offline', 'No heartbeat for 60 s', () => {
          outage.to = this.now()
        })
      }
      this.failures.nodeOffline = id
    }
    if (patch.gatewayErrors !== undefined && patch.gatewayErrors !== this.failures.gatewayErrors) {
      if (patch.gatewayErrors) {
        const gw = { from: now, to: null as number | null }
        const win: LogWindow = { from: now, to: null, nodeId: 'spark-03', kind: 'gateway-5xx', label: 'Gateway 5xx (injected)' }
        this.gatewayErrorWindows.push(gw)
        this.windows.push(win)
        this.openInjected('gatewayErrors', 'inj-5xx', 'Gateway 5xx rate above 2 %', 'critical', null, 'rule-5xx', '5xx rate crossed 2 %', () => {
          gw.to = this.now()
          win.to = this.now()
        })
      } else {
        this.resolveInjected('gatewayErrors')
      }
      this.failures.gatewayErrors = patch.gatewayErrors
    }
    if (patch.xidStorm !== undefined && patch.xidStorm !== this.failures.xidStorm) {
      if (patch.xidStorm) {
        const win: LogWindow = { from: now, to: null, nodeId: 'gx10-03', kind: 'xid', label: 'Xid storm on gx10-03 (injected)' }
        this.windows.push(win)
        this.openInjected('xidStorm', 'inj-xid', 'Xid 31 storm on gx10-03', 'critical', 'gx10-03', 'rule-xid', 'NVRM: Xid 31 repeated', () => {
          win.to = this.now()
        })
      } else {
        this.resolveInjected('xidStorm')
      }
      this.failures.xidStorm = patch.xidStorm
    }
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
    if (patch.apiErrors !== undefined) this.failures.apiErrors = patch.apiErrors
    this.changed('failures', 'incidents', 'nodes', 'cooling')
  }

  // ---------- cooling ----------

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
    if (!this.cooling.connected) throw new SimError('unavailable', 'The Pico isn’t answering — fan speeds can change once it’s back')
    this.cooling.setManual(fanId, duty === null ? null : Math.round(duty), this.now())
    this.stepCooling()
    this.log('system', duty === null ? `${fan.name} back to auto` : `${fan.name} pinned to ${Math.round(duty)}%`, null)
    this.changed('cooling')
  }

  setCoolingPolicy(patch: Partial<CoolingPolicy>): void {
    const next: CoolingPolicy = { ...this.cooling.policy, ...structuredClone(patch) }
    const err = validatePolicy(next)
    if (err) throw new SimError('invalid', err)
    this.cooling.setPolicy(next)
    this.stepCooling()
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
    this.stepCooling()
    this.log('system', 'Fan zones updated', null)
    this.changed('cooling')
  }

  // ---------- internals ----------

  private emit(e: SimEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  private changed(...topics: Topic[]): void {
    for (const topic of topics) this.emit({ type: 'changed', topic })
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.counter}`
  }

  private log(kind: ActivityKind, text: string, nodeId: string | null): void {
    this.activity.unshift({ id: this.nextId('act'), ts: this.now(), kind, text, nodeId })
    this.activity = this.activity.slice(0, 200)
    this.changed('activity')
  }

  private spec(id: string): NodeSpec {
    const s = NODE_SPECS.find((x) => x.id === id)
    if (!s) throw new SimError('not_found', `Node ${id} not found`)
    return s
  }

  private rt(id: string): NodeRuntime {
    this.spec(id)
    return this.runtime.get(id)!
  }

  private requireNode(id: string): FleetNode {
    const n = this.getNode(id)
    if (!n) throw new SimError('not_found', `Node ${id} not found`)
    return n
  }

  private effectiveSpec(spec: NodeSpec): NodeSpec {
    return { ...spec, thermalIssue: this.rt(spec.id).thermal }
  }

  private metricWorld(): MetricWorld {
    return { seed: this.seed, outages: this.outages, gatewayErrorWindows: this.gatewayErrorWindows, airflow: (id, t) => this.cooling?.airflowAt(id, t) ?? null }
  }

  /** run the fan loop now (each tick, and right after a cooling change so the page needn't wait a tick) */
  private stepCooling(): void {
    this.cooling.step(this.now(), (id) => this.getNode(id)?.live ?? null)
  }

  /** a box's GPU temperature and load at a past time (backfill) */
  private thermalAt(id: string, t: number): Thermal {
    const p = sampleNode(this.metricWorld(), this.effectiveSpec(this.spec(id)), this.activeDepFor(id), t)
    return p.gpuTempC === null || p.gpuUtil === null ? null : { gpuTempC: p.gpuTempC, gpuUtil: p.gpuUtil }
  }

  private logWorld(): LogWorld {
    return {
      seed: this.seed,
      nodes: NODE_SPECS,
      deployments: this.deployments.filter((d) => d.status !== 'stopped'),
      keys: this.keys.filter((k) => k.revokedAt === null).map(({ id, name, share }) => ({ id, name, share })),
      windows: this.windows,
      outages: this.outages,
    }
  }

  private deploymentsOn(nodeId: string): SimDeployment[] {
    return this.deployments.filter((d) => d.status !== 'stopped' && d.replicas.some((r) => r.nodeIds.includes(nodeId)))
  }

  private activeDepFor(nodeId: string): SimDeployment | null {
    return this.deploymentsOn(nodeId)[0] ?? null
  }

  private servingSpecs(): DeploymentSpec[] {
    const reachable = (id: string) => {
      const s = this.nodeStatus(id)
      return s === 'online' || s === 'degraded'
    }
    return this.deployments
      .filter((d) => d.status === 'serving')
      .map((d) => ({ ...d, replicas: d.replicas.filter((r) => r.nodeIds.every(reachable)) }))
      .filter((d) => d.replicas.length > 0)
  }

  private setDeploymentStatus(d: SimDeployment, status: DeploymentStatus, now: number): void {
    d.status = status
    d.statusSince = now
  }

  private nodeStatus(id: string): NodeStatus {
    const rt = this.rt(id)
    const now = this.now()
    if (rt.rebootUntil !== null && now < rt.rebootUntil) return 'rebooting'
    if (isOffline(this.outages, id, now)) return 'offline'
    if (rt.thermal) return 'degraded'
    return 'online'
  }

  private toNode(spec: NodeSpec): FleetNode {
    const rt = this.rt(spec.id)
    const now = this.now()
    const status = this.nodeStatus(spec.id)
    const dep = this.activeDepFor(spec.id)
    const reachable = status === 'online' || status === 'degraded'
    const p = reachable ? sampleNode(this.metricWorld(), this.effectiveSpec(spec), dep, now) : null
    const lastOutage = [...this.outages].reverse().find((o) => o.nodeId === spec.id && o.from <= now)
    const group = dep?.replicas.find((r) => r.nodeIds.includes(spec.id) && r.nodeIds.length > 1)
    return {
      id: spec.id,
      hostname: `${spec.id}.${FLEET_CONFIG.domain}`,
      model: spec.model,
      ip: spec.ip,
      status,
      drained: rt.drained,
      maintenance: rt.maintenance,
      os: { ...rt.os },
      memoryGB: 128,
      cpuCores: 20,
      diskGB: spec.diskGB,
      assetTag: spec.assetTag,
      serial: spec.serial,
      bootedAt: rt.bootedAt,
      lastSeen: reachable ? now - Math.floor(noise(this.seed, spec.id, 'seen', Math.floor(now / 2000)) * 4000) : (lastOutage?.from ?? now),
      deploymentId: dep?.id ?? null,
      rack: { ...spec.rack },
      groupId: group?.id ?? null,
      live: p
        ? {
            gpuUtil: p.gpuUtil!,
            memUsedGB: p.memUsedGB!,
            gpuPowerW: p.gpuPowerW!,
            gpuTempC: p.gpuTempC!,
            acpiTempC: p.acpiTempC!,
            cpuUtil: p.cpuUser! + p.cpuSystem!,
            diskUsedPct: p.diskUsedPct!,
            throttling: rt.thermal,
          }
        : null,
    }
  }

  private toDeployment(d: SimDeployment): Deployment {
    const cat = MODEL_CATALOG.find((m) => m.id === d.model)!
    const nodeIds = d.replicas.flatMap((r) => r.nodeIds)
    const anyDown = nodeIds.some((id) => {
      const s = this.nodeStatus(id)
      return s === 'offline' || s === 'rebooting'
    })
    const status: DeploymentStatus = d.status === 'serving' && anyDown ? 'degraded' : d.status
    const load = status === 'serving' ? deploymentLoad(this.seed, d, this.now()) : 0
    return {
      id: d.id,
      model: d.model,
      displayName: d.label ?? cat.displayName,
      engine: d.engine,
      quant: cat.quant,
      replicas: clone(d.replicas),
      status,
      contextLength: cat.contextLength,
      port: ENGINE_PORT[d.engine],
      memoryGBPerNode: d.memoryGBPerNode,
      createdAt: d.createdAt,
      tokensPerSec: load * d.peakTokensPerSec * d.replicas.length,
      requestsPerSec: load * d.peakRps,
      ...(d.launcherId ? { launcherId: d.launcherId } : {}),
    }
  }

  private benchStagesDone(b: SimBench, now: number): number {
    if (b.status === 'completed') return b.plan.stages.length
    if (b.stoppedAt !== null) return b.stoppedAt
    return Math.min(b.plan.stages.length, Math.floor((now - b.startedAt) / b.plan.stageMs))
  }

  private stopBench(b: SimBench, status: 'cancelled' | 'failed', now: number, error: string | null): void {
    b.stoppedAt = this.benchStagesDone(b, now)
    b.status = status
    b.finishedAt = now
    b.error = error
  }

  /** Finish runs whose time is up and fail runs whose node or deployment went away. */
  private settleBenches(now: number): void {
    let touched = false
    for (const b of this.benches) {
      if (b.status !== 'running') continue
      const down = b.replicaNodeIds.find((id) => {
        const st = this.nodeStatus(id)
        return st === 'offline' || st === 'rebooting'
      })
      const dep = this.deployments.find((d) => d.id === b.deploymentId)
      if (down || !dep || dep.status === 'stopped') {
        this.stopBench(b, 'failed', now, down ? `${down} became unreachable during the run` : `${b.model} was stopped during the run`)
        this.log('bench', `${BENCH_KIND_LABEL[b.kind]} bench on ${b.nodeId} failed`, b.nodeId)
        touched = true
      } else if (now - b.startedAt >= b.plan.stages.length * b.plan.stageMs) {
        b.status = 'completed'
        b.finishedAt = b.startedAt + b.plan.stages.length * b.plan.stageMs
        this.log('bench', `${BENCH_KIND_LABEL[b.kind]} bench on ${b.nodeId} finished (${b.model})`, b.nodeId)
        touched = true
      }
    }
    if (!touched) return
    this.pruneBenchHistory()
    this.changed('benchmarks')
  }

  private pruneBenchHistory(): void {
    const kept = new Map<string, number>()
    const keep = new Set<SimBench>()
    for (const b of [...this.benches].sort((x, y) => y.startedAt - x.startedAt)) {
      if (b.status === 'running') {
        keep.add(b)
        continue
      }
      const key = `${b.nodeId}|${b.model}|${b.kind}`
      const n = kept.get(key) ?? 0
      if (n < BENCH_HISTORY_LIMIT) keep.add(b)
      kept.set(key, n + 1)
    }
    this.benches = this.benches.filter((b) => keep.has(b))
  }

  private toBenchRun(b: SimBench, now: number): BenchRun {
    const total = b.plan.stages.length
    const done = this.benchStagesDone(b, now)
    const running = b.status === 'running'
    return {
      id: b.id,
      kind: b.kind,
      scope: b.scope,
      nodeId: b.nodeId,
      nodeIds: [...b.replicaNodeIds],
      deploymentId: b.deploymentId,
      model: b.model,
      engine: b.engine,
      quant: b.quant,
      contextLength: b.contextLength,
      config: clone(b.config),
      status: b.status,
      progress: b.status === 'completed' ? 1 : running ? Math.min(0.99, (now - b.startedAt) / (total * b.plan.stageMs)) : done / total,
      stage: running ? (b.plan.stages[done] ?? null) : null,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      error: b.error,
      result: clone(partialResult(b.plan.result, done)),
    }
  }

  private envelope(tool: string, id: string, status: SparkToolEnvelope['status'], summary: Record<string, unknown>, warnings: string[]): SparkToolEnvelope {
    const now = this.now()
    const ts = new Date(now).toISOString()
    return {
      tool,
      ts,
      host: `${id}.${FLEET_CONFIG.domain}`,
      status,
      rc: status === 'error' ? 2 : status === 'warn' ? 1 : 0,
      duration_ms: 400 + Math.floor(noise(this.seed, tool, id, Math.floor(now / 60_000)) * 900),
      summary,
      warnings,
      artifacts: [`/var/lib/dgx_spark_management/${tool.replace('.py', '')}/${id}-${ts.replace(/[:.]/g, '')}.json`],
    }
  }

  private openInjected(kind: InjectedKind, prefix: string, title: string, severity: Incident['severity'], nodeId: string | null, ruleId: string, first: string, closer: () => void): void {
    const now = this.now()
    const id = this.nextId(prefix)
    this.injected[kind] = id
    this.incidents.push({ id, title, severity, status: 'ongoing', nodeId, ruleId, startedAt: now, resolvedAt: null, timeline: [{ ts: now, text: first }] })
    this.closers.set(id, closer)
    this.log('alert', `Alert opened: ${title}`, nodeId)
  }

  private resolveInjected(kind: InjectedKind): void {
    const id = this.injected[kind]
    // clear the tracker first so resolveIncident does not also reset the failure flag
    this.injected[kind] = null
    if (id && this.incidents.some((i) => i.id === id && i.status === 'ongoing')) this.resolveIncident(id)
  }

  private advanceRollouts(now: number): void {
    const r = this.rollouts.find((x) => x.status === 'running')
    if (!r) return
    const ring = r.rings.find((rg) => r.nodes.some((n) => n.ring === rg && n.step !== 'done'))
    if (!ring) {
      r.status = 'completed'
      r.finishedAt = now
      this.log('update', `Rollout ${r.name} completed on ${r.nodes.length} nodes`, null)
      this.changed('rollouts')
      return
    }
    const ringNodes = r.nodes.filter((n) => n.ring === ring)
    const queued = ringNodes.every((n) => n.step === 'queued')
    if (!queued && now - r.stepStartedAt < ROLLOUT_STEP_MS) return
    r.stepStartedAt = now
    const next = STEP_ORDER[STEP_ORDER.indexOf(ringNodes[0].step) + 1]
    for (const n of ringNodes) {
      n.step = next
      if (next === 'reboot') this.outages.push({ nodeId: n.nodeId, from: now, to: now + ROLLOUT_STEP_MS })
      if (next === 'done') {
        const rt = this.rt(n.nodeId)
        if (r.targetOs === TARGET_OS.dgxOs) rt.os = { ...TARGET_OS }
        rt.aptPending = []
        rt.firmwarePending = []
        rt.rebootRequired = false
        rt.lastChecked = now
      }
    }
    if (next === 'done') this.log('update', `Ring ${ring} finished ${r.name}`, null)
    this.changed('rollouts', 'nodes', 'updates')
  }
}

function validateBenchConfig(config: BenchConfig, contextLength: number): BenchConfig {
  switch (config.kind) {
    case 'decode': {
      const concurrency = [...new Set(config.concurrency)].sort((a, b) => a - b)
      if (concurrency.length === 0) throw new SimError('invalid', 'Pick at least one concurrency level')
      if (concurrency.some((c) => !(CONCURRENCY_OPTIONS as readonly number[]).includes(c))) throw new SimError('invalid', `Concurrency must be one of ${CONCURRENCY_OPTIONS.join(', ')}`)
      if (!Number.isInteger(config.maxTokens) || config.maxTokens < MAX_TOKENS_RANGE.min || config.maxTokens > MAX_TOKENS_RANGE.max) {
        throw new SimError('invalid', `Max tokens must be ${MAX_TOKENS_RANGE.min}–${MAX_TOKENS_RANGE.max}`)
      }
      return { ...config, concurrency }
    }
    case 'prefill': {
      const contextSizes = [...new Set(config.contextSizes)].sort((a, b) => a - b)
      if (contextSizes.some((c) => !(CONTEXT_SIZES as readonly number[]).includes(c))) throw new SimError('invalid', 'Unknown context size')
      if (fittingContextSizes(contextSizes, contextLength).fit.length === 0) throw new SimError('invalid', 'Pick at least one context size that fits the model')
      return { ...config, contextSizes }
    }
    case 'quality': {
      const categories = QUALITY_CATEGORIES.filter((q) => config.categories.includes(q.id)).map((q) => q.id)
      if (categories.length === 0) throw new SimError('invalid', 'Pick at least one quality category')
      return { ...config, categories }
    }
    case 'tool-eval':
      if (config.suite !== 'quick' && config.suite !== 'full') throw new SimError('invalid', 'Unknown tool-eval suite')
      return { ...config }
  }
}
