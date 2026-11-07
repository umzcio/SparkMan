import { createFileRoute } from '@tanstack/react-router'
import { NodesPage, STATUS_FILTERS, type StatusFilter } from '@/features/nodes/nodes-page'

export const Route = createFileRoute('/nodes/')({
  validateSearch: (s: Record<string, unknown>): { status?: StatusFilter } => ({
    status: STATUS_FILTERS.includes(s.status as StatusFilter) && s.status !== 'all' ? (s.status as StatusFilter) : undefined,
  }),
  component: NodesRoute,
})

function NodesRoute() {
  const { status = 'all' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <NodesPage status={status} onStatusChange={(s) => void navigate({ search: { status: s === 'all' ? undefined : s } })} />
}
