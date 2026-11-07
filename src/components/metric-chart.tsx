import type { LucideIcon } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import type { TimeRange } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatDateTime, formatTimeTick } from '@/lib/format'
import { cn } from '@/lib/utils'

export type MetricLike = { t: number } & Record<string, number | null>
export interface Series {
  key: string
  label: string
  color: string
}

export function MetricChart({
  title, icon: Icon, data, series, format, range, domain, stacked = false, current, height = 160, emptyText = 'No data — node unreachable', className, style,
}: {
  title: string
  icon?: LucideIcon
  data: MetricLike[]
  series: Series[]
  format: (v: number) => string
  range: TimeRange
  domain?: [number, number | 'auto']
  stacked?: boolean
  current?: ReactNode
  height?: number
  emptyText?: string
  className?: string
  style?: CSSProperties
}) {
  const reduce = useReducedMotion()
  // draw in once on mount; live updates afterwards don't animate (a sliding window would wobble)
  const [intro, setIntro] = useState(!reduce)
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
  const hasData = data.some((p) => series.some((s) => p[s.key] != null))
  return (
    <Card className={cn('gap-3 py-4', className)} style={style} data-testid={`chart-${title}`}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="size-4 text-muted-foreground" />}
          {title}
        </CardTitle>
        {current !== undefined && <span className="font-mono text-sm tabular-nums">{current}</span>}
      </CardHeader>
      <CardContent className="px-2">
        {hasData ? (
          <ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
            <AreaChart data={data} margin={{ left: 4, right: 8, top: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(t: number) => formatTimeTick(t, range)} tickLine={false} axisLine={false} minTickGap={40} fontSize={11} />
              <YAxis width={80} tickFormatter={(v: number) => format(v)} tickLine={false} axisLine={false} domain={domain ?? [0, 'auto']} fontSize={11} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const t = payload?.[0]?.payload?.t
                      return typeof t === 'number' ? formatDateTime(t) : ''
                    }}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="size-2 rounded-[2px]" style={{ background: `var(--color-${String(name)})` }} />
                          {config[String(name)]?.label ?? String(name)}
                        </span>
                        <span className="font-mono tabular-nums">{format(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              {series.map((s) => (
                <Area
                  key={s.key}
                  dataKey={s.key}
                  type="monotone"
                  stroke={`var(--color-${s.key})`}
                  fill={`var(--color-${s.key})`}
                  fillOpacity={0.12}
                  strokeWidth={1.5}
                  stackId={stacked ? 'stack' : undefined}
                  isAnimationActive={intro}
                  animationDuration={700}
                  animationEasing="ease-out"
                  onAnimationEnd={() => setIntro(false)}
                  connectNulls={false}
                  dot={false}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="grid place-items-center text-sm text-muted-foreground" style={{ height }} data-testid="chart-empty">
            {emptyText}
          </div>
        )}
        {series.length > 1 && (
          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
