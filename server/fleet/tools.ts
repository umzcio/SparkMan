import type { Engine, GpuProcess, HealthCheck, NodeLiveStats, SparkToolEnvelope } from '../../src/api/types.ts'
import type { NodeFacts, RawSample } from './sample.ts'

/** NVIDIA's lifecycle tools print `{ ok, data, errors, meta }` on stdout. */
export interface ToolOutput {
  ok: boolean
  data: Record<string, unknown> | null
  errors: unknown[]
  meta?: { tool?: string; version?: string; collected_at_utc?: string }
}

export function parseToolOutput(stdout: string): ToolOutput | null {
  const start = stdout.indexOf('{')
  if (start < 0) return null
  try {
    const v = JSON.parse(stdout.slice(start)) as ToolOutput
    return typeof v === 'object' && v !== null && 'ok' in v ? v : null
  } catch {
    return null
  }
}

const errText = (e: unknown): string =>
  typeof e === 'string' ? e : typeof e === 'object' && e !== null && 'message' in e ? String((e as { message: unknown }).message) : JSON.stringify(e)

/**
 * fwupd exits non-zero with "No updates available" when everything is current; the tool reports that
 * as an error. It isn't one.
 */
export const isBenignToolError = (msg: string) => /No updates available/i.test(msg)

/** The UI's envelope for one tool run. */
export function toEnvelope(
  tool: string, host: string, out: ToolOutput | null, rc: number, durationMs: number, summary: Record<string, unknown>, extraWarnings: string[] = [],
): SparkToolEnvelope {
  const errors = (out?.errors ?? []).map(errText).filter((e) => !isBenignToolError(e))
  const warnings = [...errors, ...extraWarnings]
  const failed = out === null || (!out.ok && errors.length > 0)
  const artifacts: string[] = []
  const data = out?.data as Record<string, unknown> | null | undefined
  for (const k of ['tarball', 'bundle_path', 'output_dir', 'artifact']) if (typeof data?.[k] === 'string') artifacts.push(data[k] as string)
  return {
    tool,
    ts: out?.meta?.collected_at_utc ?? new Date().toISOString(),
    host,
    status: failed ? 'error' : warnings.length ? 'warn' : 'ok',
    rc,
    duration_ms: durationMs,
    summary: out === null ? { error: 'no JSON on stdout' } : summary,
    warnings: out === null ? [`${tool} printed no JSON (exit ${rc})`] : warnings,
    artifacts,
  }
}

export interface HealthInputs {
  live: NodeLiveStats | null
  memoryGB: number
  diskGB: number
  facts: NodeFacts | null
  sample: RawSample | null
  /** spark_updatectl status data */
  updateStatus: Record<string, unknown> | null
  /** spark_diagctl health data */
  diag: Record<string, unknown> | null
}

const rec = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

export function healthChecks(h: HealthInputs): HealthCheck[] {
  const { live } = h
  const checks: HealthCheck[] = []
  checks.push({
    name: 'GPU visible (nvidia-smi)',
    status: live && h.sample?.gpu ? 'pass' : 'fail',
    detail: live && h.sample?.gpu ? `NVIDIA GB10 · driver ${h.facts?.driver || 'unknown'}` : live ? 'nvidia-smi returned nothing' : 'Node unreachable over SSH',
  })
  checks.push({
    name: 'Unified memory',
    status: !live ? 'fail' : live.memUsedGB > h.memoryGB * 0.97 ? 'warn' : 'pass',
    detail: live ? `${Math.round(live.memUsedGB)} GB of ${h.memoryGB} GB used (MemAvailable)` : 'No data',
  })
  checks.push({
    name: 'GPU temperature',
    status: !live ? 'fail' : live.gpuTempC > 85 ? 'fail' : live.gpuTempC > 78 || live.throttling ? 'warn' : 'pass',
    detail: live ? `GPU ${Math.round(live.gpuTempC)} °C · ACPI ${Math.round(live.acpiTempC)} °C${live.throttling ? ' · clocks throttled' : ''}` : 'No data',
  })
  const nvme = h.sample?.hwmon.nvme ?? []
  const nvmeC = nvme.length ? Math.max(...nvme) / 1000 : null
  checks.push({
    name: 'NVMe temperature',
    status: nvmeC === null ? 'warn' : nvmeC > 80 ? 'fail' : nvmeC > 70 ? 'warn' : 'pass',
    detail: nvmeC === null ? 'No NVMe sensor reported' : `${Math.round(nvmeC)} °C`,
  })
  checks.push({
    name: 'Disk usage',
    status: !live ? 'fail' : live.diskUsedPct > 90 ? 'fail' : live.diskUsedPct > 80 ? 'warn' : 'pass',
    detail: live ? `${Math.round(live.diskUsedPct)}% of ${h.diskGB} GB` : 'No data',
  })
  const links = Object.entries(h.sample?.links ?? {})
  const up = links.filter(([, s]) => s === 'up').map(([i]) => i)
  checks.push({
    name: 'ConnectX-7 link',
    status: !h.sample ? 'fail' : 'pass',
    detail: !h.sample ? 'No data' : up.length ? `${up.join(', ')} up` : 'No QSFP link (single-node)',
  })
  const mlx = h.sample?.hwmon.mlx5 ?? []
  if (mlx.length) {
    const c = Math.max(...mlx) / 1000
    checks.push({ name: 'ConnectX-7 temperature', status: c > 95 ? 'fail' : c > 85 ? 'warn' : 'pass', detail: `${Math.round(c)} °C` })
  }
  const pending = rec(rec(h.updateStatus).pending_reboot)
  checks.push({
    name: 'Pending reboot',
    status: h.updateStatus === null ? 'warn' : pending.pending === true ? 'warn' : 'pass',
    detail: h.updateStatus === null ? 'spark_updatectl status unavailable' : pending.pending === true ? `Reboot required${Array.isArray(pending.indicators) && pending.indicators.length ? ` (${pending.indicators.join(', ')})` : ''}` : 'None',
  })
  const load = rec(rec(rec(h.diag).cpu).load_average)
  if (typeof load['5min'] === 'number') {
    const cpus = h.facts?.cpus ?? 20
    const l5 = load['5min'] as number
    checks.push({ name: 'CPU load', status: l5 > cpus * 1.5 ? 'warn' : 'pass', detail: `${l5.toFixed(2)} (5 min) on ${cpus} cores` })
  }
  return checks
}

