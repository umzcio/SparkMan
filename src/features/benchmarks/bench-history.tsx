import { History, Trash2 } from 'lucide-react'
import { useDeleteBenchRun } from '@/api/hooks'
import type { BenchRun } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'
import { stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { STATUS_CLASS } from './config'
import { configSummary, headline } from './summary'

const DOT: Record<BenchRun['status'], string> = { running: 'bg-level-info motion-safe:animate-pulse', completed: 'bg-brand', cancelled: 'bg-muted-foreground', failed: 'bg-level-error' }

export function BenchHistory({ runs, selectedId, onSelect }: { runs: BenchRun[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const del = useDeleteBenchRun()
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="border-b py-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="size-4 text-muted-foreground" />
          History
          <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">{runs.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {runs.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No runs for this model on this node yet.</p>
        ) : (
          <ul className="flex flex-col divide-y" aria-label="Past runs">
            {runs.map((run, i) => {
              const selected = run.id === selectedId
              const line = headline(run)
              return (
                <li key={run.id} className="enter-fade-up flex items-center gap-1 pr-2" style={stagger(i)} data-testid="bench-history-row" data-status={run.status}>
                  <button
                    type="button"
                    onClick={() => onSelect(run.id)}
                    aria-current={selected ? 'true' : undefined}
                    className={cn(
                      'flex min-w-0 flex-1 flex-col gap-0.5 border-l-2 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      selected ? 'border-brand bg-muted/40' : 'border-transparent',
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span className={cn('size-2 shrink-0 rounded-full', DOT[run.status])} aria-hidden />
                      <span className="tabular-nums">{formatDateTime(run.startedAt)}</span>
                      <span className={cn('ml-auto text-xs capitalize', STATUS_CLASS[run.status])}>{run.status}</span>
                    </span>
                    <span className="truncate pl-4 font-mono text-xs text-muted-foreground">
                      {line ?? '—'} · {configSummary(run)}
                    </span>
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete run from ${formatDateTime(run.startedAt)}`}
                    disabled={run.status === 'running' || del.isPending}
                    onClick={() => del.mutate(run.id)}
                    data-testid="bench-delete"
                  >
                    <Trash2 />
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
