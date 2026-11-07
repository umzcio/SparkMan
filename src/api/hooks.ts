import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { useClient, type SparkManClient } from './client'
import type { BenchRunFilter, CoolingPolicy, CreateDeploymentInput, FailureInjection, LauncherInput, LogQueryInput, StartBenchInput, StartRolloutInput, TimeRange, Topic } from './types'

const LIVE = { live: true } as const

export const qk = {
  nodes: ['nodes'] as const,
  node: (id: string) => ['nodes', id] as const,
  nodeMetrics: (id: string, range: TimeRange) => ['nodes', id, 'metrics', range] as const,
  nodeProcesses: (id: string) => ['nodes', id, 'processes'] as const,
  nodeInventory: (id: string) => ['nodes', id, 'inventory'] as const,
  nodeHealth: (id: string) => ['nodes', id, 'health'] as const,
  fleet: ['fleet'] as const,
  fleetConfig: ['fleet-config'] as const,
  deployments: ['deployments'] as const,
  catalog: ['catalog'] as const,
  // under deployments so a deployments change refreshes them
  launchers: ['deployments', 'launchers'] as const,
  launcherLog: (id: string) => ['deployments', 'launchers', id, 'log'] as const,
  gatewayInfo: ['gateway', 'info'] as const,
  gatewaySeries: (range: TimeRange) => ['gateway', 'series', range] as const,
  routes: ['gateway', 'routes'] as const,
  usage: (range: TimeRange) => ['usage', range] as const,
  keys: ['keys'] as const,
  logs: (input: LogQueryInput, live: boolean) => ['logs', input, live] as const,
  incidents: ['incidents'] as const,
  rules: ['rules'] as const,
  updates: ['updates'] as const,
  rollouts: ['rollouts'] as const,
  activity: (limit: number) => ['activity', limit] as const,
  failures: ['failures'] as const,
  benchRuns: (filter: BenchRunFilter) => ['benchmarks', 'list', filter] as const,
  benchRun: (id: string) => ['benchmarks', 'run', id] as const,
  cooling: ['cooling'] as const,
  coolingSeries: (range: TimeRange) => ['cooling', 'series', range] as const,
  network: ['network'] as const,
}

const TOPIC_KEYS: Record<Topic, readonly (readonly unknown[])[]> = {
  nodes: [qk.nodes, qk.fleet, qk.updates, qk.deployments, ['gateway'], ['cooling']],
  deployments: [qk.deployments, ['gateway'], qk.nodes, qk.fleet],
  keys: [qk.keys, ['usage']],
  rules: [qk.rules],
  incidents: [qk.incidents, qk.fleet, qk.nodes, ['logs'], ['gateway']],
  updates: [qk.updates],
  rollouts: [qk.rollouts, qk.updates, ['gateway']],
  activity: [['activity']],
  failures: [qk.failures, qk.nodes, qk.fleet, ['gateway'], ['logs']],
  benchmarks: [['benchmarks']],
  cooling: [['cooling'], ['activity']],
  network: [['network']],
}

/** Mount once at the app root: ticks refresh live queries, change events refresh affected topics. */
export function useClientEvents(): void {
  const client = useClient()
  const qc = useQueryClient()
  useEffect(
    () =>
      client.subscribe((e) => {
        if (e.type === 'tick') {
          void qc.invalidateQueries({ predicate: (q) => q.meta?.live === true })
          return
        }
        if (e.topic === 'failures') {
          // outage toggled: every query (including errored/static ones) must refetch
          void qc.invalidateQueries()
          return
        }
        for (const queryKey of TOPIC_KEYS[e.topic]) void qc.invalidateQueries({ queryKey })
      }),
    [client, qc],
  )
}

// ---------- queries ----------

