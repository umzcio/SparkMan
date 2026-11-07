import { Cpu, PencilLine } from 'lucide-react'
import type { CoolingController } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

export function ControllerCard({ controller, now, onEditZones }: { controller: CoolingController; now: number; onEditZones: () => void }) {
  const state = controller.failsafe ? 'Failsafe — all fans 100%' : controller.connected ? 'Connected' : 'Not answering'
  const tone = controller.failsafe ? 'bg-level-error' : controller.connected ? 'bg-brand' : 'bg-level-warn motion-safe:animate-pulse'
  const rows: [string, string][] = [
    ['Port', controller.port],
    ['Firmware', controller.firmware],
    ['Last heartbeat', controller.lastHeartbeatAt ? formatRelative(controller.lastHeartbeatAt, now) : '—'],
    ['Watchdog', `${formatDuration(controller.watchdogMs)} → 100%`],
  ]
  return (
    <Card className="gap-3 py-4" data-testid="controller-card">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Cpu className="size-4 text-muted-foreground" /> Raspberry Pi Pico
        </CardTitle>
        <span className="inline-flex items-center gap-1.5 text-xs" data-testid="controller-state">
          <span className={cn('size-1.5 rounded-full', tone)} aria-hidden />
          {state}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-mono text-xs leading-5">{v}</dd>
            </div>
          ))}
        </dl>
        <Button size="sm" variant="outline" className="w-full" onClick={onEditZones}>
          <PencilLine /> Edit zones
        </Button>
      </CardContent>
    </Card>
  )
}
