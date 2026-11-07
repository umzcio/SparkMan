import type { ClientEvent, FleetConfig, SparkManClient } from '../client'
import type { BenchRunFilter, CoolingPolicy, CreateDeploymentInput, FailureInjection, LauncherInput, LogQueryInput, StartBenchInput, StartRolloutInput, TimeRange } from '../types'
import { FLEET_CONFIG, MODEL_CATALOG, NODE_SPECS } from './fixtures'
import { mockNetwork } from './network'
import { SimError, type Simulator } from './simulator'

export class MockClient implements SparkManClient {
  private sim: Simulator
  private latencyMs: number

  constructor(sim: Simulator, opts: { latencyMs?: number } = {}) {
    this.sim = sim
    this.latencyMs = opts.latencyMs ?? 120
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs * (0.5 + Math.random())))
  }

  private async run<T>(fn: () => T): Promise<T> {
    await this.delay()
    if (this.sim.getFailures().apiErrors) throw new SimError('unavailable', 'Simulated API failure (Settings → Simulator)')
    return fn()
  }

  listNodes() { return this.run(() => this.sim.getNodes()) }
  getNode(id: string) { return this.run(() => this.sim.getNode(id)) }
  getNodeMetrics(id: string, range: TimeRange) { return this.run(() => this.sim.getMetrics(id, range)) }
  getNodeProcesses(id: string) { return this.run(() => this.sim.getProcesses(id)) }
  getNodeInventory(id: string) { return this.run(() => this.sim.getInventory(id)) }
  getNodeHealth(id: string) { return this.run(() => this.sim.getHealth(id)) }
  rebootNode(id: string) { return this.run(() => this.sim.rebootNode(id)) }
  setNodeDrained(id: string, drained: boolean) { return this.run(() => this.sim.setDrained(id, drained)) }
  setNodeMaintenance(id: string, on: boolean) { return this.run(() => this.sim.setMaintenance(id, on)) }
  runDiagnostics(id: string) { return this.run(() => this.sim.runDiagnostics(id)) }
  collectBundle(id: string) { return this.run(() => this.sim.collectBundle(id)) }
  getFleetSummary() { return this.run(() => this.sim.getFleetSummary()) }
  getFleetConfig(): Promise<FleetConfig> {
    return this.run(() => ({ sshUser: FLEET_CONFIG.sshUser, sshKeyPath: FLEET_CONFIG.sshKeyPath, hosts: NODE_SPECS.map((n) => ({ id: n.id, ip: n.ip })) }))
  }
  listDeployments() { return this.run(() => this.sim.getDeployments()) }
  listCatalog() { return this.run(() => structuredClone(MODEL_CATALOG)) }
  createDeployment(input: CreateDeploymentInput) { return this.run(() => this.sim.createDeployment(input)) }
  stopDeployment(id: string) { return this.run(() => this.sim.stopDeployment(id)) }
  listLaunchers() { return this.run(() => this.sim.getLaunchers()) }
  createLauncher(input: LauncherInput) { return this.run(() => this.sim.createLauncher(input)) }
  updateLauncher(id: string, input: LauncherInput) { return this.run(() => this.sim.updateLauncher(id, input)) }
  deleteLauncher(id: string) { return this.run(() => this.sim.deleteLauncher(id)) }
  startLauncher(id: string) { return this.run(() => this.sim.startLauncher(id)) }
  getLauncherLog(id: string) { return this.run(() => this.sim.launcherLog(id)) }
  getGatewayInfo() { return this.run(() => this.sim.getGatewayInfo()) }
  getGatewaySeries(range: TimeRange) { return this.run(() => this.sim.getGatewaySeries(range)) }
  listRoutes() { return this.run(() => this.sim.getRoutes()) }
  getUsage(range: TimeRange) { return this.run(() => this.sim.getUsage(range)) }
  listKeys() { return this.run(() => this.sim.getKeys()) }
  createKey(input: { name: string; rateLimitRpm: number }) { return this.run(() => this.sim.createKey(input)) }
  revokeKey(id: string) { return this.run(() => this.sim.revokeKey(id)) }
  queryLogs(input: LogQueryInput) { return this.run(() => this.sim.queryLogs(input)) }
  listIncidents() { return this.run(() => this.sim.getIncidents()) }
  resolveIncident(id: string) { return this.run(() => this.sim.resolveIncident(id)) }
  listAlertRules() { return this.run(() => this.sim.getRules()) }
  setAlertRuleEnabled(id: string, enabled: boolean) { return this.run(() => this.sim.setRuleEnabled(id, enabled)) }
  listNodeUpdates() { return this.run(() => this.sim.getUpdates()) }
  listRollouts() { return this.run(() => this.sim.getRollouts()) }
  startRollout(input: StartRolloutInput) { return this.run(() => this.sim.startRollout(input)) }
  approveRollout(id: string) { return this.run(() => this.sim.approveRollout(id)) }
  cancelRollout(id: string) { return this.run(() => this.sim.cancelRollout(id)) }
  listBenchRuns(filter?: BenchRunFilter) { return this.run(() => this.sim.getBenchRuns(filter)) }
  getBenchRun(id: string) { return this.run(() => this.sim.getBenchRun(id)) }
  startBench(input: StartBenchInput) { return this.run(() => this.sim.startBench(input)) }
  cancelBench(id: string) { return this.run(() => this.sim.cancelBench(id)) }
  deleteBenchRun(id: string) { return this.run(() => this.sim.deleteBenchRun(id)) }
  listActivity(limit?: number) { return this.run(() => this.sim.getActivity(limit)) }
  // failure controls bypass the simulated outage so it can always be switched off
  async getFailures() { await this.delay(); return this.sim.getFailures() }
  async setFailures(patch: Partial<FailureInjection>) { await this.delay(); this.sim.setFailures(patch) }
  getCooling() { return this.run(() => this.sim.getCooling()) }
  getCoolingSeries(range: TimeRange) { return this.run(() => this.sim.getCoolingSeries(range)) }
  setFanOverride(fanId: string, duty: number | null) { return this.run(() => this.sim.setFanOverride(fanId, duty)) }
  setCoolingPolicy(patch: Partial<CoolingPolicy>) { return this.run(() => this.sim.setCoolingPolicy(patch)) }
  setFanZones(zones: Record<string, string[]>) { return this.run(() => this.sim.setFanZones(zones)) }
  getNetwork() { return this.run(() => mockNetwork(this.sim.getNodes(), Date.now())) }
  subscribe(listener: (e: ClientEvent) => void) { return this.sim.subscribe(listener) }
}
