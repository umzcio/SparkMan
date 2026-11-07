import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import type { TimeRange } from '@/api/types'
import { LOG_RANGES, type LogExplorerState } from '@/features/logs/log-explorer'
import { LogsPage } from '@/features/logs/logs-page'

interface LogsSearch {
  q?: string
  range?: TimeRange
  live?: false
  view?: 'visualize'
}

export const Route = createFileRoute('/logs')({
  validateSearch: (s: Record<string, unknown>): LogsSearch => ({
    q: typeof s.q === 'string' && s.q ? s.q : undefined,
    range: LOG_RANGES.includes(s.range as TimeRange) ? (s.range as TimeRange) : undefined,
    live: s.live === false || s.live === 'false' ? false : undefined,
    view: s.view === 'visualize' ? 'visualize' : undefined,
  }),
  component: LogsRoute,
})

function LogsRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [around, setAround] = useState<number | undefined>()
  const state: LogExplorerState = { query: search.q ?? '', range: search.range ?? '1h', live: search.live ?? true, view: search.view ?? 'list', around }

  const onChange = (patch: Partial<LogExplorerState>) => {
    if ('around' in patch) setAround(patch.around)
    void navigate({
      replace: true,
      search: (prev) => ({
        ...prev,
        ...('query' in patch ? { q: patch.query || undefined } : {}),
        ...('range' in patch ? { range: patch.range === '1h' ? undefined : patch.range } : {}),
        ...('live' in patch ? { live: patch.live ? undefined : (false as const) } : {}),
        ...('view' in patch ? { view: patch.view === 'visualize' ? ('visualize' as const) : undefined } : {}),
      }),
    })
  }

  return <LogsPage state={state} onChange={onChange} />
}
