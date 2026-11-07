import type {
  AlertRule, CatalogModel, Engine, IncidentSeverity, NodeModel, OsInfo, Replica, UpdateRing, ActivityKind, FirmwareUpdate,
} from '../types'

export const SIM_SEED = 1729
export const GATEWAY_BASE_URL = 'http://sparkman.local:4000'
export const FLEET_CONFIG = { sshUser: 'sparkman', sshKeyPath: '~/.ssh/sparkman_ed25519', domain: 'lab.local' }
/** Assumed frontier-API list price used for the "cloud equivalent" estimate (USD per 1M tokens). */
export const CLOUD_PRICE_PER_M = { input: 3, cachedInput: 0.3, output: 15 }
/**
 * Typical share of each model's prompt tokens served from the prefix cache. Coding agents resend the same
 * long context every turn, so they hit far more often than one-off chat. Unlisted models use DEFAULT_CACHE_HIT.
 */
export const CACHE_HIT_BASE: Record<string, number> = {
  'qwen3-coder-30b-a3b': 0.65,
  'qwen3-235b-a22b': 0.58,
  'qwen3.6-35b-a3b': 0.45,
  'gpt-oss-120b': 0.36,
  'deepseek-v3.1': 0.3,
  'mistral-small-3.2-24b': 0.2,
  'llama-3.1-8b-instruct': 0.14,
}
export const DEFAULT_CACHE_HIT = 0.25
/** Share of gateway tokens that are prompt (input) tokens; coding agents are input-heavy. */
export const INPUT_TOKEN_SHARE = 0.85

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const BASE_OS: OsInfo = {
  dgxOs: '7.4.1', kernel: '6.14.0-1013-nvidia', driver: '580.126.09', cuda: '13.0.1', uefi: '1.104.7',
}
export const TARGET_OS: OsInfo = {
  dgxOs: '7.5.0', kernel: '6.17.0-1004-nvidia', driver: '580.159.03', cuda: '13.0.2', uefi: '1.110.13',
}

export interface NodeSpec {
  id: string
  model: NodeModel
  ip: string
  diskGB: number
  diskBasePct: number
  assetTag: string
  serial: string
  thermalIssue: boolean
  bootedAgoMs: number
  rack: { shelf: number; slot: number }
}

// The top shelf is the real one, left to right: gx10-01 (ASUS Ascent GX10), four DGX Sparks, two Dell Pro Max GB10s.
// The second shelf holds stand-ins for the rest of the fleet.
const RACK: Record<string, { shelf: number; slot: number }> = {
  'gx10-01': { shelf: 1, slot: 1 }, 'spark-01': { shelf: 1, slot: 2 }, 'spark-02': { shelf: 1, slot: 3 }, 'spark-03': { shelf: 1, slot: 4 },
  'spark-04': { shelf: 1, slot: 5 }, 'dell-01': { shelf: 1, slot: 6 }, 'dell-02': { shelf: 1, slot: 7 },
  'spark-05': { shelf: 2, slot: 1 }, 'spark-06': { shelf: 2, slot: 2 }, 'gx10-02': { shelf: 2, slot: 3 }, 'gx10-03': { shelf: 2, slot: 4 }, 'gx10-04': { shelf: 2, slot: 5 },
}

const spark = (id: string, n: number, diskBasePct: number, extra: Partial<NodeSpec> = {}): NodeSpec => ({
  id, model: 'DGX Spark FE', ip: `10.42.0.${10 + n}`, diskGB: 4000, diskBasePct,
  assetTag: `UM-AI-${1000 + n}`, serial: `1G7A25${300 + n}0${n}`, thermalIssue: false, bootedAgoMs: (9 + n) * DAY, rack: RACK[id],
  ...extra,
})
const dell = (id: string, n: number, diskBasePct: number): NodeSpec => ({
  id, model: 'Dell Pro Max GB10', ip: `10.42.0.${20 + n}`, diskGB: 4000, diskBasePct,
  assetTag: `UM-AI-${1500 + n}`, serial: `DPMGB10${400 + n}`, thermalIssue: false, bootedAgoMs: (15 + n) * DAY, rack: RACK[id],
})
const gx10 = (id: string, n: number, diskBasePct: number): NodeSpec => ({
  id, model: 'ASUS GX10', ip: `10.42.0.${30 + n}`, diskGB: 2000, diskBasePct,
  assetTag: `UM-AI-${2000 + n}`, serial: `S8N0GX10${700 + n}`, thermalIssue: false, bootedAgoMs: (21 + n) * DAY, rack: RACK[id],
})

