import { Link } from '@tanstack/react-router'
import { Activity, ArrowRight, Boxes, CircleSlash, Gauge, KeyRound, LayoutGrid, MemoryStick, PackageCheck, RotateCw, Server, Stethoscope, Timer, TriangleAlert, Wrench, Zap, type LucideIcon } from 'lucide-react'
import { useActivity, useDeployments, useFleetSummary, useIncidents, useNodes } from '@/api/hooks'
import type { ActivityKind, Deployment, FleetNode } from '@/api/types'
import { LiveBadge } from '@/components/live-badge'
import { NodeStatusDot } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UsageBar } from '@/components/usage-bar'
import { formatCompact, formatGB, formatPercent, formatRelative, formatTemp, formatWatts } from '@/lib/format'
import { Faceplate } from '@/components/faceplate'
import { Ticker } from '@/components/ticker'
import { stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useState } from 'react'
import { RackView } from './rack-view'
import { StatusLine } from '@/components/status-line'
import { useOverviewStatus } from '@/features/status/page-status'

type FleetView = 'rack' | 'grid'

/** Rack or grid, remembered per browser and separately for phones, which default to grid. */
function useFleetView(): [FleetView, (v: FleetView) => void] {
  const phone = typeof window !== 'undefined' && window.innerWidth < 768
  const key = phone ? 'sparkman.fleetView.phone' : 'sparkman.fleetView'
  const fallback: FleetView = phone ? 'grid' : 'rack'
  const [view, setView] = useState<FleetView>(() => {
    try {
      const v = localStorage.getItem(key)
      return v === 'grid' || v === 'rack' ? v : fallback
    } catch {
      return fallback
    }
  })
  return [
    view,
    (v) => {
      setView(v)
      try {
        localStorage.setItem(key, v)
      } catch {
        // storage unavailable: the choice just isn't remembered
      }
    },
  ]
}

const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  reboot: RotateCw, deploy: Boxes, update: PackageCheck, alert: TriangleAlert, key: KeyRound, drain: CircleSlash, maintenance: Wrench, diag: Stethoscope, bench: Timer, system: Activity,
}

function NodeCard({ node, deployment, index }: { node: FleetNode; deployment?: Deployment; index: number }) {
  const reachable = node.live !== null
  return (
    <Link
      to="/nodes/$nodeId"
      params={{ nodeId: node.id }}
      data-testid="node-card"
      style={stagger(index)}
      className="group enter-fade-up flex gap-4 rounded-xl border bg-card p-4 transition-[border-color,transform] duration-200 hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-ring active:scale-[0.99]"
    >
      {/* the box itself, standing like it does on the shelf */}
      <span title={node.model} aria-label={node.model} role="img" className="flex shrink-0 items-center">
        <Faceplate
          model={node.model}
          className={cn('h-[5.5rem] w-auto shadow-md shadow-black/30 transition-transform duration-200 ease-(--ease-out-strong) group-hover:-translate-y-0.5', !reachable && 'opacity-50 grayscale')}
        />
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-mono text-sm font-medium">
          <NodeStatusDot status={node.status} />
          <span className="truncate">{node.id}</span>
        </span>
        <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {deployment ? `${deployment.model} · ${deployment.engine}` : node.live ? 'idle' : 'unreachable'}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <UsageBar label="GPU" value={node.live?.gpuUtil ?? null} />
          <UsageBar label="Mem" value={node.live ? (node.live.memUsedGB / node.memoryGB) * 100 : null} />
          <UsageBar label="Temp" value={node.live?.gpuTempC ?? null} format={formatTemp} />
        </div>
      </div>
    </Link>
  )
}

