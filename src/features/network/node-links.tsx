import { Link } from '@tanstack/react-router'
import type { NetworkState, NodeLink } from '@/api/types'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { formatLinkSpeed } from './format'

/** Each node's own view of its links: its fleet port and every ConnectX-7 half, and where each lands. */
export function NodeLinks({ state }: { state: NetworkState }) {
  const switchName = new Map(state.switches.map((s) => [s.id, s.name]))
  // an up ConnectX-7 link no fabric switch has seen is a direct cable, once a fabric switch is being read at all
  const fabricRead = state.switches.some((s) => s.role === 'fabric' && s.reachable)
  const where = (l: NodeLink) => (l.switchId ? `${switchName.get(l.switchId) ?? l.switchId} ${l.portName ?? ''}` : l.up && l.role === 'fabric' && fabricRead ? 'direct cable' : '')
  return (
    <Card className="py-0">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Fleet LAN</TableHead>
            <TableHead>Fabric (ConnectX-7)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.nodes.map((n, i) => {
            const lan = n.links.filter((l) => l.role === 'fleet')
            const fabric = n.links.filter((l) => l.role === 'fabric')
            const up = fabric.filter((l) => l.up)
            return (
              <TableRow key={n.nodeId} data-testid="node-links-row" style={stagger(i)} className="enter-fade-up">
                <TableCell className="font-medium">
                  <Link to="/nodes/$nodeId" params={{ nodeId: n.nodeId }} className="hover:underline">{n.nodeId}</Link>
                </TableCell>
                <TableCell>
                  {lan.map((l) => <LinkLine key={l.iface} link={l} where={where(l)} />)}
                  {!lan.length && <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell>
                  {up.map((l) => <LinkLine key={l.iface} link={l} where={where(l)} />)}
                  {fabric.length > up.length && <span className="text-xs text-muted-foreground">{fabric.length - up.length} down</span>}
                  {!fabric.length && <span className="text-muted-foreground">—</span>}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Card>
  )
}

function LinkLine({ link, where }: { link: NodeLink; where: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 font-mono text-xs leading-5">
      <span className={cn('size-1.5 rounded-full', link.up ? 'bg-brand' : 'bg-level-error')} aria-hidden />
      <span>{link.iface}</span>
      <span className="text-muted-foreground">{link.up ? `${formatLinkSpeed(link.speedMbps)}${link.mtu ? ` · MTU ${link.mtu}` : ''}` : 'down'}</span>
      {where && <span className="text-muted-foreground">→ {where}</span>}
    </div>
  )
}