export function useNodes() {
  const c = useClient()
  return useQuery({ queryKey: qk.nodes, queryFn: () => c.listNodes(), meta: LIVE })
}
export function useNode(id: string) {
  const c = useClient()
  return useQuery({ queryKey: qk.node(id), queryFn: () => c.getNode(id), meta: LIVE })
}
export function useNodeMetrics(id: string, range: TimeRange, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeMetrics(id, range), queryFn: () => c.getNodeMetrics(id, range), meta: LIVE, enabled, placeholderData: keepPreviousData })
}
export function useNodeProcesses(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeProcesses(id), queryFn: () => c.getNodeProcesses(id), meta: LIVE, enabled })
}
export function useNodeInventory(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeInventory(id), queryFn: () => c.getNodeInventory(id), enabled })
}
export function useNodeHealth(id: string, enabled = true) {
  const c = useClient()
  return useQuery({ queryKey: qk.nodeHealth(id), queryFn: () => c.getNodeHealth(id), meta: LIVE, enabled })
}
export function useFleetSummary() {
  const c = useClient()
  return useQuery({ queryKey: qk.fleet, queryFn: () => c.getFleetSummary(), meta: LIVE })
}
export function useFleetConfig() {
  const c = useClient()
  return useQuery({ queryKey: qk.fleetConfig, queryFn: () => c.getFleetConfig(), staleTime: Infinity })
}
export function useDeployments() {
  const c = useClient()
  return useQuery({ queryKey: qk.deployments, queryFn: () => c.listDeployments(), meta: LIVE })
}
export function useLaunchers() {
  const c = useClient()
  return useQuery({ queryKey: qk.launchers, queryFn: () => c.listLaunchers(), meta: LIVE })
}
/** the scripts' output; polled while the log is open */
export function useLauncherLog(id: string | null) {
  const c = useClient()
  return useQuery({ queryKey: qk.launcherLog(id ?? ''), queryFn: () => c.getLauncherLog(id!), enabled: id !== null, refetchInterval: 2000 })
}
export function useCatalog() {
  const c = useClient()
  return useQuery({ queryKey: qk.catalog, queryFn: () => c.listCatalog(), staleTime: Infinity })
}
export function useGatewayInfo() {
  const c = useClient()
  return useQuery({ queryKey: qk.gatewayInfo, queryFn: () => c.getGatewayInfo() })
}
export function useGatewaySeries(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.gatewaySeries(range), queryFn: () => c.getGatewaySeries(range), meta: LIVE, placeholderData: keepPreviousData })
}
export function useRoutes() {
  const c = useClient()
  return useQuery({ queryKey: qk.routes, queryFn: () => c.listRoutes() })
}
export function useUsage(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.usage(range), queryFn: () => c.getUsage(range), meta: LIVE, placeholderData: keepPreviousData })
}
export function useKeys() {
  const c = useClient()
  return useQuery({ queryKey: qk.keys, queryFn: () => c.listKeys() })
}
export function useLogs(input: LogQueryInput, live: boolean) {
  const c = useClient()
  return useQuery({ queryKey: qk.logs(input, live), queryFn: () => c.queryLogs(input), meta: { live }, placeholderData: keepPreviousData })
}
export function useIncidents() {
  const c = useClient()
  return useQuery({ queryKey: qk.incidents, queryFn: () => c.listIncidents() })
}
export function useAlertRules() {
  const c = useClient()
  return useQuery({ queryKey: qk.rules, queryFn: () => c.listAlertRules() })
}
export function useNodeUpdates() {
  const c = useClient()
  return useQuery({ queryKey: qk.updates, queryFn: () => c.listNodeUpdates() })
}
export function useRollouts() {
  const c = useClient()
  return useQuery({ queryKey: qk.rollouts, queryFn: () => c.listRollouts(), meta: LIVE })
}
export function useActivity(limit = 20) {
  const c = useClient()
  return useQuery({ queryKey: qk.activity(limit), queryFn: () => c.listActivity(limit) })
}
export function useFailures() {
  const c = useClient()
  return useQuery({ queryKey: qk.failures, queryFn: () => c.getFailures() })
}

export function useCooling() {
  const c = useClient()
  return useQuery({ queryKey: qk.cooling, queryFn: () => c.getCooling(), meta: LIVE })
}
export function useNetwork() {
  const c = useClient()
  return useQuery({ queryKey: qk.network, queryFn: () => c.getNetwork(), meta: LIVE })
}
export function useCoolingSeries(range: TimeRange) {
  const c = useClient()
  return useQuery({ queryKey: qk.coolingSeries(range), queryFn: () => c.getCoolingSeries(range), meta: LIVE, placeholderData: keepPreviousData })
}

/** Poll fast while a run is live so its progress bar moves between simulator ticks. */
const BENCH_POLL_MS = 400

export function useBenchRuns(filter: BenchRunFilter, enabled = true) {
  const c = useClient()
  return useQuery({
    queryKey: qk.benchRuns(filter),
    queryFn: () => c.listBenchRuns(filter),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? BENCH_POLL_MS : false),
  })
}
export function useBenchRun(id: string | null) {
  const c = useClient()
  return useQuery({
    queryKey: qk.benchRun(id ?? ''),
    queryFn: () => c.getBenchRun(id!),
    enabled: id !== null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? BENCH_POLL_MS : false),
  })
}

