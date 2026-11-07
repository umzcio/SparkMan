import { createFileRoute } from '@tanstack/react-router'
import { AgentPage } from '@/features/agent/agent-page'
import { CODEX } from '@/features/agent/providers'

export const Route = createFileRoute('/codex')({
  validateSearch: (s: Record<string, unknown>): { session?: string } => ({
    session: typeof s.session === 'string' && s.session ? s.session : undefined,
  }),
  component: CodexRoute,
})

function CodexRoute() {
  const { session } = Route.useSearch()
  const navigate = Route.useNavigate()
  return <AgentPage provider={CODEX} sessionId={session ?? null} onSelect={(id) => void navigate({ search: { session: id ?? undefined } })} />
}
