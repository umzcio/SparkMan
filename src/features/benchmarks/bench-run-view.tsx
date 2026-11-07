import { CircleAlert, Loader, Square } from 'lucide-react'
import { useCancelBench } from '@/api/hooks'
import type { BenchRun, BenchStatus } from '@/api/types'
import { CopyButton } from '@/components/copy-button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { BENCH_KIND_LABEL } from '@/lib/bench'
import { formatDateTime, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DecodeResults, PrefillResults, QualityResults, ToolEvalResults } from './bench-results'
import { STATUS_CLASS } from './config'
import { QualityCompare } from './quality-compare'
import { benchSummaryText, configSummary } from './summary'

export function BenchStatusBadge({ status }: { status: BenchStatus }) {
  return (
    <Badge variant="outline" className={cn('gap-1 capitalize', STATUS_CLASS[status])} data-testid="bench-status">
      {status === 'running' && <Loader className="size-3 motion-safe:animate-spin" />}
      {status}
    </Badge>
  )
}

function RunHeader({ run }: { run: BenchRun }) {
  const cancel = useCancelBench()
  const running = run.status === 'running'
  const pct = Math.round(run.progress * 100)
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {BENCH_KIND_LABEL[run.kind]} · <span className="font-mono">{run.model}</span>
          <BenchStatusBadge status={run.status} />
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          {run.scope === 'gateway' ? `gateway → ${run.nodeIds.length} nodes` : run.nodeIds.length > 1 ? `${run.nodeId} (group: ${run.nodeIds.join(' + ')})` : run.nodeId} · {run.engine} · {run.quant} · {configSummary(run)} · {formatDateTime(run.startedAt)}
          {run.finishedAt !== null && ` · ${formatDuration(run.finishedAt - run.startedAt)}`}
        </CardDescription>
        <CardAction className="flex gap-2">
          {running && (
            <Button size="sm" variant="outline" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending} data-testid="bench-cancel">
              <Square />
              Cancel
            </Button>
          )}
          <CopyButton value={benchSummaryText(run)} label="Copy results" toastText="Results copied" />
        </CardAction>
      </CardHeader>
      {running && (
        <div className="flex flex-col gap-2 px-6" data-testid="bench-progress">
          <Progress value={pct} aria-label="Bench progress" className="h-1.5 [&>[data-slot=progress-indicator]]:bg-brand [&>[data-slot=progress-indicator]]:duration-300 [&>[data-slot=progress-indicator]]:ease-out" />
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground" aria-live="polite">
            <span>{run.stage ?? 'Finishing…'}</span>
            <span className="font-mono tabular-nums">{pct}%</span>
          </div>
        </div>
      )}
    </Card>
  )
}

export function BenchRunView({ run }: { run: BenchRun }) {
  const r = run.result
  return (
    <div className="flex flex-col gap-4" data-testid="bench-run" data-run-id={run.id} data-status={run.status}>
      <RunHeader run={run} />
      {run.status === 'failed' && (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{run.error ?? 'Unknown error'}. Results up to that point are kept.</AlertDescription>
        </Alert>
      )}
      {run.status === 'cancelled' && <p className="text-sm text-muted-foreground">Cancelled. Steps that finished before the cancel are kept.</p>}
      {r.kind === 'decode' && <DecodeResults result={r} />}
      {r.kind === 'prefill' && <PrefillResults result={r} contextLength={run.contextLength} />}
      {r.kind === 'quality' && <QualityResults result={r} />}
      {r.kind === 'tool-eval' && <ToolEvalResults result={r} />}
      {r.kind === 'quality' && run.status !== 'running' && r.categories.length > 0 && <QualityCompare key={run.id} run={run} />}
    </div>
  )
}
