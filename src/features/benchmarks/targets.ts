import type { BenchKind, Deployment, FleetNode } from '@/api/types'
import { GATEWAY_TARGET } from '@/api/types'

/**
 * What a bench can run against: one copy of a model (a single node, or a tensor-parallel group
 * benched through its head = first node), or — for a model served as several copies — the
 * gateway, which load-balances across all of them.
 */
export type BenchTarget =
  | { key: string; scope: 'replica'; deployment: Deployment; nodes: FleetNode[] }
  | { key: string; scope: 'gateway'; deployment: Deployment; copies: FleetNode[][] }

/** Bench kinds the gateway can run (quality and tool use are the same on every copy). */
export const GATEWAY_KINDS: BenchKind[] = ['decode', 'prefill']

export const gatewayKey = (deploymentId: string) => `${GATEWAY_TARGET}:${deploymentId}`

export function benchTargets(nodes: FleetNode[], deployments: Deployment[]): BenchTarget[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const live = deployments.filter((d) => d.status !== 'stopped')
  const copies = (d: Deployment) => d.replicas.map((r) => r.nodeIds.map((id) => byId.get(id)).filter((n): n is FleetNode => !!n)).filter((c) => c.length > 0)
  const replicas: BenchTarget[] = live.flatMap((d) => copies(d).map((c): BenchTarget => ({ key: c[0].id, scope: 'replica', deployment: d, nodes: c })))
  // fleet order: by the head's position in the node list
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  replicas.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
  const gateways: BenchTarget[] = live.filter((d) => d.replicas.length > 1).map((d) => ({ key: gatewayKey(d.id), scope: 'gateway', deployment: d, copies: copies(d) }))
  return [...replicas, ...gateways]
}

/** The target for a URL value: a target key, or any node of a group (a worker resolves to its head). */
export function resolveTarget(targets: BenchTarget[], value: string | undefined): BenchTarget | undefined {
  if (!value) return undefined
  return targets.find((t) => t.key === value) ?? targets.find((t) => t.scope === 'replica' && t.nodes.some((n) => n.id === value))
}

export const targetNodes = (t: BenchTarget): FleetNode[] => (t.scope === 'replica' ? t.nodes : t.copies.flat())

/** The id runs for this target are filed under. */
export const targetRunNode = (t: BenchTarget): string => (t.scope === 'replica' ? t.nodes[0].id : GATEWAY_TARGET)

export function targetLabel(t: BenchTarget): string {
  if (t.scope === 'gateway') return `Gateway · ${t.copies.length} copies`
  return t.nodes.length > 1 ? `${t.nodes[0].id} + ${t.nodes.length - 1}` : t.nodes[0].id
}

export function targetProblem(t: BenchTarget, kind: BenchKind): string | null {
  const down = targetNodes(t).find((n) => n.status === 'offline' || n.status === 'rebooting')
  if (down) return `${down.id} is ${down.status}`
  if (t.deployment.status !== 'serving') return `${t.deployment.model} is ${t.deployment.status}`
  if (t.scope === 'gateway' && !GATEWAY_KINDS.includes(kind)) return 'Quality and tool use are the same on every copy — bench one node instead'
  return null
}

/** The copy noticeably slower than the rest (by `metric`), if any: worth checking its load or thermals. */
export function slowCopy<T extends { nodeIds: string[] }>(copies: T[], metric: (c: T) => number, threshold = 0.85): { copy: T; slowerPct: number } | null {
  if (copies.length < 2) return null
  let worst: { copy: T; slowerPct: number } | null = null
  for (const c of copies) {
    const others = copies.filter((o) => o !== c).map(metric).sort((a, b) => a - b)
    const mid = others.length / 2
    const median = others.length % 2 ? others[Math.floor(mid)] : (others[mid - 1] + others[mid]) / 2
    if (median <= 0) continue
    const ratio = metric(c) / median
    if (ratio < threshold && (!worst || 1 - ratio > worst.slowerPct / 100)) worst = { copy: c, slowerPct: Math.round((1 - ratio) * 100) }
  }
  return worst
}
