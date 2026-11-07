import { Activity, Gauge, Plug, Timer, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useGatewayInfo, useGatewaySeries, useRoutes } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { CopyButton } from '@/components/copy-button'
import { LiveBadge } from '@/components/live-badge'
import { MetricChart } from '@/components/metric-chart'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatCompact, formatDuration, formatPercent } from '@/lib/format'
import { useLocalSetting } from '@/lib/use-local-setting'
import { buildSnippets } from './snippets'
import { Ticker } from '@/components/ticker'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useGatewayStatus } from '@/features/status/page-status'

export function GatewayPage() {
  const status = useGatewayStatus()
  const [range, setRange] = useState<TimeRange>('1h')
  const info = useGatewayInfo()
  const series = useGatewaySeries(range)
  const routes = useRoutes()
  // Settings → Gateway → Default model (falls back to the server default below)
  const [storedModel] = useLocalSetting<string>('sparkman.defaultModel', '')
  const last = series.data?.at(-1)

  return (
    <>
      <PageHeader fleetData="gateway"
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Endpoint' }]}
        title="Endpoint"
        description={<StatusLine items={status} />}
        actions={
          <>
            <LiveBadge live />
            <TimeRangeToggle value={range} onChange={setRange} ranges={['15m', '1h', '24h', '7d']} />
          </>
        }
      />
      <PageBody>
        <QueryState query={info} skeleton={<Skeleton className="h-28 w-full" />}>
          {(gw) => {
            const served = gw.models.length > 0
            const primary = gw.models.includes(storedModel) ? storedModel : gw.defaultModel
            const coder = gw.models.includes('qwen3-coder-30b-a3b') ? 'qwen3-coder-30b-a3b' : (gw.models[0] ?? gw.defaultModel)
            const snippets = buildSnippets(gw.baseUrl, { primary, coder })
            return (
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <Plug className="size-4 text-brand" />
                      Base URL
                    </CardTitle>
                    <CardDescription>Point agents here and authenticate with a key from API Keys.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-4">
                    <div className="flex items-center gap-2 rounded-lg border bg-surface-2 px-3 py-2">
                      <code className="flex-1 truncate font-mono text-sm" data-testid="base-url">
                        {gw.baseUrl}
                      </code>
                      <CopyButton value={gw.baseUrl} label="Copy" toastText="Base URL copied" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="font-mono">POST /v1/chat/completions</Badge>
                      <Badge variant="outline" className="font-mono">POST /v1/messages</Badge>
                      <Badge variant="outline" className="font-mono">GET /v1/models</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Serving <span className="font-mono text-foreground">{gw.models.length}</span> models. Default: <span className="font-mono text-foreground">{primary}</span>
                    </p>
                  </CardContent>
                </Card>
                <Card className="gap-3">
                  <CardHeader>
                    <CardTitle className="text-sm">Connect a coding agent</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {!served ? (
                      <p className="text-sm text-muted-foreground" data-testid="snippets-empty">
                        No models are being served yet. Deploy a model to get connection snippets.
                      </p>
                    ) : (
                      <Tabs defaultValue="claude-code">
                        <TabsList className="h-auto flex-wrap">
                          {snippets.map((s) => (
                            <TabsTrigger key={s.tool} value={s.tool}>
                              {s.label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                        {snippets.map((s) => (
                          <TabsContent key={s.tool} value={s.tool} className="mt-3 flex flex-col gap-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs text-muted-foreground">{s.file}</span>
                              <CopyButton value={s.code} label="Copy snippet" toastText="Snippet copied" />
                            </div>
                            <pre className="overflow-x-auto rounded-lg border bg-surface-2 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap md:break-normal md:whitespace-pre">{s.code}</pre>
                            {s.note && <p className="text-xs [overflow-wrap:anywhere] text-muted-foreground">{s.note}</p>}
                          </TabsContent>
                        ))}
                      </Tabs>
                    )}
                  </CardContent>
                </Card>
              </div>
            )
          }}
        </QueryState>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatTile label="Requests / s" value={<Ticker value={last?.rps ?? null} format={(v) => (v == null ? '—' : v.toFixed(1))} />} icon={Activity} hint={last ? `${formatCompact(last.tokensPerSec)} tok/s` : undefined} />
          <StatTile label="Latency p50 / p95" value={<Ticker value={last?.p50Ms ?? null} format={(v) => (v == null ? '—' : formatDuration(v))} />} icon={Timer} hint={last ? `p95 ${formatDuration(last.p95Ms)}` : undefined} />
          <StatTile label="Time to first token" value={<Ticker value={last?.ttftMs ?? null} format={(v) => (v == null ? '—' : formatDuration(v))} />} icon={Gauge} hint="p50" />
          <StatTile testId="tile-errors" label="Error rate" value={<Ticker value={last ? last.errorRate * 100 : null} format={(v) => formatPercent(v, 1)} />} icon={TriangleAlert} tone={last && last.errorRate > 0.02 ? 'error' : 'default'} hint="5xx responses" />
        </div>

        <QueryState query={series} skeleton={<Skeleton className="h-56 w-full" />}>
          {(points) => (
            <div className="grid gap-4 lg:grid-cols-3">
              <MetricChart
                title="Throughput"
                icon={Activity}
                data={points.map((p) => ({ t: p.t, rps: p.rps }))}
                range={range}
                format={(v) => v.toFixed(1)}
                series={[{ key: 'rps', label: 'req/s', color: 'var(--gpu)' }]}
              />
              <MetricChart
                title="Latency"
                icon={Timer}
                data={points.map((p) => ({ t: p.t, ttft: p.ttftMs, p50: p.p50Ms, p95: p.p95Ms }))}
                range={range}
                format={(v) => formatDuration(v)}
                series={[
                  { key: 'ttft', label: 'TTFT', color: 'var(--cpu)' },
                  { key: 'p50', label: 'p50', color: 'var(--level-info)' },
                  { key: 'p95', label: 'p95', color: 'var(--memory)' },
                ]}
              />
              <MetricChart
                title="Errors"
                icon={TriangleAlert}
                data={points.map((p) => ({ t: p.t, err: p.errorRate * 100 }))}
                range={range}
                format={(v) => formatPercent(v, 1)}
                series={[{ key: 'err', label: '5xx %', color: 'var(--level-error)' }]}
              />
            </div>
          )}
        </QueryState>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Routing table</CardTitle>
            <CardDescription>Least-loaded routing across replicas; unhealthy replicas are skipped.</CardDescription>
          </CardHeader>
          <QueryState
            query={routes}
            isEmpty={(list) => list.length === 0}
            empty={
              <div className="p-4">
                <EmptyState title="No routes" description="Deploy a model to give the gateway something to route to." />
              </div>
            }
          >
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Engine</TableHead>
                    <TableHead>Replicas</TableHead>
                    <TableHead>Nodes</TableHead>
                    <TableHead>Health</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((r, i) => (
                    <TableRow key={r.deploymentId} data-testid="route-row" className="enter-fade-up" style={stagger(i)}>
                      <TableCell className="font-mono">{r.model}</TableCell>
                      <TableCell>{r.engine}</TableCell>
                      <TableCell className="font-mono tabular-nums">{r.replicas}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.nodeIds.join(', ')}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={r.healthy ? 'text-brand' : 'text-level-warn'}>
                          {r.healthy ? 'healthy' : 'degraded'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>
      </PageBody>
    </>
  )
}
