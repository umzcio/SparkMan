import type { FleetConfig, SparkManClient, ClientEvent } from './client'
import type {
  ActivityEvent, AlertRule, ApiKey, BenchRun, BenchRunFilter, CatalogModel, StartBenchInput, CreateDeploymentInput, Deployment, Launcher, LauncherInput, FleetNode, FleetSummary, GatewayInfo, GatewayPoint, GatewayRoute,
  GpuProcess, Incident, LogQueryInput, NodeUpdateStatus, Rollout, StartRolloutInput, UsageReport, LogQueryResult, MetricPoint, NodeHealth, NodeInventory, SimEvent,
  SparkToolEnvelope, TimeRange, CoolingPoint, CoolingPolicy, CoolingState, NetworkState,
} from './types'
import type { FleetArea } from '@/lib/data-source'

/** Areas the backend serves today (GET /api/fleet/health → { live }). */
export interface FleetHealth {
  ok: boolean
  live: string[]
}

/** Which area each client method belongs to; a method goes to the backend once its area is live. */
export const METHOD_AREAS: Record<keyof SparkManClient, FleetArea | null> = {
  listNodes: 'nodes', getNode: 'nodes', getNodeMetrics: 'nodes', getNodeProcesses: 'nodes', getNodeInventory: 'nodes', getNodeHealth: 'nodes',
  rebootNode: 'nodes', setNodeDrained: 'nodes', setNodeMaintenance: 'nodes', runDiagnostics: 'nodes', collectBundle: 'nodes', getFleetSummary: 'nodes', getFleetConfig: 'nodes',
  listActivity: 'nodes',
  listDeployments: 'deployments', listCatalog: 'deployments', createDeployment: 'deployments', stopDeployment: 'deployments',
  listLaunchers: 'deployments', createLauncher: 'deployments', updateLauncher: 'deployments', deleteLauncher: 'deployments', startLauncher: 'deployments', getLauncherLog: 'deployments',
  getGatewayInfo: 'gateway', getGatewaySeries: 'gateway', listRoutes: 'gateway',
  getUsage: 'usage',
  listKeys: 'keys', createKey: 'keys', revokeKey: 'keys',
  queryLogs: 'logs',
  listIncidents: 'alerts', resolveIncident: 'alerts', listAlertRules: 'alerts', setAlertRuleEnabled: 'alerts',
  listNodeUpdates: 'updates', listRollouts: 'updates', startRollout: 'updates', approveRollout: 'updates', cancelRollout: 'updates',
  listBenchRuns: 'benchmarks', getBenchRun: 'benchmarks', startBench: 'benchmarks', cancelBench: 'benchmarks', deleteBenchRun: 'benchmarks',
  getCooling: 'cooling', getCoolingSeries: 'cooling', setFanOverride: 'cooling', setCoolingPolicy: 'cooling', setFanZones: 'cooling',
  getNetwork: 'network',
  // the simulator's failure switches never exist on a real fleet
  getFailures: null, setFailures: null,
  subscribe: null,
}

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  const data = (await res.json().catch(() => null)) as T | { error?: string } | null
  if (!res.ok) throw new HttpError(res.status, (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`)
  return data as T
}

export const enc = encodeURIComponent

// Methods not implemented on the class (or whose area isn't live) are bound to the fallback in the constructor.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface LiveClient extends SparkManClient {}

/**
 * The phase-2 client: every method whose area is live talks to the SparkMan host (/api/fleet); the rest
 * go to `fallback` (NullClient in production, so nothing simulated appears next to real data).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class LiveClient implements SparkManClient {
  readonly liveAreas: ReadonlySet<FleetArea>

  constructor(fallback: SparkManClient, liveAreas: ReadonlySet<FleetArea>) {
    this.liveAreas = liveAreas
    for (const key of Object.keys(METHOD_AREAS) as (keyof SparkManClient)[]) {
      if (key === 'subscribe') continue
      const area = METHOD_AREAS[key]
      const own = Object.prototype.hasOwnProperty.call(LiveClient.prototype, key)
      if (own && area !== null && liveAreas.has(area)) continue
      const fn = (fallback as unknown as Record<string, unknown>)[key]
      if (typeof fn === 'function') (this as unknown as Record<string, unknown>)[key] = fn.bind(fallback)
    }
  }

  /** The backend's live areas, or null when this host has no fleet (dev or e2e): use the simulator alone. */
  static async probe(): Promise<FleetHealth | null> {
    try {
      const res = await fetch('/api/fleet/health', { credentials: 'same-origin' })
      if (!res.ok) return null
      return (await res.json()) as FleetHealth
    } catch {
      return null
    }
  }

  // ---------- nodes ----------

  listNodes(): Promise<FleetNode[]> {
    return call('GET', '/api/fleet/nodes')
  }

  async getNode(id: string): Promise<FleetNode | null> {
    try {
      return await call<FleetNode>('GET', `/api/fleet/nodes/${enc(id)}`)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null
      throw e
    }
  }

  getNodeMetrics(id: string, range: TimeRange): Promise<MetricPoint[]> {
    return call('GET', `/api/fleet/nodes/${enc(id)}/metrics?range=${enc(range)}`)
  }

  getNodeProcesses(id: string): Promise<GpuProcess[]> {
    return call('GET', `/api/fleet/nodes/${enc(id)}/processes`)
  }

  getNodeInventory(id: string): Promise<NodeInventory> {
    return call('GET', `/api/fleet/nodes/${enc(id)}/inventory`)
  }

  getNodeHealth(id: string): Promise<NodeHealth> {
    return call('GET', `/api/fleet/nodes/${enc(id)}/health`)
  }

  async rebootNode(id: string): Promise<void> {
    await call('POST', `/api/fleet/nodes/${enc(id)}/reboot`)
  }

  async setNodeMaintenance(id: string, on: boolean): Promise<void> {
    await call('POST', `/api/fleet/nodes/${enc(id)}/maintenance`, { maintenance: on })
  }

  async setNodeDrained(id: string, drained: boolean): Promise<void> {
    await call('POST', `/api/fleet/nodes/${enc(id)}/drain`, { drained })
  }

  runDiagnostics(id: string): Promise<SparkToolEnvelope> {
    return call('POST', `/api/fleet/nodes/${enc(id)}/diagnostics`)
  }

  collectBundle(id: string): Promise<SparkToolEnvelope> {
    return call('POST', `/api/fleet/nodes/${enc(id)}/bundle`)
  }

  getFleetSummary(): Promise<FleetSummary> {
    return call('GET', '/api/fleet/summary')
  }

  getFleetConfig(): Promise<FleetConfig> {
    return call('GET', '/api/fleet/config')
  }

  listActivity(limit = 50): Promise<ActivityEvent[]> {
    return call('GET', `/api/fleet/activity?limit=${limit}`)
  }

  // ---------- logs ----------

  queryLogs(input: LogQueryInput): Promise<LogQueryResult> {
    return call('POST', '/api/fleet/logs/query', input)
  }

  // ---------- alerts ----------

  listIncidents(): Promise<Incident[]> {
    return call('GET', '/api/fleet/incidents')
  }

  async resolveIncident(id: string): Promise<void> {
    await call('POST', `/api/fleet/incidents/${enc(id)}/resolve`)
  }

  listAlertRules(): Promise<AlertRule[]> {
    return call('GET', '/api/fleet/rules')
  }

  async setAlertRuleEnabled(id: string, enabled: boolean): Promise<void> {
    await call('POST', `/api/fleet/rules/${enc(id)}`, { enabled })
  }

  // ---------- network ----------

  getNetwork(): Promise<NetworkState> {
    return call('GET', '/api/fleet/network')
  }

  // ---------- cooling ----------

  getCooling(): Promise<CoolingState> {
    return call('GET', '/api/fleet/cooling')
  }

  getCoolingSeries(range: TimeRange): Promise<CoolingPoint[]> {
    return call('GET', `/api/fleet/cooling/series?range=${enc(range)}`)
  }

  async setFanOverride(fanId: string, duty: number | null): Promise<void> {
    await call('POST', `/api/fleet/cooling/fans/${enc(fanId)}/override`, { duty })
  }

  async setCoolingPolicy(patch: Partial<CoolingPolicy>): Promise<void> {
    await call('PUT', '/api/fleet/cooling/policy', patch)
  }

  async setFanZones(zones: Record<string, string[]>): Promise<void> {
    await call('PUT', '/api/fleet/cooling/zones', { zones })
  }

  // ---------- updates ----------

  listNodeUpdates(): Promise<NodeUpdateStatus[]> {
    return call('GET', '/api/fleet/updates')
  }

  listRollouts(): Promise<Rollout[]> {
    return call('GET', '/api/fleet/rollouts')
  }

  startRollout(input: StartRolloutInput): Promise<Rollout> {
    return call('POST', '/api/fleet/rollouts', input)
  }

  async approveRollout(id: string): Promise<void> {
    await call('POST', `/api/fleet/rollouts/${enc(id)}/approve`)
  }

  async cancelRollout(id: string): Promise<void> {
    await call('POST', `/api/fleet/rollouts/${enc(id)}/cancel`)
  }

  // ---------- deployments, gateway, usage, keys ----------

  listDeployments(): Promise<Deployment[]> {
    return call('GET', '/api/fleet/deployments')
  }

  listCatalog(): Promise<CatalogModel[]> {
    return call('GET', '/api/fleet/catalog')
  }

  createDeployment(input: CreateDeploymentInput): Promise<Deployment> {
    return call('POST', '/api/fleet/deployments', input)
  }

  async stopDeployment(id: string): Promise<void> {
    await call('POST', `/api/fleet/deployments/${enc(id)}/stop`)
  }

  listLaunchers(): Promise<Launcher[]> {
    return call('GET', '/api/fleet/launchers')
  }

  createLauncher(input: LauncherInput): Promise<Launcher> {
    return call('POST', '/api/fleet/launchers', input)
  }

  updateLauncher(id: string, input: LauncherInput): Promise<Launcher> {
    return call('PUT', `/api/fleet/launchers/${enc(id)}`, input)
  }

  async deleteLauncher(id: string): Promise<void> {
    await call('DELETE', `/api/fleet/launchers/${enc(id)}`)
  }

  startLauncher(id: string): Promise<Launcher> {
    return call('POST', `/api/fleet/launchers/${enc(id)}/start`)
  }

  async getLauncherLog(id: string): Promise<string> {
    return (await call<{ text: string }>('GET', `/api/fleet/launchers/${enc(id)}/log`)).text
  }

  getGatewayInfo(): Promise<GatewayInfo> {
    return call('GET', '/api/fleet/gateway/info')
  }

  getGatewaySeries(range: TimeRange): Promise<GatewayPoint[]> {
    return call('GET', `/api/fleet/gateway/series?range=${enc(range)}`)
  }

  listRoutes(): Promise<GatewayRoute[]> {
    return call('GET', '/api/fleet/gateway/routes')
  }

  getUsage(range: TimeRange): Promise<UsageReport> {
    return call('GET', `/api/fleet/usage?range=${enc(range)}`)
  }

  listKeys(): Promise<ApiKey[]> {
    return call('GET', '/api/fleet/keys')
  }

  createKey(input: { name: string; rateLimitRpm: number }): Promise<{ key: ApiKey; secret: string }> {
    return call('POST', '/api/fleet/keys', input)
  }

  async revokeKey(id: string): Promise<void> {
    await call('POST', `/api/fleet/keys/${enc(id)}/revoke`)
  }

  // ---------- benchmarks ----------

  listBenchRuns(filter: BenchRunFilter = {}): Promise<BenchRun[]> {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v !== undefined) as [string, string][])
    return call('GET', `/api/fleet/benchmarks${q.size ? `?${q}` : ''}`)
  }

  async getBenchRun(id: string): Promise<BenchRun | null> {
    try {
      return await call<BenchRun>('GET', `/api/fleet/benchmarks/${enc(id)}`)
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null
      throw e
    }
  }

  startBench(input: StartBenchInput): Promise<BenchRun> {
    return call('POST', '/api/fleet/benchmarks', input)
  }

  async cancelBench(id: string): Promise<void> {
    await call('POST', `/api/fleet/benchmarks/${enc(id)}/cancel`)
  }

  async deleteBenchRun(id: string): Promise<void> {
    await call('POST', `/api/fleet/benchmarks/${enc(id)}/delete`)
  }

  /** Ticks and change notifications from the host. */
  subscribe(listener: (e: ClientEvent) => void): () => void {
    let source: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const open = () => {
      source = new EventSource('/api/fleet/events', { withCredentials: true })
      source.onmessage = (m) => {
        try {
          listener(JSON.parse(m.data) as SimEvent)
        } catch {
          // ignore malformed frames
        }
      }
      source.onerror = () => {
        source?.close()
        if (!closed) retry = setTimeout(open, 3000)
      }
    }
    open()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      source?.close()
    }
  }
}
