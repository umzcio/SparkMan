import { matchesLogQuery, type ParsedLogQuery } from '@/lib/log-query'
import type { HistogramBucket, LogLevel, LogLine, LogSource } from '../types'
import { ENGINE_PORT, type DeploymentSpec, type NodeSpec } from './fixtures'
import { isOffline, type Outage } from './metrics'
import { hash, noise, pick, pickWeighted } from './rng'

export const SLOT_MS = 5000
export const MAX_SCAN_SLOTS = 20_000
export const GATEWAY_HOST = 'sparkman-gw'

export interface LogWindow {
  from: number
  to: number | null
  nodeId: string | null
  kind: 'thermal' | 'xid' | 'gateway-5xx'
  label: string
}

export interface LogWorld {
  seed: number
  nodes: NodeSpec[]
  deployments: DeploymentSpec[]
  keys: { id: string; name: string; share: number }[]
  windows: LogWindow[]
  outages: Outage[]
}

type Rand = (k: string) => number

interface Draft {
  level: LogLevel
  source: LogSource
  host: string
  service: string
  message: string
  patternKey: string
  attributes?: Record<string, string>
}

const patternId = (key: string) =>
  hash('pattern', key).toString(16).padStart(8, '0') + hash('pattern-2', key).toString(16).padStart(8, '0')

const int = (r: number, min: number, max: number) => Math.floor(min + r * (max - min + 1))

function pickDeployment(world: LogWorld, r: number): { dep: DeploymentSpec; node: string } | null {
  if (world.deployments.length === 0) return null
  const dep = pickWeighted(world.deployments.map((d) => ({ value: d, weight: d.trafficWeight })), r)
  const nodes = dep.replicas.flatMap((rep) => rep.nodeIds)
  return { dep, node: pick(nodes, (r * 7919) % 1) }
}

function gatewayLine(world: LogWorld, rand: Rand): Draft | null {
  const target = pickDeployment(world, rand('dep'))
  if (!target) return null
  const { dep, node } = target
  const key = world.keys.length ? pickWeighted(world.keys.map((k) => ({ value: k, weight: Math.max(k.share, 0.001) })), rand('key')) : null
  const route = key?.id === 'key-claude' ? '/v1/messages' : '/v1/chat/completions'
  const ms = int(rand('ms'), 180, 9000)
  const roll = rand('lvl')
  const common = { source: 'gateway' as const, host: GATEWAY_HOST, service: 'gateway' }
  if (roll < 0.04) {
    return { ...common, level: 'debug', message: `route model=${dep.model} -> ${node}:${ENGINE_PORT[dep.engine]} (least-loaded)`, patternKey: 'gw-route', attributes: { model: dep.model, upstream: node } }
  }
  if (roll < 0.07) {
    return { ...common, level: 'warn', message: `Upstream ${node} slow: ttft ${int(rand('ttft'), 1500, 4000)}ms (model=${dep.model})`, patternKey: 'gw-slow', attributes: { model: dep.model, upstream: node } }
  }
  if (roll < 0.075) {
    return { ...common, level: 'error', message: `POST ${route} 502 ${ms}ms upstream=${node} connection reset`, patternKey: 'gw-502', attributes: { model: dep.model, upstream: node, 'http.status_code': '502' } }
  }
  const tokensIn = int(rand('tin'), 800, 60_000)
  const tokensOut = int(rand('tout'), 40, 2400)
  return {
    ...common,
    level: 'info',
    message: `POST ${route} 200 ${ms}ms`,
    patternKey: `gw-ok-${route}`,
    attributes: {
      model: dep.model,
      api_key: key?.name ?? 'unknown',
      tokens_in: String(tokensIn),
      tokens_out: String(tokensOut),
      duration_ms: String(ms),
      'http.method': 'POST',
      'http.route': route,
      'http.status_code': '200',
      request_id: `req_${hash('req', rand('id')).toString(36)}`,
      upstream: node,
    },
  }
}