export const NODE_SPECS: NodeSpec[] = [
  spark('spark-01', 1, 41), spark('spark-02', 2, 38), spark('spark-03', 3, 57), spark('spark-04', 4, 22),
  spark('spark-05', 5, 63, { thermalIssue: true, bootedAgoMs: 2 * DAY }), spark('spark-06', 6, 49),
  dell('dell-01', 1, 31), dell('dell-02', 2, 72),
  gx10('gx10-01', 1, 44), gx10('gx10-02', 2, 46), gx10('gx10-03', 3, 45), gx10('gx10-04', 4, 51),
]

export const MODEL_CATALOG: CatalogModel[] = [
  { id: 'qwen3-235b-a22b', displayName: 'Qwen3 235B A22B Instruct', sizeGB: 140, quant: 'NVFP4', contextLength: 131072, engines: ['vLLM', 'SGLang'] },
  { id: 'gpt-oss-120b', displayName: 'gpt-oss 120B', sizeGB: 65, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama', 'SGLang'] },
  { id: 'gpt-oss-20b', displayName: 'gpt-oss 20B', sizeGB: 14, quant: 'MXFP4', contextLength: 131072, engines: ['vLLM', 'Ollama'] },
  { id: 'qwen3-coder-30b-a3b', displayName: 'Qwen3 Coder 30B A3B', sizeGB: 19, quant: 'Q4_K_M', contextLength: 262144, engines: ['Ollama', 'vLLM'] },
  { id: 'qwen3.6-35b-a3b', displayName: 'Qwen3.6 35B A3B', sizeGB: 23, quant: 'Q4_K_M', contextLength: 262144, engines: ['Ollama', 'vLLM'] },
  { id: 'llama-3.1-8b-instruct', displayName: 'Llama 3.1 8B Instruct', sizeGB: 16, quant: 'FP16', contextLength: 131072, engines: ['NIM', 'vLLM', 'Ollama'] },
  { id: 'mistral-small-3.2-24b', displayName: 'Mistral Small 3.2 24B', sizeGB: 25, quant: 'FP8', contextLength: 131072, engines: ['vLLM', 'Ollama'] },
  { id: 'nemotron-nano-9b-v2', displayName: 'NVIDIA Nemotron Nano 9B v2', sizeGB: 18, quant: 'BF16', contextLength: 131072, engines: ['NIM', 'vLLM'] },
  { id: 'deepseek-v3.1', displayName: 'DeepSeek V3.1', sizeGB: 380, quant: 'NVFP4', contextLength: 131072, engines: ['SGLang', 'vLLM'] },
]

export const ENGINE_PORT: Record<Engine, number> = { vLLM: 8000, NIM: 8000, Ollama: 11434, SGLang: 30000, 'llama-swap': 9090, TensorFold: 8888, 'llama.cpp': 8080, Script: 8888 }

export interface DeploymentSpec {
  id: string
  model: string
  engine: Engine
  replicas: Replica[]
  memoryGBPerNode: number
  /** relative share of gateway traffic, 0..1 */
  trafficWeight: number
  peakTokensPerSec: number
  peakRps: number
  createdAgoMs: number
}

export const DEPLOYMENT_SPECS: DeploymentSpec[] = [
  { id: 'dep-qwen235', model: 'qwen3-235b-a22b', engine: 'vLLM', replicas: [{ id: 'grp-coder', nodeIds: ['spark-01', 'spark-02'] }], memoryGBPerNode: 92, trafficWeight: 0.95, peakTokensPerSec: 1400, peakRps: 3.2, createdAgoMs: 12 * DAY },
  { id: 'dep-gptoss120', model: 'gpt-oss-120b', engine: 'vLLM', replicas: [{ id: 'rep-gptoss-a', nodeIds: ['spark-03'] }, { id: 'rep-gptoss-b', nodeIds: ['spark-06'] }], memoryGBPerNode: 88, trafficWeight: 0.8, peakTokensPerSec: 2600, peakRps: 5.5, createdAgoMs: 20 * DAY },
  { id: 'dep-qwencoder', model: 'qwen3-coder-30b-a3b', engine: 'Ollama', replicas: [{ id: 'rep-qwencoder', nodeIds: ['spark-04'] }], memoryGBPerNode: 26, trafficWeight: 0.6, peakTokensPerSec: 1100, peakRps: 2.4, createdAgoMs: 15 * DAY },
  { id: 'dep-llama8b', model: 'llama-3.1-8b-instruct', engine: 'NIM', replicas: [{ id: 'rep-llama8b', nodeIds: ['spark-05'] }], memoryGBPerNode: 34, trafficWeight: 0.55, peakTokensPerSec: 1800, peakRps: 4.1, createdAgoMs: 30 * DAY },
  { id: 'dep-qwen36', model: 'qwen3.6-35b-a3b', engine: 'Ollama', replicas: [{ id: 'rep-qwen36', nodeIds: ['dell-01'] }], memoryGBPerNode: 30, trafficWeight: 0.7, peakTokensPerSec: 1200, peakRps: 2.6, createdAgoMs: 6 * DAY },
  { id: 'dep-mistral24', model: 'mistral-small-3.2-24b', engine: 'vLLM', replicas: [{ id: 'rep-mistral24', nodeIds: ['dell-02'] }], memoryGBPerNode: 70, trafficWeight: 0.35, peakTokensPerSec: 900, peakRps: 1.5, createdAgoMs: 9 * DAY },
  { id: 'dep-deepseek', model: 'deepseek-v3.1', engine: 'SGLang', replicas: [{ id: 'grp-lab', nodeIds: ['gx10-01', 'gx10-02', 'gx10-03', 'gx10-04'] }], memoryGBPerNode: 104, trafficWeight: 0.25, peakTokensPerSec: 600, peakRps: 0.6, createdAgoMs: 4 * DAY },
]

export interface KeySpec {
  id: string
  name: string
  prefix: string
  rateLimitRpm: number
  createdAgoMs: number
  revokedAgoMs: number | null
  share: number
}

export const KEY_SPECS: KeySpec[] = [
  { id: 'key-claude', name: 'claude-code-laptop', prefix: 'sk-spark-7Qm2', rateLimitRpm: 600, createdAgoMs: 40 * DAY, revokedAgoMs: null, share: 0.38 },
  { id: 'key-codex', name: 'codex-cli', prefix: 'sk-spark-c0D3', rateLimitRpm: 600, createdAgoMs: 33 * DAY, revokedAgoMs: null, share: 0.22 },
  { id: 'key-opencode', name: 'opencode-workstation', prefix: 'sk-spark-0pNc', rateLimitRpm: 300, createdAgoMs: 21 * DAY, revokedAgoMs: null, share: 0.14 },
  { id: 'key-cursor', name: 'cursor', prefix: 'sk-spark-Cur5', rateLimitRpm: 300, createdAgoMs: 18 * DAY, revokedAgoMs: null, share: 0.12 },
  { id: 'key-ci', name: 'ci-review-bot', prefix: 'sk-spark-ci9R', rateLimitRpm: 120, createdAgoMs: 12 * DAY, revokedAgoMs: null, share: 0.1 },
  { id: 'key-continue', name: 'continue-vscode', prefix: 'sk-spark-Ctn4', rateLimitRpm: 120, createdAgoMs: 7 * DAY, revokedAgoMs: null, share: 0.04 },
  { id: 'key-old', name: 'old-vscode', prefix: 'sk-spark-x0Ld', rateLimitRpm: 60, createdAgoMs: 90 * DAY, revokedAgoMs: 30 * DAY, share: 0 },
]

export const ALERT_RULES: AlertRule[] = [
  { id: 'rule-offline', name: 'Node offline', condition: 'no heartbeat for 60 s', severity: 'critical', enabled: true },
  { id: 'rule-gpu-temp', name: 'GPU temperature high', condition: 'gpu_temp > 80 °C for 5 min', severity: 'warning', enabled: true },
  { id: 'rule-xid', name: 'GPU Xid error', condition: 'kernel log matches NVRM: Xid', severity: 'critical', enabled: true },
  { id: 'rule-disk', name: 'Disk almost full', condition: 'disk_used > 90 %', severity: 'warning', enabled: true },
  { id: 'rule-5xx', name: 'Gateway error rate', condition: '5xx rate > 2 % for 2 min', severity: 'critical', enabled: true },
  { id: 'rule-update', name: 'Update failed', condition: 'spark_updatectl postcheck != ok', severity: 'warning', enabled: false },
  { id: 'rule-cooling-link', name: 'Cooling controller offline', condition: 'no Pico heartbeat for 10 s', severity: 'critical', enabled: true },
  { id: 'rule-switch-down', name: 'Switch unreachable', condition: 'a switch misses 2 polls in a row (30 s)', severity: 'critical', enabled: true },
  { id: 'rule-switch-port', name: 'Node link below speed', condition: "a node's switch port runs below its expected speed for 60 s", severity: 'warning', enabled: true },
  { id: 'rule-fan-stall', name: 'Fan stalled', condition: 'fan rpm ≈ 0 while duty ≥ 20 % for 5 s', severity: 'critical', enabled: true },
]

export interface IncidentSpec {
  id: string
  title: string
  severity: IncidentSeverity
  nodeId: string | null
  ruleId: string
  startedAgoMs: number
  durationMs: number | null
  logKind: 'thermal' | 'xid' | 'gateway-5xx'
  timeline: { agoMs: number; text: string }[]
}

export const INCIDENT_SPECS: IncidentSpec[] = [
  {
    id: 'inc-thermal-05', title: 'spark-05 thermal throttling', severity: 'warning', nodeId: 'spark-05', ruleId: 'rule-gpu-temp',
    startedAgoMs: 3 * HOUR, durationMs: null, logKind: 'thermal',
    timeline: [
      { agoMs: 3 * HOUR, text: 'GPU temperature crossed 80 °C (sustained 5 min)' },
      { agoMs: 3 * HOUR - 4 * MIN, text: 'Clocks reduced; NIM throughput down 18 %' },
      { agoMs: 2 * HOUR, text: 'ACPI zone acpitz reported 91 °C' },
    ],
  },
  {
    id: 'inc-xid-05', title: 'Xid 31 on spark-05', severity: 'critical', nodeId: 'spark-05', ruleId: 'rule-xid',
    startedAgoMs: 2 * DAY + 2 * HOUR, durationMs: 4 * MIN, logKind: 'xid',
    timeline: [
      { agoMs: 2 * DAY + 2 * HOUR, text: 'NVRM: Xid 31 (MMU fault) from python3' },
      { agoMs: 2 * DAY + 2 * HOUR - 2 * MIN, text: 'NIM container restarted' },
      { agoMs: 2 * DAY + 2 * HOUR - 4 * MIN, text: 'Node rebooted by operator; resolved' },
    ],
  },
  {
    id: 'inc-5xx', title: 'Gateway 5xx spike', severity: 'critical', nodeId: null, ruleId: 'rule-5xx',
    startedAgoMs: 26 * HOUR, durationMs: 6 * MIN, logKind: 'gateway-5xx',
    timeline: [
      { agoMs: 26 * HOUR, text: '5xx rate 7.8 % (threshold 2 %)' },
      { agoMs: 26 * HOUR - 3 * MIN, text: 'Upstream spark-03 connection resets' },
      { agoMs: 26 * HOUR - 6 * MIN, text: 'Error rate back under 0.5 %; resolved' },
    ],
  },
]

export const ACTIVITY_SPECS: { agoMs: number; kind: ActivityKind; text: string; nodeId: string | null }[] = [
  { agoMs: 3 * HOUR, kind: 'alert', text: 'Alert opened: spark-05 thermal throttling', nodeId: 'spark-05' },
  { agoMs: 6 * HOUR, kind: 'key', text: 'API key continue-vscode used for the first time', nodeId: null },
  { agoMs: 26 * HOUR, kind: 'alert', text: 'Gateway 5xx spike resolved after 6 min', nodeId: null },
  { agoMs: 2 * DAY, kind: 'reboot', text: 'spark-05 rebooted after Xid 31', nodeId: 'spark-05' },
  { agoMs: 4 * DAY, kind: 'deploy', text: 'Deployed deepseek-v3.1 on gx10-01 + gx10-02…04 (SGLang, 4 nodes)', nodeId: null },
  { agoMs: 6 * DAY, kind: 'deploy', text: 'Deployed qwen3.6-35b-a3b on dell-01 (Ollama)', nodeId: 'dell-01' },
  { agoMs: 9 * DAY, kind: 'update', text: 'Rollout "Security updates" completed on 12 nodes', nodeId: null },
]

export const RINGS: Record<UpdateRing, string[]> = {
  canary: ['dell-02'],
  ring1: ['spark-03', 'spark-04', 'dell-01'],
  ring2: ['spark-01', 'spark-02', 'spark-05', 'spark-06', 'gx10-01', 'gx10-02', 'gx10-03', 'gx10-04'],
}

export const APT_PENDING: string[] = [
  'nvidia-driver-580-open', 'cuda-toolkit-13-0', 'linux-image-6.17.0-1004-nvidia', 'dgx-dashboard',
  'nvidia-container-toolkit', 'docker-ce', 'openssl', 'libnccl2', 'nvidia-sync-agent', 'dgx-release',
]

export const FIRMWARE_PENDING: Record<NodeModel, FirmwareUpdate[]> = {
  'DGX Spark FE': [
    { component: 'UEFI', current: '1.104.7', available: '1.110.13' },
    { component: 'EC', current: '0.9.18', available: '0.9.21' },
  ],
  'Dell Pro Max GB10': [{ component: 'Dell BIOS', current: '1.4.0', available: '1.5.2' }],
  'ASUS GX10': [{ component: 'ASUS SOC capsule', current: '2.3.1', available: '2.4.0' }],
}

export const PACKAGES: { name: string; version: string }[] = [
  { name: 'nvidia-driver-580-open', version: '580.126.09-0ubuntu1' },
  { name: 'cuda-toolkit-13-0', version: '13.0.1-1' },
  { name: 'libnccl2', version: '2.28.3-1+cuda13.0' },
  { name: 'nvidia-container-toolkit', version: '1.18.0-1' },
  { name: 'docker-ce', version: '5:28.4.0-1~ubuntu.24.04~noble' },
  { name: 'dgx-dashboard', version: '0.112.4' },
  { name: 'dgx-release', version: '7.4.1' },
]

export const ROLLOUT_HISTORY: { id: string; name: string; targetOs: string; startedAgoMs: number; durationMs: number }[] = [
  { id: 'ro-sec-0929', name: 'Security updates (openssl, kernel)', targetOs: '7.4.1', startedAgoMs: 9 * DAY, durationMs: 41 * MIN },
  { id: 'ro-741', name: 'DGX OS 7.4.1', targetOs: '7.4.1', startedAgoMs: 28 * DAY, durationMs: 2 * HOUR + 12 * MIN },
]
