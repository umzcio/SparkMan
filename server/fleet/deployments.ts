import type { CatalogModel, CreateDeploymentInput, Deployment, DeploymentStatus, Engine, Launcher, LauncherState, ModelCap } from '../../src/api/types.ts'
import { decodeSpeeds } from '../gateway/stats.ts'
import type { GatewayDb, RouteTable, RouteTarget } from '../gateway/store.ts'
import type { FleetDb } from './db.ts'
import { generatedTokens, TokenCounters } from './engine-metrics.ts'
import { engineCounts, EngineUsage } from './engine-usage.ts'
import { LauncherManager } from './launchers.ts'
import { shq } from './ssh.ts'

/** vLLM build proven on GB10 (arm64, CUDA 13); pinned by digest so every node runs the same bits. */
export const VLLM_IMAGE = 'vllm/vllm-openai@sha256:3dbe092ec5b2cef63b6104d33fa75d6ce53a7870962529ada69f78bbbc38e776'

export interface CatalogEntry extends CatalogModel {
  /** Hugging Face repo */
  repo: string
  /** --gpu-memory-utilization (share of the node's unified memory vLLM may take) */
  gpuMemFraction: number
  /** vLLM --tool-call-parser (tool calling needs it) and --reasoning-parser, when the model has them */
  toolParser?: string
  reasoningParser?: string
}