function engineLine(world: LogWorld, rand: Rand): Draft | null {
  const target = pickDeployment(world, rand('dep'))
  if (!target) return null
  const { dep, node } = target
  const service = dep.engine.toLowerCase()
  const common = { source: 'engine' as const, host: node, service, attributes: { model: dep.model, engine: dep.engine } }
  const roll = rand('lvl')
  if (roll < 0.05) return { ...common, level: 'debug', message: `Scheduler step ${int(rand('n'), 1000, 99999)} finished in ${int(rand('ms'), 8, 60)}ms`, patternKey: 'engine-step' }
  if (roll < 0.09) return { ...common, level: 'warn', message: `KV cache usage ${(90 + rand('kv') * 9).toFixed(1)}%; preempting ${int(rand('k'), 1, 4)} requests (recompute)`, patternKey: 'engine-preempt' }
  const running = int(rand('run'), 1, 24)
  const gen = (rand('gen') * 2200 + 100).toFixed(1)
  switch (dep.engine) {
    case 'Ollama':
      return { ...common, level: 'info', message: `[GIN] | 200 | ${(rand('s') * 9 + 0.4).toFixed(2)}s | 10.42.0.2 | POST "/v1/chat/completions"`, patternKey: 'ollama-gin' }
    case 'SGLang':
      return { ...common, level: 'info', message: `Decode batch. #running-req: ${running}, #token: ${int(rand('tok'), 2000, 90000)}, token usage: ${rand('u').toFixed(2)}, gen throughput (token/s): ${gen}, #queue-req: 0`, patternKey: 'sglang-decode' }
    default:
      return { ...common, level: 'info', message: `Engine 000: Avg prompt throughput: ${(rand('p') * 9000).toFixed(1)} tokens/s, Avg generation throughput: ${gen} tokens/s, Running: ${running} reqs, Waiting: 0 reqs, GPU KV cache usage: ${(rand('kv') * 80 + 5).toFixed(1)}%`, patternKey: 'vllm-stats' }
  }
}

function journalLine(world: LogWorld, rand: Rand): Draft {
  const host = pick(world.nodes, rand('host')).id
  const roll = rand('lvl')
  const common = { source: 'journald' as const, host }
  if (roll < 0.03) return { ...common, level: 'warn', service: 'systemd-resolved', message: 'Using degraded feature set UDP instead of UDP+EDNS0 for DNS server 10.42.0.1.', patternKey: 'jd-dns' }
  if (roll < 0.08) return { ...common, level: 'debug', service: 'cron', message: '(root) CMD (/opt/sparkman/agent --collect)', patternKey: 'jd-cron' }
  if (roll < 0.5) return { ...common, level: 'info', service: 'dockerd', message: `Container ${pick(['vllm-server', 'ollama', 'nim-llm', 'sglang', 'node-exporter'], rand('c'))} health_status: healthy`, patternKey: 'jd-docker' }
  return { ...common, level: 'info', service: 'systemd-logind', message: `New session ${int(rand('n'), 10, 900)} of user sparkman.`, patternKey: 'jd-session' }
}

function kernelLine(world: LogWorld, rand: Rand): Draft {
  const node = pick(world.nodes, rand('host'))
  const grouped = world.deployments.some((d) => d.replicas.some((r) => r.nodeIds.length > 1 && r.nodeIds.includes(node.id)))
  const common = { source: 'kernel' as const, host: node.id, service: 'kernel' }
  if (rand('lvl') < 0.5) {
    return grouped
      ? { ...common, level: 'info', message: 'mlx5_core 0000:01:00.0 enp1s0f0np0: Link up, 200000Mb/s', patternKey: 'k-cx7-link' }
      : { ...common, level: 'info', message: 'r8127 0000:02:00.0 enP7s7: Link is Up - 10Gbps/Full - flow control rx/tx', patternKey: 'k-eth-link' }
  }
  return { ...common, level: 'info', message: 'audit: type=1400 apparmor="STATUS" operation="profile_load" profile="docker-default"', patternKey: 'k-audit' }
}

function incidentLine(w: LogWindow, rand: Rand): Draft {
  const node = w.nodeId ?? 'spark-03'
  switch (w.kind) {
    case 'thermal':
      return rand('v') < 0.6
        ? { level: 'warn', source: 'journald', host: node, service: 'thermald', message: `zone acpitz ${int(rand('t'), 86, 93)}°C above passive trip point (85°C); throttling GPU clocks`, patternKey: 'th-trip' }
        : { level: 'warn', source: 'engine', host: node, service: 'nim', message: `Generation throughput degraded: ${int(rand('g'), 900, 1300)} tokens/s (-18%)`, patternKey: 'th-throughput' }
    case 'xid':
      return rand('v') < 0.7
        ? { level: 'error', source: 'kernel', host: node, service: 'kernel', message: `NVRM: Xid (PCI:000f:01:00): 31, pid=${int(rand('pid'), 40000, 60000)}, name=python3, Ch 0000000a, intr 10000000. MMU Fault: ENGINE GRAPHICS GPC1 GPCCLIENT_T1_3 faulted @ 0x7f3a_1c000000. Fault is of type FAULT_PDE ACCESS_TYPE_VIRT_READ`, patternKey: 'xid-31' }
        : { level: 'error', source: 'engine', host: node, service: 'engine', message: 'CUDA error: an illegal memory access was encountered', patternKey: 'cuda-illegal' }
    case 'gateway-5xx': {
      const v = rand('v')
      const common = { source: 'gateway' as const, host: GATEWAY_HOST, service: 'gateway', attributes: { upstream: node } }
      if (v < 0.5) return { ...common, level: 'error', message: `POST /v1/chat/completions 502 ${int(rand('ms'), 300, 2000)}ms upstream=${node} connection reset by peer`, patternKey: 'gw-502-reset', attributes: { ...common.attributes, 'http.status_code': '502' } }
      if (v < 0.8) return { ...common, level: 'error', message: `Timeout after 60000ms waiting for upstream ${node}`, patternKey: 'gw-timeout', attributes: { ...common.attributes, 'http.status_code': '504' } }
      return { ...common, level: 'warn', message: 'Retrying request on next replica (attempt 2/3)', patternKey: 'gw-retry' }
    }
  }
}