export function healthStatus(checks: HealthCheck[]): SparkToolEnvelope['status'] {
  return checks.some((c) => c.status === 'fail') ? 'error' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'
}

/** firmware_reporter data → component/version rows. */
export function firmwareRows(data: Record<string, unknown> | null): { component: string; version: string }[] {
  const rows: { component: string; version: string }[] = []
  const dmi = rec(data?.platform_dmi)
  if (typeof dmi.bios_version === 'string') rows.push({ component: 'UEFI / BIOS', version: dmi.bios_version })
  const devices = rec(data?.fwupd).devices
  if (Array.isArray(devices)) {
    for (const d of devices) {
      const dev = rec(d)
      if (typeof dev.name === 'string' && typeof dev.current_version === 'string') rows.push({ component: dev.name, version: dev.current_version })
    }
  }
  return rows
}

/** Packages worth showing on a node page (the full dpkg list is ~3000 rows). */
export const PACKAGE_PATTERN = /^(nvidia-|cuda-|libnccl|dgx-|linux-image-|mlnx|doca|docker|containerd|tailscale|fwupd|python3$|openssh-server)/

export function parsePackages(dpkg: string): { name: string; version: string }[] {
  return dpkg
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, version]) => name && version && PACKAGE_PATTERN.test(name))
    .map(([name, version]) => ({ name, version }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function engineOf(name: string): Engine | null {
  const n = name.toLowerCase()
  if (n.includes('vllm')) return 'vLLM'
  if (n.includes('sglang')) return 'SGLang'
  if (n.includes('ollama')) return 'Ollama'
  if (n.includes('nim') || n.includes('triton') || n.includes('trtllm')) return 'NIM'
  return null
}

/**
 * Lines of `pid<TAB>user<TAB>rss_kb<TAB>gpu_mib<TAB>command` from the processes script. GB10 has no
 * dedicated VRAM, so nvidia-smi reports [N/A] per process; resident memory stands in.
 */
export function parseProcesses(text: string): GpuProcess[] {
  const out: GpuProcess[] = []
  for (const line of text.split('\n')) {
    const [pid, user, rssKb, gpuMib, ...cmd] = line.split('\t')
    const p = Number(pid)
    if (!Number.isInteger(p) || p <= 0) continue
    const name = cmd.join('\t').trim()
    const gpu = Number(gpuMib)
    out.push({ pid: p, user: user || '?', name, engine: engineOf(name), gpuMemMiB: Number.isFinite(gpu) && gpu > 0 ? gpu : Math.round((Number(rssKb) || 0) / 1024) })
  }
  return out.sort((a, b) => b.gpuMemMiB - a.gpuMemMiB)
}

export const PROCESSES_SCRIPT = String.raw`
nvidia-smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits 2>/dev/null | while IFS=, read -r pid mem; do
  pid=$(echo "$pid" | tr -d ' '); mem=$(echo "$mem" | tr -d ' []A-Z/')
  [ -d "/proc/$pid" ] || continue
  user=$(ps -o user= -p "$pid" 2>/dev/null | tr -d ' ')
  rss=$(awk '/^VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null)
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-200)
  [ -n "$rss" ] || rss=0; [ -n "$mem" ] || mem=0
  printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$user" "$rss" "$mem" "$cmd"
done
`
