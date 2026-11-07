import { useApproveRollout, useCancelRollout } from '@/api/hooks'
import type { Rollout, RolloutStep, UpdateRing } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export const RING_LABEL: Record<UpdateRing, string> = { canary: 'Canary', ring1: 'Ring 1', ring2: 'Ring 2' }
const STEPS: RolloutStep[] = ['precheck', 'apply', 'reboot', 'postcheck']
const STATUS_LABEL: Record<Rollout['status'], string> = { 'awaiting-approval': 'Awaiting approval', running: 'Running', completed: 'Completed', failed: 'Failed' }

function stepState(current: RolloutStep, step: RolloutStep): 'done' | 'active' | 'todo' {
  if (current === 'done' || current === 'start-model') return 'done'
  const ci = STEPS.indexOf(current)
  const si = STEPS.indexOf(step)
  if (ci === -1) return 'todo'
  return si < ci ? 'done' : si === ci ? 'active' : 'todo'
}

export function RolloutProgress({ rollout }: { rollout: Rollout }) {
  const approve = useApproveRollout()
  const reject = useCancelRollout()
  const busy = approve.isPending || reject.isPending
  return (
    <Card data-testid="active-rollout">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          {rollout.name}
          <Badge variant="outline" className={rollout.status === 'running' ? 'text-brand' : 'text-level-warn'}>
            {STATUS_LABEL[rollout.status]}
          </Badge>
        </CardTitle>
        <CardDescription>
          {rollout.rings.map((r) => RING_LABEL[r]).join(' → ')} · window: {rollout.window}
        </CardDescription>
        {rollout.status === 'awaiting-approval' && (
          <CardAction className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => reject.mutate(rollout.id)} disabled={busy}>
              Reject
            </Button>
            <Button size="sm" onClick={() => approve.mutate(rollout.id)} disabled={busy}>
              Approve
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rollout.rings.map((ring) => (
          <div key={ring} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{RING_LABEL[ring]}</h3>
            {rollout.nodes
              .filter((n) => n.ring === ring)
              .map((n) => (
                <div key={n.nodeId} className="flex items-center gap-3" data-testid={`rollout-node-${n.nodeId}`} data-step={n.step}>
                  <div className="flex w-28 flex-col">
                    <span className="font-mono text-sm">{n.nodeId}</span>
                    {n.launcher && (
                      <span className={cn('truncate text-[11px]', n.step === 'stop-model' || n.step === 'start-model' ? 'text-level-info motion-safe:animate-pulse' : 'text-muted-foreground')}>
                        {n.step === 'stop-model' ? `stopping ${n.launcher.name}` : n.step === 'start-model' ? `starting ${n.launcher.name}` : n.launcher.name}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-1 gap-1">
                    {STEPS.map((s) => {
                      const st = stepState(n.step, s)
                      return (
                        <span
                          key={s}
                          className={cn(
                            'flex-1 rounded px-2 py-1 text-center font-mono text-[11px]',
                            st === 'done' && 'bg-brand/15 text-brand',
                            st === 'active' && 'bg-level-info/20 text-level-info motion-safe:animate-pulse',
                            st === 'todo' && 'bg-muted text-muted-foreground',
                          )}
                        >
                          {s}
                        </span>
                      )
                    })}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
