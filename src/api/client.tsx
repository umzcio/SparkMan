import { createContext, useContext, type ReactNode } from 'react'
import type {
  AlertRule, ApiKey, ActivityEvent, BenchRun, BenchRunFilter, CatalogModel, CoolingPoint, CoolingPolicy, CoolingState, NetworkState, CreateDeploymentInput, Deployment, Launcher, LauncherInput, FailureInjection, FleetNode, FleetSummary,
  GatewayInfo, GatewayPoint, GatewayRoute, GpuProcess, Incident, LogQueryInput, LogQueryResult, MetricPoint, NodeHealth,
  NodeInventory, NodeUpdateStatus, Rollout, SimEvent, SparkToolEnvelope, StartBenchInput, StartRolloutInput, TimeRange, UsageReport,
} from './types'

export type ClientEvent = SimEvent

export interface FleetConfig {
  sshUser: string
  sshKeyPath: string
  hosts: { id: string; ip: string }[]
}

export interface SparkManClient {
  listNodes(): Promise<FleetNode[]>
  getNode(id: string): Promise<FleetNode | null>
  getNodeMetrics(id: string, range: TimeRange): Promise<MetricPoint[]>
  getNodeProcesses(id: string): Promise<GpuProcess[]>
  getNodeInventory(id: string): Promise<NodeInventory>
  getNodeHealth(id: string): Promise<NodeHealth>
  rebootNode(id: string): Promise<void>
  setNodeDrained(id: string, drained: boolean): Promise<void>
  setNodeMaintenance(id: string, on: boolean): Promise<void>
  runDiagnostics(id: string): Promise<SparkToolEnvelope>
  /** Collect an L2 evidence bundle (spark_diagctl.py); rejects for unknown or unreachable nodes. */
  collectBundle(id: string): Promise<SparkToolEnvelope>
  getFleetSummary(): Promise<FleetSummary>
  getFleetConfig(): Promise<FleetConfig>
  listDeployments(): Promise<Deployment[]>
  listCatalog(): Promise<CatalogModel[]>
  createDeployment(input: CreateDeploymentInput): Promise<Deployment>
  stopDeployment(id: string): Promise<void>
  /** models started by the user's own scripts (Deployments → Launchers) */
  listLaunchers(): Promise<Launcher[]>
  createLauncher(input: LauncherInput): Promise<Launcher>
  updateLauncher(id: string, input: LauncherInput): Promise<Launcher>
  deleteLauncher(id: string): Promise<void>
  startLauncher(id: string): Promise<Launcher>
  /** the last few hundred lines the scripts printed on the head */
  getLauncherLog(id: string): Promise<string>
  getGatewayInfo(): Promise<GatewayInfo>
  getGatewaySeries(range: TimeRange): Promise<GatewayPoint[]>
  listRoutes(): Promise<GatewayRoute[]>
  getUsage(range: TimeRange): Promise<UsageReport>
  listKeys(): Promise<ApiKey[]>
  createKey(input: { name: string; rateLimitRpm: number }): Promise<{ key: ApiKey; secret: string }>
  revokeKey(id: string): Promise<void>
  queryLogs(input: LogQueryInput): Promise<LogQueryResult>
  listIncidents(): Promise<Incident[]>
  resolveIncident(id: string): Promise<void>
  listAlertRules(): Promise<AlertRule[]>
  setAlertRuleEnabled(id: string, enabled: boolean): Promise<void>
  listNodeUpdates(): Promise<NodeUpdateStatus[]>
  listRollouts(): Promise<Rollout[]>
  startRollout(input: StartRolloutInput): Promise<Rollout>
  approveRollout(id: string): Promise<void>
  /** Reject a rollout that is awaiting approval (it ends as 'failed'); conflicts for any other status. */
  cancelRollout(id: string): Promise<void>
  /** Bench runs, newest first, optionally for one node / model / kind. */
  listBenchRuns(filter?: BenchRunFilter): Promise<BenchRun[]>
  getBenchRun(id: string): Promise<BenchRun | null>
  /**
   * Start a decode / prefill / quality / tool-eval bench against the deployment serving on a node.
   * Runs asynchronously (poll, or watch `benchmarks` change events); conflicts while any node of that replica runs a bench.
   */
  startBench(input: StartBenchInput): Promise<BenchRun>
  /** Stop a running bench; finished stages are kept. Conflicts unless the run is running. */
  cancelBench(id: string): Promise<void>
  /** Remove a finished run from history; conflicts while it is running. */
  deleteBenchRun(id: string): Promise<void>
  listActivity(limit?: number): Promise<ActivityEvent[]>
  getFailures(): Promise<FailureInjection>
  setFailures(patch: Partial<FailureInjection>): Promise<void>
  /** Front fans: controller link, each fan's speed, RPM and reason, and the active policy. */
  getCooling(): Promise<CoolingState>
  getCoolingSeries(range: TimeRange): Promise<CoolingPoint[]>
  /** Pin a fan to `duty` (0–100); null returns it to the curve. */
  setFanOverride(fanId: string, duty: number | null): Promise<void>
  /** Rejects (invalid) when the merged policy fails validation. */
  setCoolingPolicy(patch: Partial<CoolingPolicy>): Promise<void>
  /** Every fan id → its shelf-1 boxes; a box may sit in one zone only. */
  setFanZones(zones: Record<string, string[]>): Promise<void>
  /** The fleet's switches (read-only): their health, every port and what is on it, and each node's own links. */
  getNetwork(): Promise<NetworkState>
  /** Live event stream (ticks + change notifications). Returns an unsubscribe function. */
  subscribe(listener: (e: ClientEvent) => void): () => void
}

const ClientContext = createContext<SparkManClient | null>(null)

export function ClientProvider({ client, children }: { client: SparkManClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

export function useClient(): SparkManClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useClient must be used inside <ClientProvider>')
  return client
}
