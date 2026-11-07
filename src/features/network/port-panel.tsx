import type { NetworkSwitch, SwitchPort } from '@/api/types'
import { cn } from '@/lib/utils'
import { formatLinkSpeed } from './format'
import { PortHover } from './port-hover'

/**
 * The switch's front panel: copper ports odd-over-even like the faceplate, then the SFP cages; on a QSFP switch one
 * wide cage per port (a breakout's lanes beside it) and the management ports last.
 */
export function PortPanel({ sw }: { sw: NetworkSwitch }) {
  const groups = (['rj45', 'sfp', 'qsfp', 'mgmt'] as const).map((kind) => sw.ports.filter((p) => p.kind === kind)).filter((g) => g.length)
  return (
    <div className="flex flex-wrap items-start gap-4 overflow-x-auto pb-1" data-testid={`ports-${sw.id}`}>
      {groups.map((ports) =>
        ports[0].kind === 'qsfp' ? (
          <div key="qsfp" className="flex flex-wrap gap-2">
            {cages(ports).map(([cage, lanes]) => (
              <div key={cage} className="flex gap-1">
                {lanes.map((p) => <PortTile key={p.id} port={p} wide={lanes.length === 1} />)}
              </div>
            ))}
          </div>
        ) : (
          <div key={ports[0].kind} className="grid grid-flow-col gap-1" style={{ gridTemplateRows: ports.length > 2 ? 'repeat(2, auto)' : undefined }}>
            {faceplateOrder(ports).map((p, i) => <PortTile key={p.id} port={p} side={ports.length > 2 && i % 2 === 1 ? 'bottom' : 'top'} />)}
          </div>
        ),
      )}
    </div>
  )
}

/** columns of [odd, even]: 1 over 2, 3 over 4, … */
function faceplateOrder(ports: SwitchPort[]): SwitchPort[] {
  if (ports.length <= 2) return ports
  const out: SwitchPort[] = []
  for (let i = 0; i < ports.length; i += 2) out.push(ports[i], ...(ports[i + 1] ? [ports[i + 1]] : []))
  return out
}

function cages(ports: SwitchPort[]): [string, SwitchPort[]][] {
  const by = new Map<string, SwitchPort[]>()
  for (const p of ports) {
    const cage = p.label.split('·')[0]
    by.set(cage, [...(by.get(cage) ?? []), p])
  }
  return [...by]
}

function PortTile({ port, wide, side }: { port: SwitchPort; wide?: boolean; side?: 'top' | 'bottom' }) {
  const tone = port.problem
    ? 'border-level-warn/70 bg-level-warn/15'
    : port.up
      ? 'border-brand/50 bg-brand/10'
      : port.peer?.nodeId
        ? 'border-dashed border-level-error/60 text-muted-foreground'
        : 'border-border bg-muted/30 text-muted-foreground/70'
  const peer = port.peer?.label
  return (
    <PortHover port={port} side={side}>
      <div
        data-testid="port-tile"
        data-up={port.up}
        className={cn(
          'flex h-12 flex-col items-center justify-center rounded-md border px-1 font-mono text-[10px] leading-tight transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          wide ? 'w-28' : 'w-12',
          tone,
        )}
      >
        <span className="text-[9px] text-muted-foreground">{port.label}</span>
        <span className="max-w-full truncate">{peer ?? (port.up ? 'link' : '')}</span>
        {port.up && <span className="text-muted-foreground">{formatLinkSpeed(port.speedMbps)}</span>}
      </div>
    </PortHover>
  )
}
