import { DEFAULT_POLICY } from '@/lib/cooling'
import type { ClientEvent, FleetConfig, SparkManClient } from './client'
import type {
  ActivityEvent, AlertRule, ApiKey, BenchRun, CatalogModel, CoolingPoint, CoolingState, Deployment, NetworkState, FailureInjection, Launcher, FleetNode, FleetSummary,
  GatewayInfo, GatewayPoint, GatewayRoute, GpuProcess, Incident, LogQueryInput, LogQueryResult, MetricPoint, NodeHealth, NodeInventory,
  NodeUpdateStatus, Rollout, SparkToolEnvelope, TimeRange, UsageReport,
} from './types'

const SERIES_POINTS = 120
const RANGE_MS: Record<TimeRange, number> = { '15m': 900_000, '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }

function times(range: TimeRange): number[] {
  const step = RANGE_MS[range] / SERIES_POINTS
  const end = Math.floor(Date.now() / step) * step
  return Array.from({ length: SERIES_POINTS }, (_, i) => end - (SERIES_POINTS - 1 - i) * step)
}

const notConnected = (what: string) => Promise.reject(new Error(`${what} isn't connected yet.`))

/**
 * Production stand-in for areas whose backend isn't built: empty data and refused actions, never
 * simulated values. LiveClient replaces it method by method as areas go live.
 */
export class NullClient implements SparkManClient {
  async listNodes(): Promise<FleetNode[]> { return [] }
  async getNode(): Promise<FleetNode | null> { return null }
  async getNodeMetrics(): Promise<MetricPoint[]> { return [] }
  async getNodeProcesses(): Promise<GpuProcess[]> { return [] }
  getNodeInventory(): Promise<NodeInventory> { return notConnected('Inventory') }
  getNodeHealth(): Promise<NodeHealth> { return notConnected('Health') }
  rebootNode(): Promise<void> { return notConnected('Reboot') }
  setNodeDrained(): Promise<void> { return notConnected('Drain') }
  setNodeMaintenance(): Promise<void> { return notConnected('Maintenance') }
  runDiagnostics(): Promise<SparkToolEnvelope> { return notConnected('Diagnostics') }
  collectBundle(): Promise<SparkToolEnvelope> { return notConnected('Diagnostics') }
  async getFleetSummary(): Promise<FleetSummary> {
    return { online: 0, total: 0, gpuUtilAvg: 0, memUsedGB: 0, memTotalGB: 0, powerW: 0, tokensPerSec: 0, activeIncidents: 0 }
  }
  async getFleetConfig(): Promise<FleetConfig> { return { sshUser: '', sshKeyPath: '', hosts: [] } }
  async listDeployments(): Promise<Deployment[]> { return [] }
  async listCatalog(): Promise<CatalogModel[]> { return [] }
  createDeployment(): Promise<Deployment> { return notConnected('Deployments') }
  stopDeployment(): Promise<void> { return notConnected('Deployments') }
  async listLaunchers(): Promise<Launcher[]> { return [] }
  createLauncher(): Promise<Launcher> { return notConnected('Deployments') }
  updateLauncher(): Promise<Launcher> { return notConnected('Deployments') }
  deleteLauncher(): Promise<void> { return notConnected('Deployments') }
  startLauncher(): Promise<Launcher> { return notConnected('Deployments') }
  getLauncherLog(): Promise<string> { return notConnected('Deployments') }
  async getGatewayInfo(): Promise<GatewayInfo> { return { baseUrl: '', defaultModel: '', models: [] } }
  async getGatewaySeries(range: TimeRange): Promise<GatewayPoint[]> {
    return times(range).map((t) => ({ t, rps: 0, p50Ms: 0, p95Ms: 0, ttftMs: 0, errorRate: 0, tokensPerSec: 0 }))
  }
  async listRoutes(): Promise<GatewayRoute[]> { return [] }
  async getUsage(range: TimeRange): Promise<UsageReport> {
    return {
      points: times(range).map((t) => ({ t, requests: 0, byModel: {}, byKey: {} })),
      tokensIn: 0, tokensCached: 0, tokensOut: 0, requests: 0, cloudCostUsd: 0, topKeys: [], models: [], modelTotals: [], keys: [],
    }
  }
  async listKeys(): Promise<ApiKey[]> { return [] }
  createKey(): Promise<{ key: ApiKey; secret: string }> { return notConnected('API keys') }
  revokeKey(): Promise<void> { return notConnected('API keys') }
  async queryLogs(input: LogQueryInput): Promise<LogQueryResult> {
    const to = Date.now()
    const from = input.around !== undefined ? input.around - 60_000 : to - RANGE_MS[input.range]
    return { lines: [], histogram: [], total: 0, truncated: false, bands: [], from, to }
  }
  async listIncidents(): Promise<Incident[]> { return [] }
  resolveIncident(): Promise<void> { return notConnected('Alerts') }
  async listAlertRules(): Promise<AlertRule[]> { return [] }
  setAlertRuleEnabled(): Promise<void> { return notConnected('Alerts') }
  async listNodeUpdates(): Promise<NodeUpdateStatus[]> { return [] }
  async listRollouts(): Promise<Rollout[]> { return [] }
  startRollout(): Promise<Rollout> { return notConnected('Updates') }
  approveRollout(): Promise<void> { return notConnected('Updates') }
  cancelRollout(): Promise<void> { return notConnected('Updates') }
  async listBenchRuns(): Promise<BenchRun[]> { return [] }
  async getBenchRun(): Promise<BenchRun | null> { return null }
  startBench(): Promise<BenchRun> { return notConnected('Benchmarks') }
  cancelBench(): Promise<void> { return notConnected('Benchmarks') }
  deleteBenchRun(): Promise<void> { return notConnected('Benchmarks') }
  async listActivity(): Promise<ActivityEvent[]> { return [] }
  async getFailures(): Promise<FailureInjection> {
    return { nodeOffline: null, gatewayErrors: false, xidStorm: false, apiErrors: false, picoDisconnected: false, fanStalled: null }
  }
  setFailures(): Promise<void> { return notConnected('The simulator') }
  async getCooling(): Promise<CoolingState> {
    return {
      controller: { connected: false, port: '', firmware: '', lastHeartbeatAt: null, watchdogMs: 10_000, failsafe: false },
      fans: [],
      policy: structuredClone(DEFAULT_POLICY),
      maxRpm: 0,
    }
  }
  async getCoolingSeries(): Promise<CoolingPoint[]> { return [] }
  setFanOverride(): Promise<void> { return notConnected('Cooling') }
  setCoolingPolicy(): Promise<void> { return notConnected('Cooling') }
  setFanZones(): Promise<void> { return notConnected('Cooling') }
  async getNetwork(): Promise<NetworkState> { return { switches: [], nodes: [] } }
  subscribe(listener: (e: ClientEvent) => void): () => void {
    const t = setInterval(() => listener({ type: 'tick', now: Date.now() }), 2000)
    return () => clearInterval(t)
  }
}
