import { useState } from 'react'
import { useCooling, useCoolingSeries, useNodes } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { StatusLine } from '@/components/status-line'
import { Skeleton } from '@/components/ui/skeleton'
import { useCoolingStatus } from '@/features/status/page-status'
import { ControllerCard } from './controller-card'
import { CurveEditor } from './curve-editor'
import { CoolingHistory } from './cooling-history'
import { FanCard, FanSparkline } from './fan-card'
import { ShelfHero } from './shelf-hero'
import { ZonesDialog } from './zones-dialog'

export function CoolingPage() {
  const status = useCoolingStatus()
  const cooling = useCooling()
  const nodes = useNodes()
  const series = useCoolingSeries('15m')
  const [zonesOpen, setZonesOpen] = useState(false)
  const now = Date.now()
  return (
    <>
      <PageHeader fleetData="cooling" crumbs={[{ label: 'Fleet', to: '/' }, { label: 'Cooling' }]} title="Cooling" description={<StatusLine items={status} />} />
      <PageBody>
        <QueryState query={cooling} skeleton={<Skeleton className="h-64 w-full" />}>
          {(c) => (
            <>
              {nodes.data ? <ShelfHero cooling={c} nodes={nodes.data} /> : <Skeleton className="h-64 w-full" />}
              <div className="grid gap-4 md:grid-cols-3">
                {c.fans.map((f) => (
                  <FanCard key={f.id} fan={f} maxRpm={c.maxRpm} disabled={!c.controller.connected}>
                    <FanSparkline points={series.data?.map((p) => ({ t: p.t, d: p.duty[f.id] })) ?? []} />
                  </FanCard>
                ))}
              </div>
              <div className="grid items-start gap-4 lg:grid-cols-[2fr_1fr]">
                {nodes.data && <CurveEditor policy={c.policy} nodes={nodes.data} />}
                <ControllerCard controller={c.controller} now={now} onEditZones={() => setZonesOpen(true)} />
              </div>
              <CoolingHistory fans={c.fans} />
              {nodes.data && <ZonesDialog open={zonesOpen} onOpenChange={setZonesOpen} fans={c.fans} nodes={nodes.data} />}
            </>
          )}
        </QueryState>
      </PageBody>
    </>
  )
}