/** Models SparkMan can start itself with vLLM on one node. */
export const CATALOG: CatalogEntry[] = [
  { id: 'qwen3-0.6b', displayName: 'Qwen3 0.6B (smoke test)', repo: 'Qwen/Qwen3-0.6B', sizeGB: 1.5, quant: 'BF16', contextLength: 32768, engines: ['vLLM'], gpuMemFraction: 0.25, toolParser: 'hermes', reasoningParser: 'qwen3' },
  { id: 'qwen3-8b', displayName: 'Qwen3 8B', repo: 'Qwen/Qwen3-8B', sizeGB: 16.4, quant: 'BF16', contextLength: 32768, engines: ['vLLM'], gpuMemFraction: 0.5, toolParser: 'hermes', reasoningParser: 'qwen3' },
  { id: 'gpt-oss-20b', displayName: 'gpt-oss 20B', repo: 'openai/gpt-oss-20b', sizeGB: 13.8, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM'], gpuMemFraction: 0.5, toolParser: 'openai' },
  { id: 'qwen3-coder-30b-a3b-fp8', displayName: 'Qwen3 Coder 30B-A3B', repo: 'Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8', sizeGB: 31.5, quant: 'FP8', contextLength: 131072, engines: ['vLLM'], gpuMemFraction: 0.7, toolParser: 'qwen3_coder' },
  { id: 'gpt-oss-120b', displayName: 'gpt-oss 120B', repo: 'openai/gpt-oss-120b', sizeGB: 65, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM'], gpuMemFraction: 0.85, toolParser: 'openai' },
]

/** What the deployment manager needs from the fleet service. */
export interface DeployHost {
  /** `reported`: whether the node has sent a sample since SparkMan started (false right after a restart) */
  nodes(): { id: string; ip: string; status: string; drained: boolean; memoryGB: number; memUsedGB: number | null; reported?: boolean }[]
  /** ConnectX-7 groups from the site config, head first */
  groups(): { id: string; nodeIds: string[] }[]
  sh(id: string, command: string, opts?: { timeoutMs?: number; input?: string }): Promise<{ code: number; stdout: string }>
  activity(text: string, nodeId: string | null): void
  changed(topic: 'deployments' | 'nodes' | 'activity'): void
}

interface Managed {
  id: string
  catalogId: string
  nodeId: string
  port: number
  createdAt: number
  /** last state read from the node */
  state: string
}

interface Discovered {
  dep: Deployment
  routes: { name: string; target: RouteTarget }[]
}

const PROBE_MS = 2500
/** unified memory in use above which a group member counts as holding part of a model */
const LOADED_GB = 20
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '')

/** after a SparkMan start, how long a node that hasn't reported yet keeps its routes */
const STARTUP_GRACE_MS = 60_000

export class DeploymentManager {
  private host: DeployHost
  private db: FleetDb
  private gw: GatewayDb
  private now: () => number
  private fetch: typeof fetch
  private discovered: Discovered[] = []
  private firstSeen = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private readonly startedAt: number
  private rates: () => Map<string, { tokensPerSec: number; requestsPerSec: number }>
  /** generated tokens/s as the engines count them, so traffic that skips the gateway shows too */
  private counters = new TokenCounters()
  /** prompt / cached / generated tokens and requests per minute as the engines count them (the Usage page) */
  readonly engineUsage: EngineUsage
  /** single-request generation speed per deployment, from recent gateway requests */
  private speeds = new Map<string, number>()
  /** models the user's own scripts start (any engine, any number of nodes) */
  readonly launchers: LauncherManager

  constructor(host: DeployHost, db: FleetDb, gw: GatewayDb, opts: { now?: () => number; fetch?: typeof fetch; rates?: DeploymentManager['rates'] } = {}) {
    this.host = host
    this.db = db
    this.gw = gw
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
    this.fetch = opts.fetch ?? fetch
    this.rates = opts.rates ?? (() => new Map())
    db.db.exec('CREATE TABLE IF NOT EXISTS managed_deployments (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    this.engineUsage = new EngineUsage(db.db)
    this.launchers = new LauncherManager(host, db, { now: this.now, fetch: this.fetch })
  }

  start(): void {
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 15_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  catalog(): CatalogModel[] {
    return CATALOG.map(({ repo: _r, gpuMemFraction: _g, toolParser: _t, reasoningParser: _p, ...c }) => c)
  }

  private managed(): Managed[] {
    return (this.db.db.prepare('SELECT data FROM managed_deployments').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Managed)
  }

  private saveManaged(m: Managed | null, id?: string): void {
    if (m) this.db.db.prepare('INSERT OR REPLACE INTO managed_deployments (id, data) VALUES (?, ?)').run(m.id, JSON.stringify(m))
    else this.db.db.prepare('DELETE FROM managed_deployments WHERE id = ?').run(id ?? '')
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  }

  /**
   * The nodes a model served from `nodeId` spans: the head's ConnectX-7 group, minus members that hold no
   * model weights (a pair whose other half is idle isn't serving a tensor-parallel model).
   */
  private groupOf(nodeId: string, engine: Engine): string[] {
    // a launcher on this head says exactly which nodes it occupies
    const l = this.launchers.holding(nodeId)
    if (l?.nodeIds[0] === nodeId) return l.nodeIds
    const group = this.host.groups().find((g) => g.nodeIds[0] === nodeId)
    if (!group || engine === 'Ollama') return [nodeId]
    const nodes = this.host.nodes()
    return group.nodeIds.filter((id) => id === nodeId || (nodes.find((n) => n.id === id)?.memUsedGB ?? 0) > LOADED_GB)
  }

  private shown = new Map<string, { caps: ModelCap[]; contextLength: number; embedding: boolean }>()

  /** What Ollama says a model can do (tools, thinking, vision, embedding) and its context; once per digest. */
  private async ollamaShow(base: string, name: string, digest: string): Promise<{ caps: ModelCap[]; contextLength: number; embedding: boolean }> {
    const key = `${base}|${name}|${digest}`
    const hit = this.shown.get(key)
    if (hit) return hit
    const res = await this.fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(PROBE_MS) }).catch(() => null)
    const j = res?.ok ? ((await res.json().catch(() => null)) as { capabilities?: string[]; model_info?: Record<string, unknown> } | null) : null
    if (!j) return { caps: ['tools'], contextLength: 0, embedding: /embed/i.test(name) }
    const has = (c: string) => j.capabilities?.includes(c) ?? false
    const ctx = Object.entries(j.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1]
    const info = {
      caps: [...(has('tools') ? ['tools' as const] : []), ...(has('thinking') ? ['thinking' as const] : []), ...(has('vision') ? ['images' as const] : [])],
      contextLength: typeof ctx === 'number' ? ctx : 0,
      embedding: has('embedding') && !has('completion'),
    }
    this.shown.set(key, info)
    return info
  }

  /** One node's model servers. */
  private async probe(node: { id: string; ip: string; memUsedGB: number | null }): Promise<Discovered[]> {
    const out: Discovered[] = []
    const base = (port: number) => `http://${node.ip}:${port}`
    const make = (engine: Engine, port: number, name: string, status: DeploymentStatus, extra: Partial<Deployment> = {}, upstream = name): Discovered => {
      const id = `${slug(engine)}-${node.id}-${slug(name)}`
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, this.now())
      const nodeIds = this.groupOf(node.id, engine)
      return {
        dep: {
          id, model: name, displayName: name, engine, quant: '', replicas: [{ id: `${id}-r0`, nodeIds }], status, contextLength: 0, port,
          memoryGBPerNode: Math.round(node.memUsedGB ?? 0), createdAt: this.firstSeen.get(id)!, tokensPerSec: 0, requestsPerSec: 0, ...extra,
        },
        routes: [{ name, target: { deploymentId: id, engine, baseUrl: `${base(port)}/v1`, nodeIds, upstreamModel: upstream, contextLength: extra.contextLength ?? 0 } }],
      }
    }
    // llama-swap fronts its engines: every configured model is routable (it loads on demand); loaded ones are deployments
    const swap = (await this.getJson(`${base(9090)}/v1/models`).catch(() => null)) as { data?: { id: string }[] } | null
    if (swap?.data) {
      const running = (await this.getJson(`${base(9090)}/running`).catch(() => null)) as { running?: { model: string; state: string }[] } | null
      const state = new Map((running?.running ?? []).map((r) => [r.model, r.state]))
      for (const m of swap.data) {
        const ready = state.get(m.id) === 'ready'
        // a loaded model's engine may report its context (vLLM does; TensorFold doesn't)
        const up = ready ? ((await this.getJson(`${base(9090)}/upstream/${encodeURIComponent(m.id)}/v1/models`).catch(() => null)) as { data?: { max_model_len?: number }[] } | null) : null
        out.push(make('llama-swap', 9090, m.id, ready ? 'serving' : state.has(m.id) ? 'loading' : 'stopped', { contextLength: up?.data?.[0]?.max_model_len ?? 0 }))
      }
      return out
    }
    const ollama = (await this.getJson(`${base(11434)}/api/tags`).catch(() => null)) as { models?: { name: string; digest?: string; details?: { quantization_level?: string } }[] } | null
    for (const m of ollama?.models ?? []) {
      const show = await this.ollamaShow(base(11434), m.name, m.digest ?? '')
      const d = make('Ollama', 11434, m.name, 'serving', { quant: m.details?.quantization_level ?? '', contextLength: show.contextLength })
      Object.assign(d.routes[0].target, { caps: show.caps, embedding: show.embedding })
      out.push(d)
    }
    for (const [engine, port] of [['vLLM', 8000], ['SGLang', 30000], ['TensorFold', 8888]] as [Engine, number][]) {
      const v = (await this.getJson(`${base(port)}/v1/models`).catch(() => null)) as { data?: { id: string; max_model_len?: number }[] } | null
      for (const m of v?.data ?? []) out.push(make(engine, port, m.id, 'serving', { contextLength: m.max_model_len ?? 0 }))
    }
    return out
  }

  /** Probe every node, refresh SparkMan's own containers, and publish the gateway's route table. */
  async refresh(): Promise<void> {
    const nodes = this.host.nodes().filter((n) => n.status === 'online' || n.status === 'degraded')
    // SparkMan's own containers serve on 8100+, which discovery doesn't probe
    await this.launchers.refresh().catch(() => {})
    const launched = this.launchers.active()
    // a launcher's own server is reported (and routed) once, as the launcher
    const ownedByLauncher = (nodeId: string, d: Discovered) =>
      launched.some((l) => l.nodeIds[0] === nodeId && (d.dep.port === l.port || l.models.includes(d.dep.model)))
    this.discovered = (await Promise.all(nodes.map((n) => this.probe(n).then((ds) => ds.filter((d) => !ownedByLauncher(n.id, d))).catch(() => [])))).flat()
    await Promise.all(this.managed().map((m) => this.refreshManaged(m)))
    const routes = this.publishRoutes()
    await this.sampleEngines(routes)
    this.speeds = decodeSpeeds(this.gw, this.now())
    this.host.changed('deployments')
  }

  /** Read each serving engine's token counter once (a launcher serving several models is one server). */
  private async sampleEngines(models: RouteTable['models']): Promise<void> {
    const servers = new Map<string, { url: string; model: string }>()
    for (const [name, targets] of Object.entries(models)) {
      for (const t of targets) {
        // Ollama has no counter; llama-swap's would mix every model it fronts
        if (t.engine !== 'Ollama' && t.engine !== 'llama-swap' && !servers.has(t.deploymentId)) servers.set(t.deploymentId, { url: t.baseUrl.replace(/\/v1$/, '') + '/metrics', model: name })
      }
    }
    const ids = new Set(servers.keys())
    this.counters.keep(ids)
    this.engineUsage.keep(ids)
    const t = this.now()
    await Promise.all(
      [...servers].map(async ([id, { url, model }]) => {
        const res = await this.fetch(url, { signal: AbortSignal.timeout(PROBE_MS) }).catch(() => null)
        const text = res?.ok ? await res.text().catch(() => null) : null
        this.counters.record(id, t, text === null ? null : generatedTokens(text))
        this.engineUsage.record(id, model, t, text === null ? null : engineCounts(text))
      }),
    )
  }

  private publishRoutes(): RouteTable['models'] {
    // just after SparkMan starts no node has reported yet: one that hasn't is not down, or the first table routes nothing
    const settling = this.now() - this.startedAt < STARTUP_GRACE_MS
    const drained = new Set(this.host.nodes().filter((n) => n.drained || (n.status !== 'online' && n.status !== 'degraded' && !(settling && n.reported === false))).map((n) => n.id))
    const models: RouteTable['models'] = {}
    const add = (name: string, t: RouteTarget) => {
      if (t.nodeIds.some((id) => drained.has(id))) return
      ;(models[name] ??= []).push(t)
    }
    for (const d of this.discovered) for (const r of d.routes) add(r.name, r.target)
    for (const l of this.launchers.active()) {
      if (l.state !== 'serving') continue
      const head = this.host.nodes().find((n) => n.id === l.nodeIds[0])
      if (head) for (const model of l.models) add(model, { deploymentId: l.id, engine: l.engine, baseUrl: `http://${head.ip}:${l.port}/v1`, nodeIds: l.nodeIds, upstreamModel: model, contextLength: l.contextLength, maxOutput: l.maxOutput, caps: l.caps, label: l.name })
    }
    for (const m of this.managed()) {
      if (m.state !== 'serving') continue
      const node = this.host.nodes().find((n) => n.id === m.nodeId)
      if (node) add(m.catalogId, { deploymentId: m.id, engine: 'vLLM', baseUrl: `http://${node.ip}:${m.port}/v1`, nodeIds: [m.nodeId], upstreamModel: m.catalogId, ...catalogMeta(m.catalogId) })
    }
    this.gw.setRoutes({ updatedAt: this.now(), models })
    return models
  }

  private async refreshManaged(m: Managed): Promise<void> {
    const node = this.host.nodes().find((n) => n.id === m.nodeId)
    if (!node || (node.status !== 'online' && node.status !== 'degraded')) return
    if (m.state === 'stopping') {
      // asked to stop while the node was away: finish it now that it's back
      await this.host.sh(m.nodeId, `sudo -n docker rm -f sparkman-${m.id} >/dev/null 2>&1; sudo -n rm -f /var/lib/sparkman-deploy/${m.id}.state`, { timeoutMs: 60_000 })
      this.saveManaged(null, m.id)
      this.host.activity(`Stopped ${m.catalogId} on ${m.nodeId} (queued while it was offline)`, m.nodeId)
      return
    }
    const r = await this.host.sh(m.nodeId, `sudo -n cat /var/lib/sparkman-deploy/${m.id}.state 2>/dev/null; sudo -n docker inspect -f '{{.State.Status}}' sparkman-${m.id} 2>/dev/null`, { timeoutMs: 15_000 })
    const [launcher = '', container = ''] = r.stdout.trim().split('\n')
    let state = launcher.startsWith('failed') ? launcher : container === 'running' ? 'loading' : container ? `failed: container ${container}` : launcher || 'pending'
    if (state === 'loading') {
      const ok = await this.getJson(`http://${node.ip}:${m.port}/v1/models`).then(() => true, () => false)
      // a busy server can miss one probe: once serving, a running container stays serving
      if (ok || m.state === 'serving') state = 'serving'
    }
    if (state !== m.state) {
      if (state === 'serving') this.host.activity(`${m.catalogId} is serving on ${m.nodeId}`, m.nodeId)
      if (state.startsWith('failed')) this.host.activity(`${m.catalogId} on ${m.nodeId} ${state}`, m.nodeId)
      this.saveManaged({ ...m, state })
    }
  }

  list(): Deployment[] {
    const rates = this.rates()
    const withRates = (d: Deployment): Deployment => {
      const engine = this.counters.rate(d.id)
      return {
        ...d, tokensPerSec: engine ?? rates.get(d.id)?.tokensPerSec ?? 0, tokensPerSecFrom: engine === null ? 'gateway' : 'engine',
        requestsPerSec: rates.get(d.id)?.requestsPerSec ?? 0, decodeTokensPerSec: this.speeds.get(d.id) ?? null,
      }
    }
    const managed = this.managed().map((m): Deployment => {
      const c = CATALOG.find((x) => x.id === m.catalogId)
      const status: DeploymentStatus = m.state === 'serving' ? 'serving' : m.state === 'stopping' ? 'stopped' : m.state.startsWith('failed') ? 'degraded' : m.state === 'pending' || m.state === 'pulling' ? 'pending' : 'loading'
      return {
        id: m.id, model: m.catalogId, displayName: c?.displayName ?? m.catalogId, engine: 'vLLM', quant: c?.quant ?? '', replicas: [{ id: `${m.id}-r0`, nodeIds: [m.nodeId] }],
        status, contextLength: c?.contextLength ?? 0, port: m.port, memoryGBPerNode: Math.round((c?.gpuMemFraction ?? 0) * 128), createdAt: m.createdAt, tokensPerSec: 0, requestsPerSec: 0,
      }
    })
    const mem = new Map(this.host.nodes().map((n) => [n.id, n.memUsedGB ?? 0]))
    const launched = this.launchers.active().map((l) => launcherDeployment(l, l.startedAt ?? this.now(), Math.round(mem.get(l.nodeIds[0]) ?? 0)))
    // llama-swap's unloaded models are routable but not deployments
    return [...this.discovered.map((d) => d.dep).filter((d) => d.status !== 'stopped'), ...managed, ...launched].map(withRates)
  }

  /** The deployment (and group) a node belongs to, for the node cards. */
  nodeDeployment(nodeId: string): { deploymentId: string | null; groupId: string | null } {
    const on = this.list().filter((x) => x.replicas.some((r) => r.nodeIds.includes(nodeId)))
    // the model that holds the node, ahead of an Ollama sharing it
    const d = on.find((x) => x.engine !== 'Ollama') ?? on[0]
    if (!d) return { deploymentId: null, groupId: null }
    const replica = d.replicas.find((r) => r.nodeIds.includes(nodeId))!
    return { deploymentId: d.id, groupId: replica.nodeIds.length > 1 ? replica.id : null }
  }

  async create(input: CreateDeploymentInput): Promise<Deployment> {
    const c = CATALOG.find((x) => x.id === input.catalogId)
    if (!c) throw new Error(`Unknown catalog model ${input.catalogId}`)
    if (input.engine !== 'vLLM') throw new Error('SparkMan starts models with vLLM')
    if (input.nodeIds.length !== 1) throw new Error('SparkMan deploys to one node at a time (multi-node groups come later)')
    const node = this.host.nodes().find((n) => n.id === input.nodeIds[0])
    if (!node) throw new Error('Unknown node')
    if (node.status !== 'online' && node.status !== 'degraded') throw new Error(`${node.id} is ${node.status}`)
    if (node.drained) throw new Error(`${node.id} is drained`)
    if (this.list().some((d) => d.replicas.some((r) => r.nodeIds.includes(node.id)))) throw new Error(`${node.id} already serves a model`)
    const free = node.memoryGB - (node.memUsedGB ?? node.memoryGB)
    const needs = c.gpuMemFraction * node.memoryGB
    if (needs > free - 4) throw new Error(`${c.displayName} needs ~${Math.round(needs)} GB on ${node.id}; ${Math.round(free)} GB is free`)
    const used = new Set(this.managed().filter((m) => m.nodeId === node.id).map((m) => m.port))
    let port = 8100
    while (used.has(port)) port++
    const id = `dep-${this.now().toString(36)}`
    const name = `sparkman-${id}`
    const dir = '/var/lib/sparkman-deploy'
    const run = [
      'docker run -d', `--name ${name}`, '--restart unless-stopped', '--gpus all', '--ipc host', '--network host',
      '-v /root/.cache/huggingface:/root/.cache/huggingface', VLLM_IMAGE,
      shq(c.repo), `--port ${port}`, `--served-model-name ${shq(c.id)}`, `--gpu-memory-utilization ${c.gpuMemFraction}`, `--max-model-len ${c.contextLength}`,
      ...(c.toolParser ? ['--enable-auto-tool-choice', `--tool-call-parser ${c.toolParser}`] : []),
      ...(c.reasoningParser ? [`--reasoning-parser ${c.reasoningParser}`] : []),
    ].join(' ')
    // detached so the SSH call returns at once; the state file tracks pull → start
    const script = `set -e
mkdir -p ${dir} /root/.cache/huggingface
echo pulling > ${dir}/${id}.state
setsid nohup sh -c '
  if docker pull ${VLLM_IMAGE} >${dir}/${id}.log 2>&1; then
    echo starting > ${dir}/${id}.state
    if ${run.replace(/'/g, `'\\''`)} >>${dir}/${id}.log 2>&1; then echo started > ${dir}/${id}.state; else echo "failed: docker run (see ${dir}/${id}.log)" > ${dir}/${id}.state; fi
  else
    echo "failed: docker pull (see ${dir}/${id}.log)" > ${dir}/${id}.state
  fi' </dev/null >/dev/null 2>&1 &
`
    const r = await this.host.sh(node.id, 'sudo -n bash -s', { input: script, timeoutMs: 30_000 })
    if (r.code !== 0) throw new Error(`Couldn't start the deployment on ${node.id} (exit ${r.code})`)
    this.saveManaged({ id, catalogId: c.id, nodeId: node.id, port, createdAt: this.now(), state: 'pulling' })
    this.host.activity(`Deploying ${c.displayName} on ${node.id} (vLLM, port ${port})`, node.id)
    this.host.changed('deployments')
    this.host.changed('nodes')
    return this.list().find((d) => d.id === id)!
  }

  /** Start a launcher, unless one of its nodes serves something else. */
  async startLauncher(id: string): Promise<Launcher> {
    const others = new Map<string, string>()
    // Ollama loads on demand and unloads when idle, so it shares a node instead of holding it
    for (const d of this.list()) if (d.launcherId !== id && d.engine !== 'Ollama') for (const r of d.replicas) for (const n of r.nodeIds) others.set(n, d.model)
    const l = await this.launchers.start(id, others)
    void this.refresh()
    return l
  }

  async stopDeployment(id: string): Promise<void> {
    if (this.launchers.list().some((l) => l.id === id)) {
      await this.launchers.stop(id)
      this.host.changed('nodes')
      return
    }
    const m = this.managed().find((x) => x.id === id)
    if (m) {
      const node = this.host.nodes().find((n) => n.id === m.nodeId)
      if (!node || (node.status !== 'online' && node.status !== 'degraded')) {
        this.saveManaged({ ...m, state: 'stopping' })
        this.host.activity(`Stop of ${m.catalogId} queued until ${m.nodeId} is back`, m.nodeId)
        this.host.changed('deployments')
        return
      }
      await this.host.sh(m.nodeId, `sudo -n docker rm -f sparkman-${m.id} >/dev/null 2>&1; sudo -n rm -f /var/lib/sparkman-deploy/${m.id}.state`, { timeoutMs: 60_000 })
      this.saveManaged(null, id)
      this.host.activity(`Stopped ${m.catalogId} on ${m.nodeId}`, m.nodeId)
    } else {
      const d = this.discovered.find((x) => x.dep.id === id)
      if (!d) throw new Error('Deployment not found')
      if (d.dep.engine !== 'llama-swap') throw new Error(`${d.dep.engine} deployments are managed on the node itself`)
      const head = this.host.nodes().find((n) => n.id === d.dep.replicas[0].nodeIds[0])
      if (!head) throw new Error('Head node not found')
      const res = await this.fetch(`http://${head.ip}:9090/unload`, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`llama-swap refused to unload (${res.status})`)
      this.host.activity(`Unloaded ${d.dep.model} from llama-swap on ${head.id}`, head.id)
    }
    await this.refresh()
    this.host.changed('nodes')
  }
}