export function OverviewPage() {
  const status = useOverviewStatus()
  const summary = useFleetSummary()
  const nodes = useNodes()
  const deployments = useDeployments()
  const incidents = useIncidents()
  const activity = useActivity(8)
  const now = Date.now()
  const [view, setView] = useFleetView()

  return (
    <>
      <PageHeader fleetData="nodes"
        crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Overview' }]}
        title="Overview"
        description={<StatusLine items={status} />}
        actions={<LiveBadge live />}
      />
      <PageBody>
        <QueryState
          query={summary}
          skeleton={
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          }
        >
          {(s) => (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <StatTile
                className="enter-fade-up"
                style={stagger(0)}
                testId="tile-online"
                label="Nodes online"
                value={`${s.online} / ${s.total}`}
                icon={Server}
                tone={s.online < s.total ? 'warn' : 'brand'}
                hint={s.activeIncidents ? `${s.activeIncidents} active incident${s.activeIncidents > 1 ? 's' : ''}` : 'All healthy'}
              />
              <StatTile className="enter-fade-up" style={stagger(1)} label="GPU utilization" value={<Ticker value={s.gpuUtilAvg} format={(v) => formatPercent(v)} />} icon={Gauge} hint="fleet average" />
              <StatTile className="enter-fade-up" style={stagger(2)} label="Unified memory" value={<Ticker value={s.memUsedGB} format={formatGB} />} icon={MemoryStick} hint={`of ${formatGB(s.memTotalGB)}`} />
              <StatTile className="enter-fade-up" style={stagger(3)} label="GPU power" value={<Ticker value={s.powerW} format={formatWatts} />} icon={Zap} hint="GPU-only draw" />
              <StatTile className="enter-fade-up" style={stagger(4)} label="Gateway" value={<Ticker value={s.tokensPerSec} format={(v) => (v == null ? '—' : `${formatCompact(v)} tok/s`)} />} icon={Activity} hint="all deployments" />
            </div>
          )}
        </QueryState>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section aria-labelledby="fleet-heading">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 id="fleet-heading" className="text-sm font-medium text-muted-foreground">
                Fleet health
              </h2>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={view}
                onValueChange={(v) => v && setView(v as FleetView)}
                aria-label="Fleet layout"
                className="ml-auto"
              >
                <ToggleGroupItem value="rack" aria-label="Rack view">
                  <Server />
                  Rack
                </ToggleGroupItem>
                <ToggleGroupItem value="grid" aria-label="Grid view">
                  <LayoutGrid />
                  Grid
                </ToggleGroupItem>
              </ToggleGroup>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/nodes">
                  All nodes <ArrowRight />
                </Link>
              </Button>
            </div>
            <QueryState query={nodes} skeleton={<Skeleton className="h-80 w-full" />}>
              {(list) =>
                view === 'rack' ? (
                  <RackView nodes={list} deployments={deployments.data ?? []} now={now} />
                ) : (
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-4">
                  {list.map((n, i) => (
                    <NodeCard key={n.id} index={i} node={n} deployment={deployments.data?.find((d) => d.id === n.deploymentId)} />
                  ))}
                </div>
                )
              }
            </QueryState>
          </section>

          <div className="flex flex-col gap-6">
            <Card className="gap-3">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium">Active alerts</CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/alerts">View</Link>
                </Button>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <QueryState query={incidents} skeleton={<Skeleton className="h-24 w-full" />}>
                  {(list) => {
                    const ongoing = list.filter((i) => i.status === 'ongoing')
                    if (ongoing.length === 0) return <EmptyState title="No active incidents" />
                    return ongoing.map((i) => (
                      <Link key={i.id} to="/alerts" className="rounded-lg border border-level-warn/30 bg-level-warn/10 px-3 py-2 hover:border-level-warn/60">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{i.title}</span>
                          <Badge variant="outline" className={i.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                            {i.severity}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">Started {formatRelative(i.startedAt, now)}</div>
                      </Link>
                    ))
                  }}
                </QueryState>
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-sm font-medium">Recent activity</CardTitle>
              </CardHeader>
              <CardContent>
                <QueryState query={activity} skeleton={<Skeleton className="h-48 w-full" />}>
                  {(events) => (
                    <ol className="flex flex-col gap-3">
                      {events.map((e, idx) => {
                        const Icon = ACTIVITY_ICON[e.kind]
                        return (
                          <li key={e.id} className="enter-fade-up flex gap-3" style={stagger(idx)} data-testid="activity-item">
                            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border bg-surface-2">
                              <Icon className="size-3.5 text-muted-foreground" />
                            </span>
                            <div className="min-w-0">
                              <p className="text-sm leading-snug">{e.text}</p>
                              <p className="text-xs text-muted-foreground">{formatRelative(e.ts, now)}</p>
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </QueryState>
              </CardContent>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}
