import type { CoolingPolicy, FanReason } from '@/lib/cooling'
import type { TimeRange } from '@/lib/format'

export type { TimeRange }
export type { CoolingPolicy, CurvePoint, FanReason } from '@/lib/cooling'

export type NodeModel = 'DGX Spark FE' | 'Dell Pro Max GB10' | 'ASUS GX10'
export type NodeStatus = 'online' | 'degraded' | 'offline' | 'rebooting'

export interface OsInfo {
  dgxOs: string
  kernel: string
  driver: string
  cuda: string
  uefi: string
}

export interface NodeLiveStats {
  gpuUtil: number
  memUsedGB: number
  gpuPowerW: number
  gpuTempC: number
  acpiTempC: number
  cpuUtil: number
  diskUsedPct: number
  throttling: boolean
}

export interface RackPosition {
  shelf: number
  slot: number
}

export interface FleetNode {
  id: string
  hostname: string
  model: NodeModel
  ip: string
  status: NodeStatus
  drained: boolean
  /** in maintenance: alerts muted, skipped by rollouts, drained from the gateway */
  maintenance: boolean
  os: OsInfo
  memoryGB: number
  cpuCores: number
  diskGB: number
  assetTag: string
  serial: string
  bootedAt: number
  lastSeen: number
  deploymentId: string | null
  /** physical position: shelf 1 is the top shelf, slots count from the left */
  rack: RackPosition
  /** id of the multi-node replica this node belongs to (null when single-node or idle) */
  groupId: string | null
  /** latest sample; null whenever the node is offline or rebooting */
  live: NodeLiveStats | null
}

export type MetricKey =
  | 'gpuUtil' | 'memUsedGB' | 'gpuPowerW' | 'gpuTempC' | 'acpiTempC' | 'cpuUser' | 'cpuSystem'
  | 'netRxBps' | 'netTxBps' | 'cx7RxBps' | 'cx7TxBps' | 'diskReadBps' | 'diskWriteBps' | 'diskUsedPct'

export type MetricPoint = { t: number } & Record<MetricKey, number | null>

/** inference servers; llama-swap fronts other engines and swaps models on demand */
export type Engine = 'vLLM' | 'Ollama' | 'NIM' | 'SGLang' | 'llama-swap' | 'TensorFold' | 'llama.cpp' | 'Script'
export type DeploymentStatus = 'pending' | 'loading' | 'serving' | 'degraded' | 'stopped'

export interface Replica {
  id: string
  nodeIds: string[]
}

export interface Deployment {
  id: string
  model: string
  displayName: string
  engine: Engine
  quant: string
  replicas: Replica[]
  status: DeploymentStatus
  contextLength: number
  port: number
  memoryGBPerNode: number
  createdAt: number
  /** generated tokens/s over the last minute, all requests together */
  tokensPerSec: number
  /** where tokensPerSec came from: the engine's own counter, or gateway traffic only (engines without one) */
  tokensPerSecFrom?: 'engine' | 'gateway'
  requestsPerSec: number
  /** how fast one request generates, from its recent streamed gateway requests; null before there are any */
  decodeTokensPerSec?: number | null
  /** set when the user's launch scripts run it */
  launcherId?: string
}

export interface CreateDeploymentInput {
  catalogId: string
  engine: Engine
  nodeIds: string[]
}

/**
 * A model started by the user's own scripts on a head node (any engine, one node or many). SparkMan runs
 * start/stop and watches the port; the scripts own everything engine-specific, ranks included.
 */
/** model features a client can rely on (Kimi Code's tool_use / thinking / image_in) */
export type ModelCap = 'tools' | 'thinking' | 'images'

export type LauncherState = 'idle' | 'starting' | 'serving' | 'down' | 'stopping' | 'failed'

export interface LauncherInput {
  name: string
  /** every node the model occupies, head first; start/stop run on the head */
  nodeIds: string[]
  /** absolute, or ~/ for the SSH user's home on the head */
  dir: string
  startScript: string
  /** run before SparkMan ends the start script's processes; null = just end them */
  stopScript: string | null
  /** where the model answers OpenAI /v1/models on the head */
  port: number
  /** run the scripts as root (sudo -n -H), for scripts written for root, like llama-swap's */
  sudo: boolean
  /** what clients may use it for; engines don't report this, so the registry passes on what you set */
  caps: ModelCap[]
  /** longest reply the scripts let the engine write (e.g. TensorFold --max-tokens); engines don't report it. null = unknown */
  maxOutput: number | null
  /** the window the scripts give the engine, for engines that don't report one (TensorFold's Zig engine); the reported one wins. null = unknown */
  contextWindow?: number | null
  notes: string
}