export function linesForSlot(world: LogWorld, slot: number): LogLine[] {
  const t0 = slot * SLOT_MS
  const r = (...k: (string | number)[]) => noise(world.seed, 'log', slot, ...k)
  const active = world.windows.filter((w) => t0 >= w.from && (w.to === null || t0 < w.to))
  const baseCount = 1 + Math.floor(r('count') * 3)
  const extra = active.reduce((s, w) => s + (w.kind === 'gateway-5xx' ? 3 : w.kind === 'xid' ? 2 : r('th', w.kind) < 0.15 ? 1 : 0), 0)
  const out: LogLine[] = []
  for (let i = 0; i < baseCount + extra; i++) {
    const rand: Rand = (k) => r(i, k)
    const ts = t0 + Math.floor(rand('ts') * SLOT_MS)
    let draft: Draft | null
    if (i >= baseCount) {
      draft = incidentLine(active[(i - baseCount) % active.length], rand)
    } else {
      const source = pickWeighted<LogSource>([
        { value: 'gateway', weight: 45 }, { value: 'engine', weight: 30 }, { value: 'journald', weight: 18 }, { value: 'kernel', weight: 7 },
      ], rand('src'))
      draft = source === 'gateway' ? gatewayLine(world, rand) : source === 'engine' ? engineLine(world, rand) : source === 'journald' ? journalLine(world, rand) : kernelLine(world, rand)
    }
    if (!draft || isOffline(world.outages, draft.host, ts)) continue
    out.push({
      id: `${slot}-${i}`,
      ts,
      level: draft.level,
      source: draft.source,
      host: draft.host,
      service: draft.service,
      message: draft.message,
      pattern: patternId(draft.patternKey),
      attributes: draft.attributes ?? {},
    })
  }
  return out.sort((a, b) => b.ts - a.ts)
}

export function queryLogs(
  world: LogWorld,
  opts: { from: number; to: number; query: ParsedLogQuery; limit: number },
): { lines: LogLine[]; truncated: boolean } {
  const out: LogLine[] = []
  let scanned = 0
  for (let s = Math.floor(opts.to / SLOT_MS); s >= Math.floor(opts.from / SLOT_MS) && out.length < opts.limit; s--) {
    if (++scanned > MAX_SCAN_SLOTS) return { lines: out, truncated: true }
    for (const line of linesForSlot(world, s)) {
      if (line.ts < opts.from || line.ts > opts.to || !matchesLogQuery(line, opts.query)) continue
      out.push(line)
      if (out.length >= opts.limit) break
    }
  }
  return { lines: out, truncated: false }
}

export function logHistogram(
  world: LogWorld,
  opts: { from: number; to: number; query: ParsedLogQuery; buckets: number },
): HistogramBucket[] {
  const width = (opts.to - opts.from) / opts.buckets
  return Array.from({ length: opts.buckets }, (_, b) => {
    const bFrom = opts.from + b * width
    const bTo = b === opts.buckets - 1 ? opts.to + 1 : bFrom + width
    const s0 = Math.floor(bFrom / SLOT_MS)
    const s1 = Math.floor((bTo - 1) / SLOT_MS)
    const slotCount = s1 - s0 + 1
    const samples = Math.min(slotCount, 40)
    const counts: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, debug: 0 }
    for (let k = 0; k < samples; k++) {
      const s = s0 + Math.floor((k * slotCount) / samples)
      for (const line of linesForSlot(world, s)) {
        if (line.ts >= bFrom && line.ts < bTo && matchesLogQuery(line, opts.query)) counts[line.level]++
      }
    }
    const scale = slotCount / samples
    return {
      t: bFrom,
      error: Math.round(counts.error * scale),
      warn: Math.round(counts.warn * scale),
      info: Math.round(counts.info * scale),
      debug: Math.round(counts.debug * scale),
    }
  })
}
