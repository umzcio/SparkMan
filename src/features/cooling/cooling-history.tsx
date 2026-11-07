import { useState } from 'react'
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { useCoolingSeries } from '@/api/hooks'
import type { CoolingPoint, Fan, TimeRange } from '@/api/types'
import { TimeRangeToggle } from '@/components/time-range-toggle'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatTimeTick } from '@/lib/format'
import { FAN_COLORS } from './fan-colors'


export function CoolingHistory({ fans }: { fans: Fan[] }) {
  const [range, setRange] = useState<TimeRange>('15m')
  const series = useCoolingSeries(range)
  const config: ChartConfig = Object.fromEntries([
    ...fans.map((f, i) => [`duty_${f.id}`, { label: f.name, color: FAN_COLORS[i % FAN_COLORS.length] }]),
    ['hottest', { label: 'Hottest box', color: 'var(--level-warn)' }],
  ])
  const hottest = (p: CoolingPoint) => {
    const temps = fans.flatMap((f) => (p.zoneTempC[f.id] == null ? [] : [p.zoneTempC[f.id]!]))
    return temps.length ? Math.max(...temps) : null
  }
  const data = (series.data ?? []).map((p) => ({
    t: p.t,
    ...Object.fromEntries(fans.map((f) => [`duty_${f.id}`, p.duty[f.id] ?? null])),
    hottest: hottest(p),
  }))
  return (
    <Card className="gap-3 py-4" data-testid="cooling-history">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-sm font-medium">Fan speed and hottest box</CardTitle>
        <TimeRangeToggle value={range} onChange={setRange} ranges={['15m', '1h']} />
      </CardHeader>
      <CardContent className="px-2">
        {series.data ? (
          <ChartContainer config={config} className="aspect-auto h-56 w-full">
            <LineChart data={data} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => formatTimeTick(t, range)} tickLine={false} axisLine={false} minTickGap={40} fontSize={11} />
              <YAxis yAxisId="duty" domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={40} fontSize={11} />
              <YAxis yAxisId="temp" orientation="right" domain={[30, 'auto']} tickFormatter={(v: number) => `${v} °C`} tickLine={false} axisLine={false} width={48} fontSize={11} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => (p?.[0]?.payload?.t ? formatDateTime(p[0].payload.t) : '')}
                    formatter={(value, name, item) => (
                      <div className="flex w-full items-center gap-2">
                        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
                        <span className="text-muted-foreground">{config[String(name)]?.label}</span>
                        <span className="ml-auto pl-3 font-mono font-medium tabular-nums">{Math.round(Number(value))}{name === 'hottest' ? ' °C' : '%'}</span>
                      </div>
                    )}
                  />
                }
              />
              {fans.map((f) => (
                <Line key={f.id} yAxisId="duty" dataKey={`duty_${f.id}`} type="stepAfter" stroke={`var(--color-duty_${f.id})`} strokeWidth={2} dot={false} isAnimationActive={false} />
              ))}
              <Line yAxisId="temp" dataKey="hottest" type="monotone" stroke="var(--color-hottest)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        ) : (
          <Skeleton className="h-56 w-full" />
        )}
      </CardContent>
    </Card>
  )
}
