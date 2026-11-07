import { Cable, Loader, Plus, Square } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useDeployments, useStopDeployment } from '@/api/hooks'
import type { Deployment, DeploymentStatus } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCompact } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DeploySheet } from './deploy-sheet'
import { LaunchersCard } from './launchers'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useDeploymentsStatus } from '@/features/status/page-status'

const STATUS_CLASS: Record<DeploymentStatus, string> = {
  pending: 'text-muted-foreground',
  loading: 'text-level-info',
  serving: 'text-brand',
  degraded: 'text-level-warn',
  stopped: 'text-muted-foreground',
}

function NodeChips({ d }: { d: Deployment }) {
  return (
    <div className="flex flex-wrap gap-2">
      {d.replicas.map((r) => (
        <span key={r.id} className={cn('inline-flex items-center gap-1 rounded-md', r.nodeIds.length > 1 && 'border border-brand/30 bg-brand/5 px-1 py-0.5')}>
          {r.nodeIds.map((id, i) => (
            <Fragment key={id}>
              {i > 0 && <Cable className="size-3 text-brand" aria-label="ConnectX-7 link" />}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{id}</span>
            </Fragment>
          ))}
        </span>
      ))}
    </div>
  )
}

export function DeploymentsPage() {
  const status = useDeploymentsStatus()
  const deployments = useDeployments()
  const stop = useStopDeployment()
  const [deployOpen, setDeployOpen] = useState(false)
  const [stopping, setStopping] = useState<Deployment | null>(null)

  return (
    <>
      <PageHeader fleetData="deployments"
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Deployments' }]}
        title="Deployments"
        description={<StatusLine items={status} />}
        actions={
          <>
            <LiveBadge live />
            <Button onClick={() => setDeployOpen(true)}>
              <Plus />
              Deploy model
            </Button>
          </>
        }
      />
      <PageBody>
        <QueryState
          query={deployments}
          isEmpty={(list) => list.length === 0}
          empty={
            <EmptyState
              title="No deployments — deploy a model"
              description="Serve a model with vLLM, Ollama, NIM or SGLang to route agent traffic to it."
              action={
                <Button onClick={() => setDeployOpen(true)}>
                  <Plus />
                  Deploy model
                </Button>
              }
            />
          }
        >
          {(list) => (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right" title="Tokens generated per second over the last minute, all requests together">
                      tok/s
                    </TableHead>
                    <TableHead className="text-right" title="How fast one request generates, from the last 20 streamed requests through the gateway">
                      Speed
                    </TableHead>
                    <TableHead className="text-right">Context</TableHead>
                    <TableHead className="text-right">Mem / node</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((d, i) => (
                    <TableRow key={d.id} data-testid="deployment-row" className="enter-fade-up" style={stagger(i)}>
                      <TableCell>
                        <div className="font-medium">{d.displayName}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {[d.model, d.quant, `:${d.port}`].filter(Boolean).join(' · ')}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{d.engine}</Badge>
                      </TableCell>
                      <TableCell>
                        <NodeChips d={d} />
                      </TableCell>
                      <TableCell>
                        <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium capitalize', STATUS_CLASS[d.status])}>
                          {(d.status === 'pending' || d.status === 'loading') && <Loader className="size-3.5 motion-safe:animate-spin" />}
                          {d.status}
                        </span>
                      </TableCell>
                      <TableCell
                        className="text-right font-mono tabular-nums"
                        title={d.tokensPerSecFrom === 'gateway' ? 'Gateway traffic only: this engine reports no token counter' : undefined}
                      >
                        {formatCompact(d.tokensPerSec)}
                        {d.tokensPerSecFrom === 'gateway' && <span className="text-muted-foreground">*</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {d.decodeTokensPerSec == null ? <span className="text-muted-foreground">—</span> : `${Math.round(d.decodeTokensPerSec)} tok/s`}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{formatCompact(d.contextLength)}</TableCell>
                      <TableCell className="text-right font-mono tabular-nums">{d.memoryGBPerNode} GB</TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setStopping(d)}>
                          <Square />
                          Stop
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {list.some((d) => d.tokensPerSecFrom === 'gateway') && (
                <p className="border-t px-4 py-2 text-xs text-muted-foreground">* Gateway traffic only. This engine reports no token counter, so requests sent straight to it don't show.</p>
              )}
            </Card>
          )}
        </QueryState>
        <LaunchersCard />
      </PageBody>
      <DeploySheet open={deployOpen} onOpenChange={setDeployOpen} />
      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {stopping?.model}?</DialogTitle>
            <DialogDescription>Agents requesting this model will get 404 from the gateway. Its nodes become free.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopping(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (stopping) stop.mutate(stopping.id)
                setStopping(null)
              }}
            >
              Stop deployment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