/** what the catalog knows about a model SparkMan started: its window, name, and the parsers it was started with */
function catalogMeta(id: string): Pick<RouteTarget, 'contextLength' | 'caps' | 'label'> {
  const c = CATALOG.find((x) => x.id === id)
  if (!c) return {}
  return { contextLength: c.contextLength, label: c.displayName, caps: [...(c.toolParser ? ['tools' as const] : []), ...(c.reasoningParser ? ['thinking' as const] : [])] }
}

const LAUNCHER_STATUS: Record<LauncherState, DeploymentStatus> = {
  idle: 'stopped', starting: 'loading', serving: 'serving', down: 'degraded', stopping: 'stopped', failed: 'degraded',
}

/** A launcher that holds its nodes, as a deployment row. */
function launcherDeployment(l: Launcher, createdAt: number, memoryGBPerNode: number): Deployment {
  return {
    id: l.id, model: l.models[0] ?? l.name, displayName: l.name, engine: l.engine, quant: '', replicas: [{ id: `${l.id}-r0`, nodeIds: l.nodeIds }],
    status: LAUNCHER_STATUS[l.state], contextLength: l.contextLength, port: l.port, memoryGBPerNode, createdAt, tokensPerSec: 0, requestsPerSec: 0, launcherId: l.id,
  }
}
