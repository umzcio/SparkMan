import { Link } from '@tanstack/react-router'
import { useDeployments, useIncidents, useNodes } from '@/api/hooks'
import type { FleetNode, NodeStatus } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusDot, STATUS_LABEL } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UsageBar } from '@/components/usage-bar'
import { formatRelative, formatTemp } from '@/lib/format'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useNodesStatus } from '@/features/status/page-status'

export type StatusFilter = 'all' | 'online' | 'degraded' | 'offline'
export const STATUS_FILTERS: StatusFilter[] = ['all', 'online', 'degraded', 'offline']

const MATCH: Record<StatusFilter, (s: NodeStatus) => boolean> = {
  all: () => true,
  online: (s) => s === 'online',
  degraded: (s) => s === 'degraded',
  offline: (s) => s === 'offline' || s === 'rebooting',
}

function NodeRow({ node, model, now, index }: { node: FleetNode; model?: string; now: number; index: number }) {
  return (
    <li className="enter-fade-up" style={stagger(index)}>
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: node.id }}
        data-testid="node-row"
        className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none md:grid-cols-[auto_minmax(0,1fr)_repeat(4,4.75rem)_7rem]"
      >
        <NodeStatusDot status={node.status} />
        <div className="min-w-0">
          <div className="font-mono font-medium">{node.id}</div>
          <div className="truncate text-xs text-muted-foreground">
            {node.model} · DGX OS {node.os.dgxOs}
            {model ? ` · ${model}` : ''}
            {node.maintenance ? ' · maintenance' : node.drained ? ' · drained' : ''}
          </div>
        </div>
        {/* phones: the gauges get their own row under the name */}
        <div className="col-span-2 grid grid-cols-4 gap-2 pl-6 md:contents">
          <UsageBar label="GPU" value={node.live?.gpuUtil ?? null} />
          <UsageBar label="Mem" value={node.live ? (node.live.memUsedGB / node.memoryGB) * 100 : null} />
          <UsageBar label="Disk" value={node.live?.diskUsedPct ?? null} />
          <UsageBar label="Temp" value={node.live?.gpuTempC ?? null} format={formatTemp} />
        </div>
        <div className="hidden text-right text-xs md:block">
          <div className="font-mono tabular-nums">{node.live ? formatRelative(node.lastSeen, now) : STATUS_LABEL[node.status]}</div>
          <div className="text-muted-foreground">{node.live ? '2 s scrape' : `since ${formatRelative(node.lastSeen, now)}`}</div>
        </div>
      </Link>
    </li>
  )
}

export function NodesPage({ status, onStatusChange }: { status: StatusFilter; onStatusChange: (s: StatusFilter) => void }) {
  const headerStatus = useNodesStatus()
  const nodes = useNodes()
  const deployments = useDeployments()
  const incidents = useIncidents()
  const now = Date.now()

  return (
    <>
      <PageHeader
        fleetData="nodes"
        crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Nodes' }]}
        title="Nodes"
        description={<StatusLine items={headerStatus} />}
        actions={<LiveBadge live />}
      />
      <PageBody>
        <QueryState query={nodes} skeleton={<Skeleton className="h-[640px] w-full" />}>
          {(list) => {
            const counts = Object.fromEntries(STATUS_FILTERS.map((f) => [f, list.filter((n) => MATCH[f](n.status)).length])) as Record<StatusFilter, number>
            const visible = list.filter((n) => MATCH[status](n.status))
            const ongoing = incidents.data?.filter((i) => i.status === 'ongoing' && i.nodeId) ?? []
            return (
              <Card className="gap-0 py-0">
                <div className="flex flex-wrap items-center gap-2 border-b p-4">
                  {STATUS_FILTERS.map((f) => (
                    <Button
                      key={f}
                      size="sm"
                      variant={status === f ? 'secondary' : 'ghost'}
                      aria-pressed={status === f}
                      onClick={() => onStatusChange(f)}
                      className="rounded-full capitalize"
                      data-testid={`filter-${f}`}
                    >
                      {f} · {counts[f]}
                    </Button>
                  ))}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {counts.online + counts.degraded} / {counts.all} reporting
                  </span>
                </div>
                {ongoing.map((i) => (
                  <Link key={i.id} to="/alerts" data-testid="incident-banner" className="mx-4 mt-4 block rounded-lg border border-level-warn/40 bg-level-warn/10 px-4 py-3 text-sm hover:border-level-warn/70">
                    <span className="font-medium text-level-warn">Ongoing · {i.title}</span>
                    <span className="block text-muted-foreground">Started {formatRelative(i.startedAt, now)} · view alert</span>
                  </Link>
                ))}
                {visible.length === 0 ? (
                  <div className="p-4">
                    <EmptyState title={`No ${status} nodes`} description="Every node is reporting in another state." />
                  </div>
                ) : (
                  <ul className="mt-2 divide-y">
                    {visible.map((n, i) => (
                      <NodeRow key={n.id} index={i} node={n} now={now} model={deployments.data?.find((d) => d.id === n.deploymentId)?.model} />
                    ))}
                  </ul>
                )}
              </Card>
            )
          }}
        </QueryState>
      </PageBody>
    </>
  )
}
