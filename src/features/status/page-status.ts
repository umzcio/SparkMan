import { useBenchRuns, useCooling, useDeployments, useGatewaySeries, useIncidents, useAlertRules, useKeys, useLogs, useNetwork, useNodeUpdates, useNodes, useRollouts, useUsage } from '@/api/hooks'
import type { StatusItem } from '@/components/status-line'
import { BENCH_KIND_LABEL } from '@/lib/bench'
import { reasonText } from '@/lib/cooling'
import { formatCompact, formatDuration, formatRelative } from '@/lib/format'

// Live page subtitles: each hook returns a few facts for its page, or null while loading.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const DAY = 86_400_000

export function useOverviewStatus(): StatusItem[] | null {
  const nodes = useNodes()
  const incidents = useIncidents()
  if (!nodes.data || !incidents.data) return null
  const live = nodes.data.filter((n) => n.live)
  const hottest = live.reduce<(typeof live)[number] | null>((m, n) => (!m || n.live!.gpuTempC > m.live!.gpuTempC ? n : m), null)
  const busiest = live.reduce<(typeof live)[number] | null>((m, n) => (!m || n.live!.gpuUtil > m.live!.gpuUtil ? n : m), null)
  const ongoing = incidents.data.filter((i) => i.status === 'ongoing').length
  return [
    ongoing ? { text: plural(ongoing, 'open incident'), tone: 'warn' } : { text: 'No open incidents', tone: 'ok' },
    ...(hottest ? [{ text: `Hottest ${hottest.id} ${Math.round(hottest.live!.gpuTempC)} °C`, tone: hottest.live!.gpuTempC >= 80 ? ('warn' as const) : undefined }] : []),
    ...(busiest ? [{ text: `Busiest ${busiest.id} ${Math.round(busiest.live!.gpuUtil)}% GPU` }] : []),
  ]
}

export function useNodesStatus(): StatusItem[] | null {
  const nodes = useNodes()
  if (!nodes.data) return null
  // nodes in maintenance get their own count instead of reading as offline or drained
  const count = (s: string) => nodes.data!.filter((n) => n.status === s && !n.maintenance).length
  const maint = nodes.data.filter((n) => n.maintenance).length
  const drained = nodes.data.filter((n) => n.drained && !n.maintenance).length
  return [
    { text: `${count('online')} online`, tone: 'ok' },
    ...(count('degraded') ? [{ text: `${count('degraded')} degraded`, tone: 'warn' as const }] : []),
    ...(count('rebooting') ? [{ text: `${count('rebooting')} rebooting`, tone: 'info' as const }] : []),
    ...(count('offline') ? [{ text: `${count('offline')} offline`, tone: 'error' as const }] : []),
    ...(maint ? [{ text: `${maint} in maintenance`, tone: 'muted' as const }] : []),
    ...(drained ? [{ text: `${drained} drained`, tone: 'muted' as const }] : []),
  ]
}

export function useGatewayStatus(): StatusItem[] | null {
  const series = useGatewaySeries('15m')
  const last = series.data?.at(-1)
  if (!last) return series.data ? [{ text: 'No traffic yet', tone: 'muted' }] : null
  const errPct = last.errorRate * 100
  return [
    { text: `${last.rps.toFixed(1)} req/s`, tone: 'ok' },
    { text: `TTFT ${formatDuration(last.ttftMs)}` },
    { text: `p95 ${formatDuration(last.p95Ms)}` },
    { text: `${errPct < 0.1 ? '<0.1' : errPct.toFixed(1)}% errors`, tone: errPct >= 2 ? 'error' : errPct >= 0.5 ? 'warn' : undefined },
  ]
}

export function useDeploymentsStatus(): StatusItem[] | null {
  const deps = useDeployments()
  const nodes = useNodes()
  if (!deps.data || !nodes.data) return null
  const live = deps.data.filter((d) => d.status !== 'stopped')
  const by = (s: string) => live.filter((d) => d.status === s).length
  const used = new Set(live.flatMap((d) => d.replicas.flatMap((r) => r.nodeIds))).size
  return [
    { text: `${by('serving')} serving`, tone: 'ok' },
    ...(by('loading') + by('pending') ? [{ text: `${by('loading') + by('pending')} starting`, tone: 'info' as const }] : []),
    ...(by('degraded') ? [{ text: `${by('degraded')} degraded`, tone: 'warn' as const }] : []),
    { text: `${used} of ${nodes.data.length} nodes in use` },
  ]
}

export function useBenchmarksStatus(): StatusItem[] | null {
  const runs = useBenchRuns({})
  const now = Date.now()
  if (!runs.data) return null
  const running = runs.data.filter((r) => r.status === 'running')
  const last = runs.data.find((r) => r.status !== 'running')
  const where = (r: (typeof runs.data)[number]) => (r.scope === 'gateway' ? 'the gateway' : r.nodeId)
  return [
    running.length ? { text: `${plural(running.length, 'bench', 'benches')} running`, tone: 'info' } : { text: 'Nothing running', tone: 'muted' },
    last ? { text: `Last: ${BENCH_KIND_LABEL[last.kind]} on ${where(last)} ${formatRelative(last.finishedAt ?? last.startedAt, now)}` } : { text: 'No runs yet' },
  ]
}

export function useUsageStatus(): StatusItem[] | null {
  const usage = useUsage('24h')
  if (!usage.data) return null
  const top = usage.data.topKeys[0]
  return [
    { text: `${formatCompact(usage.data.tokensIn + usage.data.tokensOut)} tokens today`, tone: 'ok' },
    { text: `${formatCompact(usage.data.requests)} requests` },
    { text: `${usage.data.tokensIn ? Math.round((usage.data.tokensCached / usage.data.tokensIn) * 100) : 0}% cache hits` },
    ...(top ? [{ text: `Top key ${top.name}` }] : []),
  ]
}

