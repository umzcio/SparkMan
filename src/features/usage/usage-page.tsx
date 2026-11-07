import { ArrowDownToLine, ArrowUpFromLine, DollarSign, Send } from 'lucide-react'
import { useState } from 'react'
import { useUsage } from '@/api/hooks'
import type { TimeRange } from '@/api/types'
import { MetricChart } from '@/components/metric-chart'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState, QueryState } from '@/components/query-state'
import { StatTile } from '@/components/stat-tile'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatCompact, formatNumber, formatUsd } from '@/lib/format'
import { TokenMix } from './token-mix'
import { toUsageChart } from './to-chart'
import { Ticker } from '@/components/ticker'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useUsageStatus } from '@/features/status/page-status'

export function UsagePage() {
  const status = useUsageStatus()
  const [range, setRange] = useState<TimeRange>('24h')
  const [groupBy, setGroupBy] = useState<'model' | 'key'>('model')
  const usage = useUsage(range)

  return (
    <>
      <PageHeader fleetData="usage"
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Usage' }]}
        title="Usage"
        description={<StatusLine items={status} />}
        actions={
          <>
            <ToggleGroup type="single" variant="outline" size="sm" value={groupBy} onValueChange={(v) => v && setGroupBy(v as 'model' | 'key')} aria-label="Group by">
              <ToggleGroupItem value="model" className="px-3">By model</ToggleGroupItem>
              <ToggleGroupItem value="key" className="px-3">By key</ToggleGroupItem>
            </ToggleGroup>
            <TimeRangeToggle value={range} onChange={setRange} ranges={['1h', '24h', '7d']} />
          </>
        }
      />
      <PageBody>
        <QueryState query={usage} skeleton={<Skeleton className="h-96 w-full" />}>
          {(r) => {
            const chart = toUsageChart(r, groupBy)
            const totalTokens = r.tokensIn + r.tokensOut
            return (
              <>
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                  <StatTile className="enter-fade-up" style={stagger(0)} label="Tokens in" value={<Ticker value={r.tokensIn} format={(v) => (v == null ? '—' : formatCompact(v))} />} icon={ArrowDownToLine} hint={`prompt tokens · ${r.tokensIn ? Math.round((r.tokensCached / r.tokensIn) * 100) : 0}% from cache`} />
                  <StatTile className="enter-fade-up" style={stagger(1)} testId="tile-tokens-out" label="Tokens out" value={<Ticker value={r.tokensOut} format={(v) => (v == null ? '—' : formatCompact(v))} />} icon={ArrowUpFromLine} hint="completion tokens" />
                  <StatTile className="enter-fade-up" style={stagger(2)} label="Requests" value={<Ticker value={r.requests} format={(v) => (v == null ? '—' : formatCompact(v))} />} icon={Send} />
                  <StatTile className="enter-fade-up" style={stagger(3)} testId="tile-cost" label="Cloud equivalent" value={<Ticker value={r.cloudCostUsd} format={(v) => (v == null ? '—' : formatUsd(v))} />} icon={DollarSign} tone="brand" hint="at an assumed $3 / $0.30 / $15 per 1M prefill / cached / out tokens" />
                </div>
                <MetricChart title="Tokens" data={chart.data} series={chart.series} range={range} stacked height={260} format={(v) => formatCompact(v)} emptyText="No usage in this range" />
                <TokenMix report={r} />
                <Card className="gap-0 py-0">
                  <CardHeader className="border-b py-4">
                    <CardTitle className="text-sm">Top API keys</CardTitle>
                  </CardHeader>
                  {r.topKeys.length === 0 ? (
                    <div className="p-4">
                      <EmptyState title="No active API keys" description="Create a key under API Keys to attribute gateway traffic." />
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Key</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="w-48">Share</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {r.topKeys.map((k, i) => (
                          <TableRow key={k.keyId} data-testid="top-key-row" className="enter-fade-up" style={stagger(i)}>
                            <TableCell className="font-mono">{k.name}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{formatCompact(k.tokens)}</TableCell>
                            <TableCell className="text-right font-mono tabular-nums">{formatNumber(k.requests)}</TableCell>
                            <TableCell>
                              <Progress value={totalTokens ? (k.tokens / totalTokens) * 100 : 0} aria-label={`${k.name} share`} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </Card>
              </>
            )
          }}
        </QueryState>
      </PageBody>
    </>
  )
}