// ---------- mutations ----------

function useAction<V, R>(fn: (c: SparkManClient, v: V) => Promise<R>, success?: (r: R, v: V) => string | null) {
  const c = useClient()
  return useMutation({
    mutationFn: (v: V) => fn(c, v),
    onSuccess: (r, v) => {
      const msg = success?.(r, v)
      if (msg) toast.success(msg)
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : String(e))
    },
  })
}

export const useRebootNode = () => useAction((c, id: string) => c.rebootNode(id), (_r, id) => `Rebooting ${id}…`)
export const useSetMaintenance = () =>
  useAction((c, v: { id: string; on: boolean }) => c.setNodeMaintenance(v.id, v.on), (_r, v) => (v.on ? `${v.id} in maintenance` : `${v.id} out of maintenance`))

export const useSetDrained = () =>
  useAction((c, v: { id: string; drained: boolean }) => c.setNodeDrained(v.id, v.drained), (_r, v) => (v.drained ? `${v.id} drained` : `${v.id} back in service`))
export const useRunDiagnostics = () => useAction((c, id: string) => c.runDiagnostics(id), (env) => `Diagnostics ${env.status.toUpperCase()} on ${env.host}`)
export const useCollectBundle = () => useAction((c, id: string) => c.collectBundle(id), (env) => `L2 evidence bundle → ${env.artifacts[0]}`)
export const useCreateDeployment = () => useAction((c, v: CreateDeploymentInput) => c.createDeployment(v), (d) => `Deploying ${d.model}`)
export const useStopDeployment = () => useAction((c, id: string) => c.stopDeployment(id), () => 'Deployment stopped')
export const useSaveLauncher = () =>
  useAction((c, v: { id: string | null; input: LauncherInput }) => (v.id ? c.updateLauncher(v.id, v.input) : c.createLauncher(v.input)), (l, v) => (v.id ? `${l.name} saved` : `${l.name} added`))
export const useDeleteLauncher = () => useAction((c, id: string) => c.deleteLauncher(id), () => 'Launcher removed')
export const useStartLauncher = () => useAction((c, id: string) => c.startLauncher(id), (l) => `Starting ${l.name}`)
export const useStopLauncher = () => useAction((c, id: string) => c.stopDeployment(id), () => 'Stopping')
export const useCreateKey = () => useAction((c, v: { name: string; rateLimitRpm: number }) => c.createKey(v))
export const useRevokeKey = () => useAction((c, id: string) => c.revokeKey(id), () => 'API key revoked')
export const useResolveIncident = () => useAction((c, id: string) => c.resolveIncident(id), () => 'Incident resolved')
export const useSetRuleEnabled = () =>
  useAction((c, v: { id: string; enabled: boolean }) => c.setAlertRuleEnabled(v.id, v.enabled), (_r, v) => (v.enabled ? 'Rule enabled' : 'Rule disabled'))
export const useStartRollout = () => useAction((c, v: StartRolloutInput) => c.startRollout(v), (r) => `${r.name} planned`)
export const useApproveRollout = () => useAction((c, id: string) => c.approveRollout(id), () => 'Rollout approved')
export const useCancelRollout = () => useAction((c, id: string) => c.cancelRollout(id), () => 'Rollout rejected')
export const useSetFailures = () => useAction((c, v: Partial<FailureInjection>) => c.setFailures(v), () => 'Simulator updated')
export const useStartBench = () => useAction((c, v: StartBenchInput) => c.startBench(v))
export const useCancelBench = () => useAction((c, id: string) => c.cancelBench(id), () => 'Bench cancelled')
export const useDeleteBenchRun = () => useAction((c, id: string) => c.deleteBenchRun(id), () => 'Run deleted')
export const useSetFanOverride = () =>
  useAction((c, v: { fanId: string; duty: number | null }) => c.setFanOverride(v.fanId, v.duty), (_, v) => (v.duty === null ? 'Back to auto' : null))
export const useSetCoolingPolicy = () => useAction((c, v: Partial<CoolingPolicy>) => c.setCoolingPolicy(v), () => 'Fan curve saved')
export const useSetFanZones = () => useAction((c, v: Record<string, string[]>) => c.setFanZones(v), () => 'Zones saved')
