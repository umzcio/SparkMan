import { Link } from '@tanstack/react-router'
import { Server } from 'lucide-react'
import { useState } from 'react'
import { useDeployments, useNode } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusBadge } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LogExplorer, type LogExplorerState } from '@/features/logs/log-explorer'
import { formatDuration, formatRelative } from '@/lib/format'
import { NodeActions } from './node-actions'
import { NodeHealthTab } from './node-health-tab'
import { NodeInventoryTab } from './node-inventory-tab'
import { NodeMetricsTab } from './node-metrics-tab'
import { NodeProcessesTab } from './node-processes-tab'

export const NODE_TABS = ['metrics', 'processes', 'inventory', 'health', 'logs'] as const
export type NodeTab = (typeof NODE_TABS)[number]

function NodeLogsTab({ nodeId }: { nodeId: string }) {
  const [state, setState] = useState<LogExplorerState>({ query: '', range: '1h', live: true, view: 'list' })
  return <LogExplorer state={state} onChange={(patch) => setState((s) => ({ ...s, ...patch }))} lockedQuery={`host:${nodeId}`} compact />
}

export function NodeDetailPage({ nodeId, tab, range, onTab, onRange }: { nodeId: string; tab: NodeTab; range: TimeRange; onTab: (t: NodeTab) => void; onRange: (r: TimeRange) => void }) {
  const node = useNode(nodeId)
  const deployments = useDeployments()
  const crumbs = [{ label: 'Nodes', to: '/nodes' as const }, { label: nodeId }]

  if (node.isSuccess && node.data === null) {
    return (
      <>
        <PageHeader
        fleetData="nodes" crumbs={crumbs} title="Node not found" />
        <PageBody>
          <EmptyState
            title={`No node “${nodeId}” in this fleet`}
            description="It may have been renamed or removed."
            action={
              <Button asChild variant="outline">
                <Link to="/nodes">Back to nodes</Link>
              </Button>
            }
          />
        </PageBody>
      </>
    )
  }

  return (
    <QueryState
      query={node}
      skeleton={
        <>
          <PageHeader
        fleetData="nodes" crumbs={crumbs} title={nodeId} />
          <PageBody>
            <Skeleton className="h-96 w-full" />
          </PageBody>
        </>
      }
    >
      {(n) => {
        if (!n) return null
        const dep = deployments.data?.find((d) => d.id === n.deploymentId)
        const now = Date.now()
        return (
          <>
            <PageHeader
        fleetData="nodes"
              crumbs={crumbs}
              title={
                <span className="flex flex-wrap items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-xl border bg-card">
                    <Server className="size-5" />
                  </span>
                  <span className="font-mono">{n.id}</span>
                  <NodeStatusBadge status={n.status} />
                  {n.maintenance ? <Badge variant="outline">Maintenance</Badge> : n.drained && <Badge variant="outline">Drained</Badge>}
                </span>
              }
              description={
                <span className="font-mono text-xs">
                  {n.model} · DGX OS {n.os.dgxOs} · driver {n.os.driver} · CUDA {n.os.cuda} · up {formatDuration(now - n.bootedAt)} · last seen {formatRelative(n.lastSeen, now)}
                  {dep ? ` · serving ${dep.model} (${dep.engine})` : ''}
                </span>
              }
              actions={
                <>
                  <LiveBadge live />
                  <TimeRangeToggle value={range} onChange={onRange} />
                  <NodeActions node={n} />
                </>
              }
            />
            <PageBody>
              <Tabs value={tab} onValueChange={(v) => onTab(v as NodeTab)}>
                <TabsList>
                  <TabsTrigger value="metrics">Metrics</TabsTrigger>
                  <TabsTrigger value="processes">Processes</TabsTrigger>
                  <TabsTrigger value="inventory">Inventory</TabsTrigger>
                  <TabsTrigger value="health">Health</TabsTrigger>
                  <TabsTrigger value="logs">Logs</TabsTrigger>
                </TabsList>
                <TabsContent value="metrics" className="mt-4">
                  <NodeMetricsTab node={n} range={range} />
                </TabsContent>
                <TabsContent value="processes" className="mt-4">
                  <NodeProcessesTab nodeId={n.id} />
                </TabsContent>
                <TabsContent value="inventory" className="mt-4">
                  <NodeInventoryTab node={n} />
                </TabsContent>
                <TabsContent value="health" className="mt-4">
                  <NodeHealthTab nodeId={n.id} />
                </TabsContent>
                <TabsContent value="logs" className="mt-4">
                  <NodeLogsTab nodeId={n.id} />
                </TabsContent>
              </Tabs>
            </PageBody>
          </>
        )
      }}
    </QueryState>
  )
}