export interface Launcher extends LauncherInput {
  id: string
  state: LauncherState
  /** why it failed or went down */
  detail: string | null
  startedAt: number | null
  /** what /v1/models reports while serving */
  models: string[]
  engine: Engine
  /** context window the engine reports while serving; 0 = not reported */
  contextLength: number
}

export interface CatalogModel {
  id: string
  displayName: string
  sizeGB: number
  quant: string
  contextLength: number
  engines: Engine[]
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  rateLimitRpm: number
  revokedAt: number | null
  requests24h: number
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export type LogSource = 'gateway' | 'engine' | 'journald' | 'kernel'

export interface LogLine {
  id: string
  ts: number
  level: LogLevel
  source: LogSource
  host: string
  service: string
  message: string
  pattern: string
  attributes: Record<string, string>
}

export interface HistogramBucket {
  t: number
  error: number
  warn: number
  info: number
  debug: number
}

export interface LogQueryInput {
  query: string
  range: TimeRange
  /** when set, ignore range and show ±60 s around this timestamp */
  around?: number
  limit?: number
}

export interface LogIncidentBand {
  from: number
  to: number
  label: string
}

export interface LogQueryResult {
  lines: LogLine[]
  histogram: HistogramBucket[]
  total: number
  truncated: boolean
  bands: LogIncidentBand[]
  from: number
  to: number
}

export type IncidentSeverity = 'critical' | 'warning' | 'info'
export type IncidentStatus = 'ongoing' | 'resolved'

export interface Incident {
  id: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  nodeId: string | null
  ruleId: string
  startedAt: number
  resolvedAt: number | null
  timeline: { ts: number; text: string }[]
}

export interface AlertRule {
  id: string
  name: string
  condition: string
  severity: IncidentSeverity
  enabled: boolean
}

export type UpdateRing = 'canary' | 'ring1' | 'ring2'

export interface FirmwareUpdate {
  component: string
  current: string
  available: string
}

export interface SparkToolEnvelope {
  tool: string
  ts: string
  host: string
  status: 'ok' | 'warn' | 'error'
  rc: number
  duration_ms: number
  summary: Record<string, unknown>
  warnings: string[]
  artifacts: string[]
}

export interface NodeUpdateStatus {
  nodeId: string
  model: NodeModel
  ring: UpdateRing
  currentOs: string
  targetOs: string
  aptPending: string[]
  firmwarePending: FirmwareUpdate[]
  rebootRequired: boolean
  lastChecked: number
  envelope: SparkToolEnvelope
}

export type RolloutStep = 'queued' | 'stop-model' | 'precheck' | 'apply' | 'reboot' | 'postcheck' | 'start-model' | 'done' | 'failed'
export type RolloutStatus = 'awaiting-approval' | 'running' | 'completed' | 'failed'

export interface RolloutNode {
  nodeId: string
  ring: UpdateRing
  step: RolloutStep
  /** the launcher serving on this node, stopped before its nodes update and started again after the last */
  launcher?: { id: string; name: string }
  /** why the node failed */
  note?: string
}

export interface Rollout {
  id: string
  name: string
  targetOs: string
  rings: UpdateRing[]
  window: string
  status: RolloutStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  nodes: RolloutNode[]
  /** stop the models on these nodes and start them again afterwards, instead of skipping their nodes */
  restartModels?: boolean
}

export interface StartRolloutInput {
  targetOs: string
  rings: UpdateRing[]
  window: string
  requireApproval: boolean
  /** stop the models on these nodes and start them again afterwards, instead of skipping their nodes */
  restartModels?: boolean
}

export type ActivityKind = 'reboot' | 'deploy' | 'update' | 'alert' | 'key' | 'drain' | 'maintenance' | 'diag' | 'bench' | 'system'

export interface ActivityEvent {
  id: string
  ts: number
  kind: ActivityKind
  text: string
  nodeId: string | null
}

export interface GatewayPoint {
  t: number
  rps: number
  p50Ms: number
  p95Ms: number
  ttftMs: number
  errorRate: number
  tokensPerSec: number
}

export interface GatewayRoute {
  model: string
  deploymentId: string
  engine: Engine
  replicas: number
  nodeIds: string[]
  healthy: boolean
}

export interface GatewayInfo {
  baseUrl: string
  defaultModel: string
  models: string[]
}

export interface UsagePoint {
  t: number
  requests: number
  byModel: Record<string, number>
  byKey: Record<string, number>
}

export interface ModelTokenTotals {
  model: string
  requests: number
  /** prompt tokens the GPU computed */
  prefill: number
  /** prompt tokens served from the prefix cache */
  cached: number
  /** completion tokens */
  generated: number
}

export interface UsageReport {
  points: UsagePoint[]
  /** all prompt tokens: prefill + cached */
  tokensIn: number
  /** the part of tokensIn served from the prefix cache */
  tokensCached: number
  tokensOut: number
  requests: number
  cloudCostUsd: number
  topKeys: { keyId: string; name: string; tokens: number; requests: number }[]
  models: string[]
  /** per model, busiest first */
  modelTotals: ModelTokenTotals[]
  keys: { id: string; name: string }[]
}

export interface FleetSummary {
  online: number
  total: number
  gpuUtilAvg: number
  memUsedGB: number
  memTotalGB: number
  powerW: number
  tokensPerSec: number
  activeIncidents: number
}

export interface GpuProcess {
  pid: number
  user: string
  name: string
  engine: Engine | null
  gpuMemMiB: number
}

export interface HealthCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

export interface NodeHealth {
  checks: HealthCheck[]
  envelope: SparkToolEnvelope
}

export interface NodeInventory {
  firmware: { component: string; version: string }[]
  packages: { name: string; version: string }[]
  envelope: SparkToolEnvelope
}

export interface FailureInjection {
  nodeOffline: string | null
  gatewayErrors: boolean
  xidStorm: boolean
  /** when true, MockClient rejects every request except failure get/set (exercises UI error states) */
  apiErrors: boolean
  /** the Pico stops answering; after its watchdog it runs every fan at 100 % */
  picoDisconnected: boolean
  /** id of a fan whose tach reads 0 while it is driven */
  fanStalled: string | null
}

export type Topic =
  | 'nodes' | 'deployments' | 'keys' | 'rules' | 'incidents' | 'updates' | 'rollouts' | 'activity' | 'failures' | 'benchmarks' | 'cooling' | 'network'

export type SimEvent = { type: 'tick'; now: number } | { type: 'changed'; topic: Topic }

// ---------- benchmarks ----------
// Shapes follow sparkDash's decode / prefill / quality benches and tool-eval-bench's JSON output,
// so a real node agent can return them unchanged.

export type BenchKind = 'decode' | 'prefill' | 'quality' | 'tool-eval'
/**
 * replica: one copy of the model — a single node, or a tensor-parallel group benched through its head
 * (the group's first node, which serves the API).
 * gateway: every copy of the model at once, through the gateway's load balancing (decode and prefill only).
 */
export type BenchScope = 'replica' | 'gateway'
export type BenchStatus = 'running' | 'completed' | 'cancelled' | 'failed'
export type DecodePromptType = 'structured' | 'prose' | 'code' | 'json'
export type QualityCategory = 'qa' | 'reasoning' | 'arithmetic' | 'state' | 'gsm8k' | 'mmlu' | 'instruction' | 'long-recall'
/** tool-eval-bench scenario categories A–O */
export type ToolEvalCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O'
export type ScenarioStatus = 'pass' | 'partial' | 'fail'

export interface DecodeBenchConfig {
  kind: 'decode'
  /** concurrent streams per level, ascending */
  concurrency: number[]
  maxTokens: number
  promptType: DecodePromptType
}

export interface PrefillBenchConfig {
  kind: 'prefill'
  /** prompt sizes in tokens; sizes beyond the model context are skipped */
  contextSizes: number[]
}

export interface QualityBenchConfig {
  kind: 'quality'
  categories: QualityCategory[]
}

export interface ToolEvalBenchConfig {
  kind: 'tool-eval'
  /** quick = 2 scenarios per category, full = all 69 */
  suite: 'quick' | 'full'
}

export type BenchConfig = DecodeBenchConfig | PrefillBenchConfig | QualityBenchConfig | ToolEvalBenchConfig

/** One copy's share of a gateway run. */
export interface ReplicaShare {
  /** the copy's nodes, head first */
  nodeIds: string[]
}

export interface DecodeLevelResult {
  concurrency: number
  /** total completion tokens/s across all streams */
  aggregateTokS: number
  /** mean tokens/s of a single stream */
  perStreamTokS: number
  ttftP50Ms: number
  completionTokens: number
  durationMs: number
  /** gateway runs: how the streams landed on each copy */
  replicas?: (ReplicaShare & { streams: number; aggregateTokS: number; perStreamTokS: number; ttftP50Ms: number })[]
}

export interface PrefillSizeResult {
  contextTokens: number
  /** gateway runs: the mean across copies */
  prefillTokS: number
  ttftMs: number
  /** gateway runs: the same prompt sent to each copy */
  replicas?: (ReplicaShare & { prefillTokS: number; ttftMs: number })[]
}

export interface QualityCategoryResult {
  category: QualityCategory
  items: number
  correct: number
  /** 0–100 */
  percent: number
  meanCompletionTokens: number
  /** replies cut off at max_tokens */
  hitMaxTokens: number
  /** per-item outcome; index i is the stable item id `${category}-${i}`, so runs pair item by item */
  passed: boolean[]
}

export interface ToolEvalScenarioResult {
  /** e.g. TC-B-03 */
  id: string
  category: ToolEvalCategory
  status: ScenarioStatus
  /** 0–2 points (pass 2, partial 1, fail 0) */
  points: number
}

export interface ToolEvalCategoryResult {
  category: ToolEvalCategory
  pass: number
  partial: number
  fail: number
  /** 0–100 */
  percent: number
}

export interface DecodeBenchResult {
  kind: 'decode'
  levels: DecodeLevelResult[]
}

export interface PrefillBenchResult {
  kind: 'prefill'
  sizes: PrefillSizeResult[]
  /** requested sizes larger than the model context */
  skipped: number[]
}

export interface QualityBenchResult {
  kind: 'quality'
  categories: QualityCategoryResult[]
  /** mean of category percentages, null until the first category finishes */
  overall: number | null
}

export interface ToolEvalBenchResult {
  kind: 'tool-eval'
  categories: ToolEvalCategoryResult[]
  scenarios: ToolEvalScenarioResult[]
  /** 0–100, null until the first category finishes */
  score: number | null
}

export type BenchResult = DecodeBenchResult | PrefillBenchResult | QualityBenchResult | ToolEvalBenchResult

export interface BenchRun {
  id: string
  kind: BenchKind
  scope: BenchScope
  /** the head node a replica run went through, or 'gateway' */
  nodeId: string
  /** every node the run occupied (the group, or all copies for a gateway run) */
  nodeIds: string[]
  deploymentId: string
  model: string
  engine: Engine
  quant: string
  contextLength: number
  config: BenchConfig
  status: BenchStatus
  /** 0..1 */
  progress: number
  /** what is running now, e.g. "Concurrency 4 · 3 of 6" (null once finished) */
  stage: string | null
  startedAt: number
  finishedAt: number | null
  error: string | null
  /** partial while running, kept on cancel */
  result: BenchResult
}

export interface BenchRunFilter {
  /** a head node id, or 'gateway' */
  nodeId?: string
  model?: string
  kind?: BenchKind
}

export type StartBenchInput =
  /** any node of the copy; a group is benched through its head */
  | { scope?: 'replica'; nodeId: string; deploymentId: string; config: BenchConfig }
  | { scope: 'gateway'; deploymentId: string; config: BenchConfig }

/** The node id gateway runs are filed under. */
export const GATEWAY_TARGET = 'gateway'

// ---------- cooling (front fans on the Pico) ----------

export interface Fan {
  id: string
  name: string
  /** the boxes in front of it (its zone) */
  nodeIds: string[]
  /** commanded, 0–100 */
  duty: number
  /** measured from the tach */
  rpm: number
  mode: 'auto' | 'manual'
  manualDuty: number | null
  reason: FanReason
  /** driven at ≥ 20 % but the tach has read ~0 for 5 s */
  stalled: boolean
}

export interface CoolingController {
  connected: boolean
  port: string
  firmware: string
  lastHeartbeatAt: number | null
  watchdogMs: number
  /** the Pico has lost SparkMan and runs every fan at 100 % */
  failsafe: boolean
}

export interface CoolingState {
  controller: CoolingController
  fans: Fan[]
  policy: CoolingPolicy
  maxRpm: number
}

export interface CoolingPoint {
  t: number
  /** by fan id */
  duty: Record<string, number>
  rpm: Record<string, number>
  /** hottest GPU in each fan's zone; null when none reported */
  zoneTempC: Record<string, number | null>
}

// ---------- network (the fleet's switches, read-only) ----------

/** fleet: the 10G management/LAN switch; fabric: the ConnectX-7 (QSFP) switch */
export type SwitchRole = 'fleet' | 'fabric'
export type SwitchHealthStatus = 'ok' | 'warn' | 'bad'

export interface SwitchHealthReading {
  /** 'CPU temperature', 'Fan 1', 'PSU 2', 'Memory' */
  label: string
  value: number | null
  unit: '°C' | 'RPM' | '%' | 'W' | 'V' | ''
  /** for state sensors ('ok', 'fail') */
  state?: string
  status: SwitchHealthStatus
}

/** What is on the other end of a switch port. */
export interface SwitchPortPeer {
  /** a fleet node, or null for something else (SparkMan's host, another switch) */
  nodeId: string | null
  label: string
  /** the peer's interface, when known */
  iface: string | null
  /** matched by the switch's MAC table, or by the neighbour's LLDP name */
  via: 'mac' | 'lldp'
}

export interface SwitchPort {
  /** stable within the switch (its interface name) */
  id: string
  /** the switch's own name for it: 'ten-gigabitEthernet 1/0/3', 'qsfp56-dd-1-1' */
  name: string
  /** short label for the front panel: '3', '1', '1·2' */
  label: string
  kind: 'rj45' | 'sfp' | 'qsfp' | 'mgmt'
  /** a QSFP-DD port's lane (1–8) under its cage; null elsewhere */
  lane: number | null
  up: boolean
  speedMbps: number | null
  mtu: number | null
  rxBps: number | null
  txBps: number | null
  /** the switch's counters (since its last reset) */
  rxErrors: number | null
  txErrors: number | null
  drops: number | null
  pauseRx: number | null
  pauseTx: number | null
  fecUncorrected: number | null
  /** the plugged module or cable */
  module: { vendor: string; part: string; type: string } | null
  peer: SwitchPortPeer | null
  /** why this node's port looks wrong (down, below its expected speed), or null */
  problem: string | null
}

export interface NetworkSwitch {
  id: string
  name: string
  role: SwitchRole
  /** how SparkMan reads it */
  kind: 'snmp' | 'routeros'
  host: string
  model: string
  firmware: string
  serial: string
  uptimeS: number | null
  reachable: boolean
  /** has answered at least once; false for a switch added before it was cabled (no alerts yet) */
  everReached: boolean
  /** the last poll's failure, while unreachable */
  error: string | null
  lastPollAt: number | null
  health: SwitchHealthReading[]
  ports: SwitchPort[]
  /** its serial console as plugged into SparkMan's host; null when none is configured */
  console: { device: string; tty: string | null; jack: 'usb-c' | 'rj45'; connected: boolean; host: string } | null
}

/** One of a node's own network links, as the node reports it. */
export interface NodeLink {
  iface: string
  role: SwitchRole
  up: boolean
  speedMbps: number | null
  mtu: number | null
  mac: string | null
  /** the switch port it lands on; null for a direct cable or one no switch has seen */
  switchId: string | null
  portName: string | null
}

export interface NodeNetwork {
  nodeId: string
  links: NodeLink[]
}

export interface NetworkState {
  switches: NetworkSwitch[]
  nodes: NodeNetwork[]
}
