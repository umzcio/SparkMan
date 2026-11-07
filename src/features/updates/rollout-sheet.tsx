import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useLaunchers, useNodes, useNodeUpdates, useStartRollout } from '@/api/hooks'
import type { UpdateRing } from '@/api/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { useSimulatorOn } from '@/lib/data-source'
import { cn } from '@/lib/utils'
import { RING_LABEL } from './rollout-progress'

const RING_ORDER: UpdateRing[] = ['canary', 'ring1', 'ring2']
// the simulator has no scheduler: every window starts as soon as the rollout runs
const WINDOWS = ['Now', 'Tonight 02:00–04:00', 'Sunday 02:00–04:00']

export function RolloutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const start = useStartRollout()
  const [rings, setRings] = useState<UpdateRing[]>(['canary', 'ring1', 'ring2'])
  const [window, setWindow] = useState(WINDOWS[0])
  const [requireApproval, setRequireApproval] = useState(true)
  const [restartModels, setRestartModels] = useState(false)
  const launchers = useLaunchers().data ?? []
  const fleet = useNodes().data ?? []
  const simulator = useSimulatorOn()
  const updates = useNodeUpdates()
  const nodes = updates.data ?? []
  const ringNodes = (ring: UpdateRing) => nodes.filter((n) => n.ring === ring)
  const RINGS = RING_ORDER.map((ring) => ({ ring, nodes: ringNodes(ring).length })).filter((r) => r.nodes > 0)
  // models holding nodes in the chosen rings: restartable when serving and wholly inside the rollout
  const inRings = (id: string) => rings.includes(nodes.find((n) => n.nodeId === id)?.ring ?? ('' as UpdateRing))
  const models = launchers.filter((l) => l.state !== 'idle' && l.nodeIds.some(inRings))
  const restartable = models.filter((l) => l.state === 'serving' && l.nodeIds.every(inRings))
  // what the server will do with each node in the chosen rings (mirrors startRollout)
  const plan = RING_ORDER.filter((r) => rings.includes(r)).flatMap(ringNodes).map((u) => {
    const n = fleet.find((x) => x.id === u.nodeId)
    const l = models.find((x) => x.nodeIds.includes(u.nodeId))
    const skip = (why: string) => ({ id: u.nodeId, ok: false, note: why })
    if (n?.maintenance) return skip('in maintenance')
    if (n?.status === 'offline' || n?.status === 'rebooting') return skip(n.status)
    if (!l) return { id: u.nodeId, ok: true, note: u.aptPending.length || u.firmwarePending.length ? 'has updates' : 'up to date' }
    if (restartModels && restartable.includes(l)) return { id: u.nodeId, ok: true, note: `restarts ${l.name}` }
    if (l.state !== 'serving') return skip(`${l.name} is ${l.state}`)
    if (!l.nodeIds.every(inRings)) return skip(`${l.name} spans rings left out`)
    return skip(`running ${l.name}`)
  })
  const included = plan.filter((p) => p.ok).length
  const gx10Late = rings.filter((r) => r !== 'canary').flatMap(ringNodes).filter((n) => n.model === 'ASUS GX10').length

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>Plan rollout</SheetTitle>
          <SheetDescription>spark_updatectl runs precheck → apply → reboot → postcheck on each ring before moving to the next.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-2">
          <div className="flex flex-col gap-2">
            <Label>Target</Label>
            <p className="rounded-lg border bg-surface-2 px-3 py-2 font-mono text-sm">
              {simulator ? 'DGX OS 7.5.0 · driver 580.159.03 · CUDA 13.0.2 · UEFI 1.110.13' : 'Latest apt packages and fwupd firmware on each node'}
            </p>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Rings</legend>
            {RINGS.map((r) => (
              <div key={r.ring} className="flex items-center gap-2">
                <Checkbox
                  id={`ring-${r.ring}`}
                  checked={rings.includes(r.ring)}
                  onCheckedChange={(c) => setRings((prev) => (c === true ? [...prev, r.ring] : prev.filter((x) => x !== r.ring)))}
                />
                <Label htmlFor={`ring-${r.ring}`} className="font-normal">
                  {RING_LABEL[r.ring]} · {r.nodes} node{r.nodes > 1 ? 's' : ''}
                </Label>
              </div>
            ))}
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rollout-window">Maintenance window</Label>
            <Select value={window} onValueChange={setWindow}>
              <SelectTrigger id="rollout-window" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                    {simulator && w !== 'Now' ? ' (simulated: starts immediately)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="rollout-approval">Require approval before starting</Label>
            <Switch id="rollout-approval" checked={requireApproval} onCheckedChange={setRequireApproval} />
          </div>
          {models.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="rollout-restart-models">Stop models, update, start them again</Label>
                <Switch id="rollout-restart-models" checked={restartModels} onCheckedChange={setRestartModels} />
              </div>
              <p className="text-xs text-muted-foreground">
                {restartModels
                  ? `${restartable.map((l) => l.name).join(', ') || 'No model'} will stop before ${restartable.length === 1 ? 'its' : 'their'} first node and start again after the last.`
                  : `Off: nodes running a model are skipped.`}
                {restartModels && restartable.length < models.length && ' Models that aren’t serving, or that span rings left out, are skipped.'}
              </p>
            </div>
          )}
          {gx10Late > 0 && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>
                This rollout includes {gx10Late} ASUS GX10 unit{gx10Late === 1 ? '' : 's'}
              </AlertTitle>
              <AlertDescription>ASUS SOC capsule firmware has bricked units in the field. Let Canary and Ring 1 soak first.</AlertDescription>
            </Alert>
          )}
          {plan.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {included} of {plan.length} node{plan.length === 1 ? '' : 's'} will update
              </span>
              <ul className="flex flex-col divide-y rounded-lg border bg-surface-2 text-sm" data-testid="rollout-plan">
                {plan.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className={cn('font-mono', !p.ok && 'text-muted-foreground line-through decoration-muted-foreground/50')}>{p.id}</span>
                    <span className={cn('truncate text-xs', p.ok ? 'text-muted-foreground' : 'text-level-warn')}>{p.ok ? p.note : `skipped: ${p.note}`}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">A node reboots only if an update needs it.</p>
            </div>
          )}
        </div>
        <SheetFooter>
          <Button
            disabled={rings.length === 0 || (!simulator && included === 0) || start.isPending}
            onClick={() =>
              start.mutate(
                { targetOs: '7.5.0', rings, window, requireApproval, restartModels },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Create rollout
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
