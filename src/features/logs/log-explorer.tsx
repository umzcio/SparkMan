import { useState } from 'react'
import { useLogs } from '@/api/hooks'
import type { LogLine, LogQueryInput as QueryInput, TimeRange } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { EmptyState, QueryState } from '@/components/query-state'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDateTime } from '@/lib/format'
import { LogDetailSheet } from './log-detail-sheet'
import { LogHistogram } from './log-histogram'
import { LogPatterns } from './log-patterns'
import { LogQueryInput } from './log-query-input'
import { LogTable } from './log-table'

export interface LogExplorerState {
  query: string
  range: TimeRange
  live: boolean
  view: 'list' | 'visualize'
  around?: number
}

export const LOG_RANGES: TimeRange[] = ['15m', '1h', '24h', '7d']

export function LogExplorer({ state, onChange, lockedQuery, compact = false }: { state: LogExplorerState; onChange: (patch: Partial<LogExplorerState>) => void; lockedQuery?: string; compact?: boolean }) {
  const input: QueryInput = { query: [lockedQuery, state.query].filter(Boolean).join(' '), range: state.range, around: state.around, limit: 200 }
  const logs = useLogs(input, state.live && state.around === undefined)
  const [selected, setSelected] = useState<LogLine | null>(null)
  const lines = logs.data?.lines ?? []
  const index = selected ? lines.findIndex((l) => l.id === selected.id) : -1

  const step = (dir: 1 | -1) => {
    const next = index === -1 ? undefined : lines[index + dir]
    if (next) setSelected(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <LogQueryInput value={state.query} prefix={lockedQuery} onSubmit={(query) => onChange({ query, around: undefined })} />
        <TimeRangeToggle value={state.range} ranges={LOG_RANGES} onChange={(range) => onChange({ range, around: undefined })} />
        <ToggleGroup type="single" variant="outline" size="sm" value={state.view} onValueChange={(v) => v && onChange({ view: v as LogExplorerState['view'] })} aria-label="View">
          <ToggleGroupItem value="list" className="px-3">List</ToggleGroupItem>
          <ToggleGroupItem value="visualize" className="px-3">Visualize</ToggleGroupItem>
        </ToggleGroup>
        <LiveBadge live={state.live && state.around === undefined} onToggle={() => onChange({ live: !state.live })} />
      </div>
      {state.around !== undefined && (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary" data-testid="around-badge">
            Lines around {formatDateTime(state.around)}
          </Badge>
          <Button size="sm" variant="ghost" onClick={() => onChange({ around: undefined })}>
            Clear
          </Button>
        </div>
      )}
      <QueryState query={logs} skeleton={<Skeleton className="h-72 w-full" />}>
        {(result) => (
          <>
            <LogHistogram result={result} range={state.range} around={state.around} compact={compact} />
            {result.lines.length === 0 ? (
              <EmptyState title="No log lines match" description="Widen the time range or remove a filter." />
            ) : state.view === 'list' ? (
              <LogTable lines={result.lines} selectedId={selected?.id ?? null} onSelect={setSelected} />
            ) : (
              <LogPatterns lines={result.lines} onPick={(pattern) => onChange({ query: `pattern:${pattern}`, view: 'list' })} />
            )}
            {result.truncated && <p className="text-xs text-muted-foreground">Search stopped after scanning the most recent ~28 hours of lines; narrow the range to go further back.</p>}
          </>
        )}
      </QueryState>
      <LogDetailSheet
        line={selected}
        index={index}
        total={lines.length}
        onClose={() => setSelected(null)}
        onStep={step}
        onLinesAround={(l) => {
          setSelected(null)
          onChange({ around: l.ts, query: `host:${l.host}` })
        }}
        onSamePattern={(l) => {
          setSelected(null)
          onChange({ query: `pattern:${l.pattern}`, around: undefined })
        }}
      />
    </div>
  )
}
