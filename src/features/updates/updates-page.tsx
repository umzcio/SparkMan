import { Fragment, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useNodeUpdates, useNodes, useRollouts } from '@/api/hooks'
import type { Rollout } from '@/api/types'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { PendingPackages } from './pending-packages'
import { RING_LABEL, RolloutProgress } from './rollout-progress'
import { RolloutSheet } from './rollout-sheet'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useUpdatesStatus } from '@/features/status/page-status'
import { cn } from '@/lib/utils'

export function UpdatesPage() {
  const status = useUpdatesStatus()
  const updates = useNodeUpdates()
  const rollouts = useRollouts()
  const nodes = useNodes()
  const [planOpen, setPlanOpen] = useState(false)
  const now = Date.now()
  const active = rollouts.data?.find((r) => r.status === 'running' || r.status === 'awaiting-approval')
  const history = rollouts.data?.filter((r) => r.status === 'completed' || r.status === 'failed') ?? []

  return (
    <>
      <PageHeader fleetData="updates"
        crumbs={[{ label: 'Maintain', to: '/updates' }, { label: 'Updates' }]}
        title="Updates"
        description={<StatusLine items={status} />}
        actions={
          <Button onClick={() => setPlanOpen(true)} disabled={!rollouts.data || active !== undefined}>
            Plan rollout
          </Button>
        }
      />
      <PageBody>
        {active && <RolloutProgress rollout={active} />}

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Nodes</CardTitle>
          </CardHeader>
          <QueryState query={updates}>
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Node</TableHead>
                    <TableHead>Ring</TableHead>
                    <TableHead>DGX OS</TableHead>
                    <TableHead>Packages</TableHead>
                    <TableHead>Firmware</TableHead>
                    <TableHead>Reboot</TableHead>
                    <TableHead className="text-right">Checked</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((u, i) => {
                    const upToDate = u.currentOs === u.targetOs && u.aptPending.length === 0 && u.firmwarePending.length === 0
                    const node = nodes.data?.find((n) => n.id === u.nodeId)
                    // an offline node's row is whatever its last check said
                    const away = node?.status === 'offline' ? 'offline' : node?.maintenance ? 'maintenance' : null
                    return (
                      <TableRow key={u.nodeId} data-testid="update-row" className={cn('enter-fade-up', node?.status === 'offline' && 'opacity-60')} style={stagger(i)}>
                        <TableCell className="font-mono">
                          {u.nodeId}
                          {away && <Badge variant="outline" className="ml-2 font-sans text-[11px] text-muted-foreground">{away}</Badge>}
                        </TableCell>
                        <TableCell>{RING_LABEL[u.ring]}</TableCell>
                        <TableCell className="font-mono text-xs">{upToDate ? <span className="text-brand">Up to date · {u.currentOs}</span> : `${u.currentOs} → ${u.targetOs}`}</TableCell>
                        <TableCell>
                          {u.aptPending.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <PendingPackages nodeId={u.nodeId} packages={u.aptPending} />
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {u.firmwarePending.length === 0 && <span className="text-muted-foreground">—</span>}
                            {u.firmwarePending.map((f) => (
                              <Badge key={f.component} variant="outline" className="font-mono text-[11px]">
                                {f.component} {f.available}
                              </Badge>
                            ))}
                            {u.model === 'ASUS GX10' && u.firmwarePending.length > 0 && (
                              <Badge variant="outline" className="text-level-warn">
                                stage carefully
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>{u.rebootRequired ? <Badge variant="outline" className="text-level-warn">required</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatRelative(u.lastChecked, now)}</TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">History</CardTitle>
          </CardHeader>
          <QueryState
            query={rollouts}
            isEmpty={() => history.length === 0}
            empty={
              <div className="p-4">
                <EmptyState title="No rollouts yet" description="Completed and rejected rollouts appear here." />
              </div>
            }
          >
            {() => (
              <Table>
                <TableBody>
                  {history.map((r) => (
                    <HistoryRow key={r.id} rollout={r} />
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>
      </PageBody>
      <RolloutSheet open={planOpen} onOpenChange={setPlanOpen} />
    </>
  )
}

/** One past rollout; opens to show what happened on each node, and why a node failed. */
function HistoryRow({ rollout: r }: { rollout: Rollout }) {
  const [open, setOpen] = useState(false)
  const failed = r.nodes.filter((n) => n.step === 'failed')
  // a rejected rollout fails without touching a node
  const rejected = r.status === 'failed' && !r.startedAt
  return (
    <Fragment>
      <TableRow data-testid="history-row" className="cursor-pointer" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <TableCell className="font-medium">
          <span className="flex items-center gap-1.5">
            <ChevronRight className={cn('size-3.5 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />
            {r.name}
          </span>
        </TableCell>
        <TableCell>{r.rings.map((x) => RING_LABEL[x]).join(' → ')}</TableCell>
        <TableCell className="text-muted-foreground">{r.startedAt ? formatDateTime(r.startedAt) : '—'}</TableCell>
        <TableCell className="font-mono tabular-nums">{r.startedAt && r.finishedAt ? formatDuration(r.finishedAt - r.startedAt) : '—'}</TableCell>
        <TableCell>
          <Badge variant="outline" className={r.status === 'completed' ? 'text-brand' : 'text-level-error'}>
            {rejected ? 'rejected' : r.status}
          </Badge>
          {failed.length > 0 && <span className="ml-2 font-mono text-xs text-level-error">{failed.map((n) => n.nodeId).join(', ')}</span>}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-muted/30 py-3">
            <div className="flex flex-col gap-1.5 pl-5">
              {r.nodes.map((n) => (
                <div key={n.nodeId} className="flex items-baseline gap-3 text-xs" data-testid={`history-node-${n.nodeId}`}>
                  <span className="w-24 shrink-0 font-mono">{n.nodeId}</span>
                  <span className="w-14 shrink-0 text-muted-foreground">{RING_LABEL[n.ring]}</span>
                  <span className={cn('w-16 shrink-0', n.step === 'done' ? 'text-brand' : n.step === 'failed' ? 'text-level-error' : 'text-muted-foreground')}>
                    {n.step === 'queued' ? 'not run' : n.step}
                  </span>
                  <span className="min-w-0 whitespace-normal text-muted-foreground">{n.note ?? (n.step === 'failed' ? 'no reason recorded' : '')}</span>
                </div>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}
