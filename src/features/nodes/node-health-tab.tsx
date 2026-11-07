import { CircleCheck, CircleX, Stethoscope, TriangleAlert } from 'lucide-react'
import { useNodeHealth, useRunDiagnostics } from '@/api/hooks'
import type { HealthCheck } from '@/api/types'
import { QueryState } from '@/components/query-state'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const ICON: Record<HealthCheck['status'], { icon: typeof CircleCheck; className: string }> = {
  pass: { icon: CircleCheck, className: 'text-brand' },
  warn: { icon: TriangleAlert, className: 'text-level-warn' },
  fail: { icon: CircleX, className: 'text-level-error' },
}

export function NodeHealthTab({ nodeId }: { nodeId: string }) {
  const health = useNodeHealth(nodeId)
  const run = useRunDiagnostics()
  return (
    <QueryState query={health}>
      {(h) => (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">L1 health summary</CardTitle>
            <CardDescription className="font-mono text-xs">
              {h.envelope.tool} · status={h.envelope.status} · {h.envelope.duration_ms} ms
            </CardDescription>
            <CardAction>
              <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate(nodeId)}>
                <Stethoscope />
                Run diagnostics
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {h.checks.map((c) => {
                const { icon: Icon, className } = ICON[c.status]
                return (
                  <li key={c.name} className="flex items-center gap-3 py-2.5">
                    <Icon className={`size-4 shrink-0 ${className}`} aria-label={c.status} />
                    <span className="w-56 shrink-0 text-sm">{c.name}</span>
                    <span className="min-w-0 truncate font-mono text-sm text-muted-foreground">{c.detail}</span>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </QueryState>
  )
}