export function useKeysStatus(): StatusItem[] | null {
  const keys = useKeys()
  const now = Date.now()
  if (!keys.data) return null
  const active = keys.data.filter((k) => k.revokedAt === null)
  const usedToday = active.filter((k) => k.requests24h > 0).length
  const idle = active.filter((k) => !k.lastUsedAt || now - k.lastUsedAt > 30 * DAY).length
  return [
    { text: plural(active.length, 'active key'), tone: 'ok' },
    { text: `${usedToday} used today` },
    ...(idle ? [{ text: `${idle} idle 30+ days`, tone: 'warn' as const }] : []),
  ]
}

export function useLogsStatus(): StatusItem[] | null {
  const errors = useLogs({ query: 'level:error', range: '1h', limit: 1 }, true)
  const all = useLogs({ query: '', range: '15m', limit: 1 }, true)
  if (!errors.data || !all.data) return null
  const n = errors.data.total
  return [
    n ? { text: `${formatCompact(n)} errors in the last hour`, tone: 'error' } : { text: 'No errors in the last hour', tone: 'ok' },
    { text: `${formatCompact(Math.round(all.data.total / 15))} lines/min` },
  ]
}

export function useAlertsStatus(): StatusItem[] | null {
  const incidents = useIncidents()
  const rules = useAlertRules()
  const now = Date.now()
  if (!incidents.data || !rules.data) return null
  const ongoing = incidents.data.filter((i) => i.status === 'ongoing').length
  const resolvedWeek = incidents.data.filter((i) => i.resolvedAt && now - i.resolvedAt < 7 * DAY).length
  return [
    ongoing ? { text: `${ongoing} ongoing`, tone: 'warn' } : { text: 'All clear', tone: 'ok' },
    { text: `${resolvedWeek} resolved this week` },
    { text: `${rules.data.filter((r) => r.enabled).length} of ${rules.data.length} rules on` },
  ]
}

export function useUpdatesStatus(): StatusItem[] | null {
  const updates = useNodeUpdates()
  const rollouts = useRollouts()
  const nodes = useNodes()
  if (!updates.data || !rollouts.data) return null
  const behind = updates.data.filter((u) => u.currentOs !== u.targetOs || u.aptPending.length || u.firmwarePending.length).length
  const offline = new Set(nodes.data?.filter((n) => n.status === 'offline').map((n) => n.id))
  const reboot = updates.data.filter((u) => u.rebootRequired).map((u) => (offline.has(u.nodeId) ? `${u.nodeId} (offline)` : u.nodeId))
  const active = rollouts.data.find((r) => r.status === 'running' || r.status === 'awaiting-approval')
  return [
    behind ? { text: `${behind} of ${updates.data.length} nodes have updates`, tone: 'warn' } : { text: 'Fleet up to date', tone: 'ok' },
    ...(reboot.length ? [{ text: `Reboot needed: ${reboot.join(', ')}`, tone: 'warn' as const }] : []),
    active ? { text: active.status === 'running' ? `Rolling out ${active.name}` : `${active.name} awaiting approval`, tone: 'info' } : { text: 'No rollout running', tone: 'muted' },
  ]
}

export function useNetworkStatus(): StatusItem[] | null {
  const network = useNetwork()
  if (!network.data) return null
  const { switches } = network.data
  if (!switches.length) return [{ text: 'No switches configured', tone: 'muted' }]
  const links = switches.reduce((s, sw) => s + sw.ports.filter((p) => p.up).length, 0)
  const slow = switches.flatMap((sw) => sw.ports.filter((p) => p.problem))
  return [
    { text: `${plural(switches.length, 'switch', 'switches')} · ${plural(links, 'link')} up` },
    ...switches.filter((sw) => !sw.reachable).map((sw) => (sw.everReached ? { text: `${sw.name} not answering`, tone: 'error' as const } : { text: `${sw.name} waiting for first contact`, tone: 'muted' as const })),
    ...(slow.length ? [{ text: `${plural(slow.length, 'slow link')}: ${slow.map((p) => p.peer?.label ?? p.name).join(', ')}`, tone: 'warn' as const }] : []),
    ...(switches.every((sw) => sw.reachable || !sw.everReached) && !slow.length ? [{ text: 'All links at speed', tone: 'ok' as const }] : []),
  ]
}

export function useCoolingStatus(): StatusItem[] | null {
  const cooling = useCooling()
  if (!cooling.data) return null
  const { controller, fans } = cooling.data
  const avg = Math.round(fans.reduce((s, f) => s + f.duty, 0) / Math.max(1, fans.length))
  const driver = fans.filter((f) => f.reason.kind === 'temp' || f.reason.kind === 'load' || f.reason.kind === 'no-data').sort((a, b) => b.duty - a.duty)[0]
  const manual = fans.filter((f) => f.mode === 'manual').length
  return [
    { text: `${plural(fans.length, 'fan')} · avg ${avg}%` },
    ...(driver ? [{ text: driver.reason.kind === 'temp' ? `Driven by ${reasonText(driver.reason)}` : reasonText(driver.reason), tone: driver.reason.kind === 'no-data' ? ('warn' as const) : undefined }] : []),
    controller.failsafe
      ? { text: 'Pico offline — failsafe 100%', tone: 'error' }
      : controller.connected
        ? { text: 'Pico connected', tone: 'ok' }
        : { text: 'Pico not answering', tone: 'warn' },
    ...fans.filter((f) => f.stalled).map((f) => ({ text: `${f.name} stalled`, tone: 'error' as const })),
    ...(manual ? [{ text: `${manual} manual`, tone: 'info' as const }] : []),
  ]
}
