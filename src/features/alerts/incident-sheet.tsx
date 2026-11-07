import { Link } from '@tanstack/react-router'
import { useResolveIncident } from '@/api/hooks'
import type { Incident } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { formatDateTime, formatDuration } from '@/lib/format'

export function IncidentSheet({ incident, onClose }: { incident: Incident | null; onClose: () => void }) {
  const resolve = useResolveIncident()
  return (
    <Sheet open={incident !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[480px] sm:max-w-[480px]">
        {incident && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={incident.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                  {incident.severity}
                </Badge>
                <Badge variant="secondary">{incident.status}</Badge>
              </div>
              <SheetTitle>{incident.title}</SheetTitle>
              <SheetDescription>
                Started {formatDateTime(incident.startedAt)}
                {incident.resolvedAt ? ` · lasted ${formatDuration(incident.resolvedAt - incident.startedAt)}` : ''}
              </SheetDescription>
            </SheetHeader>
            <ol className="mx-4 flex flex-col" data-testid="incident-timeline">
              {incident.timeline.map((e, i) => {
                const last = i === incident.timeline.length - 1
                const live = last && incident.status === 'ongoing'
                return (
                  <li key={`${e.ts}-${e.text}`} className={cn('relative pl-7', !last && 'pb-5')}>
                    {/* the line runs from this dot to the next */}
                    {!last && <span className="absolute top-3 bottom-0 left-[5px] w-px bg-border" aria-hidden />}
                    <span className={cn('absolute top-1 left-0 grid size-[11px] place-items-center rounded-full', live ? 'bg-level-warn/20' : 'bg-brand/20')} aria-hidden>
                      <span className={cn('size-[5px] rounded-full', live ? 'bg-level-warn motion-safe:animate-pulse' : 'bg-brand')} />
                    </span>
                    <p className="text-sm leading-snug">{e.text}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">{formatDateTime(e.ts)}</p>
                  </li>
                )
              })}
            </ol>
            <SheetFooter className="flex-row gap-2">
              <Button variant="outline" asChild>
                <Link to="/logs" search={{ q: incident.nodeId ? `host:${incident.nodeId}` : 'source:gateway level:error', range: '24h' }}>
                  View related logs
                </Link>
              </Button>
              {incident.status === 'ongoing' && (
                <Button onClick={() => resolve.mutate(incident.id, { onSuccess: onClose })} disabled={resolve.isPending}>
                  Resolve
                </Button>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
