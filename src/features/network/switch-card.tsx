import type { NetworkSwitch, SwitchHealthReading } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { roleLabel } from './format'
import { SwitchFaceplate } from './switch-faceplate'

const DOT = { ok: 'bg-brand', warn: 'bg-level-warn', bad: 'bg-level-error' } as const

export function SwitchCard({ sw, now }: { sw: NetworkSwitch; now: number }) {
  const up = sw.ports.filter((p) => p.up).length
  const problems = sw.ports.filter((p) => p.problem).length
  const waiting = !sw.everReached && !sw.reachable
  return (
    <Card className="gap-3 py-4" data-testid={`switch-${sw.id}`}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 px-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {sw.name}
            <Badge variant="outline">{roleLabel[sw.role]}</Badge>
            <span className="font-normal text-muted-foreground">{[sw.model, sw.firmware].filter(Boolean).join(' · ')}</span>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {sw.host} · {sw.kind === 'snmp' ? 'SNMPv3' : 'RouterOS REST'}
            {sw.serial && ` · S/N ${sw.serial}`}
            {sw.uptimeS != null && ` · up ${formatDuration(sw.uptimeS * 1000)}`}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs" data-testid="switch-state">
          <span className={cn('size-1.5 rounded-full', sw.reachable ? 'bg-brand' : waiting ? 'bg-muted-foreground/60' : 'bg-level-error motion-safe:animate-pulse')} aria-hidden />
          {sw.reachable ? `${up} up${problems ? ` · ${problems} slow` : ''}` : waiting ? 'Waiting for first contact' : 'Not answering'}
          {sw.lastPollAt && <span className="text-muted-foreground">· {formatRelative(sw.lastPollAt, now)}</span>}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {waiting ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            Not reached yet. SparkMan polls {sw.host} every 15 s and starts watching it, alerts included, on its first answer.
          </p>
        ) : (
          !sw.reachable && sw.error && <p className="rounded-md bg-level-error/10 px-3 py-2 font-mono text-xs text-level-error">{sw.error}</p>
        )}
        {sw.health.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Switch health">
            {sw.health.map((h) => <Health key={h.label} h={h} />)}
          </ul>
        )}
        {sw.ports.length || sw.model ? <SwitchFaceplate sw={sw} /> : <p className="text-sm text-muted-foreground">No ports read yet.</p>}
      </CardContent>
    </Card>
  )
}

function Health({ h }: { h: SwitchHealthReading }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 rounded-full', DOT[h.status])} aria-hidden />
      <span className="text-muted-foreground">{h.label}</span>
      <span className="font-mono tabular-nums">{h.value != null ? `${h.value}${h.unit === '%' || h.unit === '°C' ? '' : ' '}${h.unit}` : h.state}</span>
    </li>
  )
}
