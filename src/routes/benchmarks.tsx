import { createFileRoute } from '@tanstack/react-router'
import type { BenchKind } from '@/api/types'
import { BenchmarksPage } from '@/features/benchmarks/benchmarks-page'
import { BENCH_KINDS } from '@/lib/bench'

export const Route = createFileRoute('/benchmarks')({
  validateSearch: (s: Record<string, unknown>): { node?: string; kind?: BenchKind } => ({
    node: typeof s.node === 'string' && s.node ? s.node : undefined,
    kind: BENCH_KINDS.some((k) => k.id === s.kind) && s.kind !== 'decode' ? (s.kind as BenchKind) : undefined,
  }),
  component: BenchmarksRoute,
})

function BenchmarksRoute() {
  const { node, kind = 'decode' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <BenchmarksPage
      nodeId={node}
      kind={kind}
      onNode={(n) => void navigate({ replace: true, search: (p) => ({ ...p, node: n }) })}
      onKind={(k) => void navigate({ replace: true, search: (p) => ({ ...p, kind: k === 'decode' ? undefined : k }) })}
    />
  )
}
