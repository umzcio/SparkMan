import { useNetwork } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { StatusLine } from '@/components/status-line'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useNetworkStatus } from '@/features/status/page-status'
import { NodeLinks } from './node-links'
import { SwitchCard } from './switch-card'

export function NetworkPage() {
  const status = useNetworkStatus()
  const network = useNetwork()
  const now = Date.now()
  return (
    <>
      <PageHeader fleetData="network" crumbs={[{ label: 'Fleet', to: '/' }, { label: 'Network' }]} title="Network" description={<StatusLine items={status} />} />
      <PageBody>
        <QueryState query={network} skeleton={<Skeleton className="h-64 w-full" />}>
          {(n) => (
            <>
              {n.switches.length === 0 && (
                <Card>
                  <CardContent className="text-sm text-muted-foreground">
                    No switches configured. Add a <code className="font-mono">switches</code> list to the site config (see deploy/fleet.example.json).
                  </CardContent>
                </Card>
              )}
              {n.switches.map((s) => (
                <SwitchCard key={s.id} sw={s} now={now} />
              ))}
              {n.nodes.length > 0 && <NodeLinks state={n} />}
            </>
          )}
        </QueryState>
      </PageBody>
    </>
  )
}
