import type { CoolingState, FleetNode } from '@/api/types'
import { Faceplate } from '@/components/faceplate'
import { curveDuty } from '@/lib/cooling'
import { formatTemp } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FanBlade } from './fan-blade'
import { FAN_COLORS } from './fan-colors'

/** temperature chip colour from where the reading sits on the fan curve */
function heat(node: FleetNode, curve: CoolingState['policy']['curve']): string {
  if (!node.live) return 'bg-muted text-muted-foreground'
  const d = curveDuty(curve, node.live.gpuTempC)
  if (d >= 85) return 'bg-level-error/15 text-level-error'
  if (d >= 55) return 'bg-level-warn/15 text-level-warn'
  return 'bg-brand/15 text-brand'
}

/**
 * The top shelf with the fans standing in front of it. Fans are physical, so they keep their places;
 * which fan a box follows (its zone) shows as the coloured bar above it.
 */
export function ShelfHero({ cooling, nodes }: { cooling: CoolingState; nodes: FleetNode[] }) {
  const shelf = nodes.filter((n) => n.rack.shelf === 1).sort((a, b) => a.rack.slot - b.rack.slot)
  const color = (fanId: string) => FAN_COLORS[cooling.fans.findIndex((f) => f.id === fanId) % FAN_COLORS.length]
  return (
    <div className="overflow-hidden rounded-xl border bg-card p-3 md:p-5" data-testid="shelf-hero">
      <div className="mx-auto max-w-3xl space-y-3">
        <div className="grid gap-1.5 md:gap-2.5" style={{ gridTemplateColumns: `repeat(${shelf.length}, minmax(0, 1fr))` }}>
          {shelf.map((n) => {
            const fan = cooling.fans.find((f) => f.nodeIds.includes(n.id))
            return (
              <div key={n.id} className="flex flex-col items-center gap-1" data-testid="hero-box" data-node={n.id} data-fan={fan?.id ?? 'none'}>
                <span
                  className={cn('h-1 w-full rounded-full', !fan && 'border border-dashed border-muted-foreground/40')}
                  style={fan ? { background: color(fan.id) } : undefined}
                  title={fan ? `Follows ${fan.name}` : 'No fan'}
                />
                <Faceplate model={n.model} className={cn('w-full', !n.live && 'opacity-40 grayscale')} />
                <span className="w-full truncate text-center font-mono text-[9px] text-muted-foreground md:text-[11px]">{n.id}</span>
                <span className={cn('rounded px-1 font-mono text-[9px] tabular-nums md:text-xs', heat(n, cooling.policy.curve))} data-testid="hero-temp">
                  {n.live ? formatTemp(n.live.gpuTempC) : 'no data'}
                </span>
              </div>
            )
          })}
        </div>
        <div className="grid" style={{ gridTemplateColumns: `repeat(${cooling.fans.length}, minmax(0, 1fr))` }}>
          {cooling.fans.map((f) => (
            <div key={f.id} className="flex flex-col items-center gap-1" data-testid="hero-fan" data-fan={f.id} data-spinning={f.rpm > 0 ? 'true' : 'false'}>
              <FanBlade rpm={f.rpm} maxRpm={cooling.maxRpm} stalled={f.stalled} className="size-16 md:size-24" />
              <span className="inline-flex items-center gap-1.5 text-[10px] font-medium md:text-xs">
                <span className="size-2 rounded-full" style={{ background: color(f.id) }} aria-hidden />
                {f.name}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground md:text-xs">
                {f.duty}% · {f.rpm.toLocaleString()} rpm
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
