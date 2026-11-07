import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '@/features/agent/agent-page'
import { CLAUDE } from '@/features/agent/providers'

export const Route = createFileRoute('/agent')({
  validateSearch: (s: Record<string, unknown>): { session?: string } => ({
    session: typeof s.session === 'string' && s.session ? s.session : undefined,
  }),
  component: AgentRoute,
})

function AgentRoute() {
  const { session } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <AgentPage provider={CLAUDE} sessionId={session ?? null} onSelect={(id) => void navigate({ search: { session: id ?? undefined } })} />
}
