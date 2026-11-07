import { createFileRoute } from '@tanstack/react-router'
import type { TimeRange } from '@/api/types'
import { NODE_TABS, NodeDetailPage, type NodeTab } from '@/features/nodes/node-detail-page'

const RANGES: TimeRange[] = ['1h', '6h', '24h', '7d']

export const Route = createFileRoute('/nodes/$nodeId')({
  validateSearch: (s: Record<string, unknown>): { tab?: NodeTab; range?: TimeRange } => ({
    tab: NODE_TABS.includes(s.tab as NodeTab) && s.tab !== 'metrics' ? (s.tab as NodeTab) : undefined,
    range: RANGES.includes(s.range as TimeRange) && s.range !== '1h' ? (s.range as TimeRange) : undefined,
  }),
  component: NodeRoute,
})

function NodeRoute() {
  const { nodeId } = Route.useParams()
  const { tab = 'metrics', range = '1h' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <NodeDetailPage
      key={nodeId}
      nodeId={nodeId}
      tab={tab}
      range={range}
      onTab={(t) => void navigate({ replace: true, search: (p) => ({ ...p, tab: t === 'metrics' ? undefined : t }) })}
      onRange={(r) => void navigate({ replace: true, search: (p) => ({ ...p, range: r === '1h' ? undefined : r }) })}
    />
  )
}
