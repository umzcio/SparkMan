import { useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

export interface BenchSeries {
  key: string
  label: string
  color: string
  format: (v: number) => string
}

/**
 * Categorical bench chart: bars for the headline metric, an optional line on a second axis.
 * Draws in once on mount; bars that stream in while a run is live appear without re-animating the rest.
 */
export function BenchChart({ title, data, xKey, xFormat, bar, line, testId }: {
  title: string
  data: Record<string, number>[]
  xKey: string
  xFormat: (v: number) => string
  bar: BenchSeries
  line?: BenchSeries
  testId?: string
}) {
  const reduce = useReducedMotion()
  const [intro, setIntro] = useState(!reduce)
  const series = line ? [bar, line] : [bar]
  const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))
  return (
    <Card className="gap-3 py-4" data-testid={testId}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <ComposedChart data={data} margin={{ left: 4, right: line ? 4 : 12, top: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey={xKey} tickFormatter={(v: number) => xFormat(v)} tickLine={false} axisLine={false} fontSize={11} />
            <YAxis yAxisId="bar" width={64} tickFormatter={(v: number) => bar.format(v)} tickLine={false} axisLine={false} fontSize={11} />
            {line && <YAxis yAxisId="line" orientation="right" width={64} tickFormatter={(v: number) => line.format(v)} tickLine={false} axisLine={false} fontSize={11} />}
            <ChartTooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const x = payload?.[0]?.payload?.[xKey]
                    return typeof x === 'number' ? xFormat(x) : ''
                  }}
                  formatter={(value, name) => {
                    const s = series.find((x) => x.key === name)
                    return (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <span className="size-2 rounded-[2px]" style={{ background: `var(--color-${String(name)})` }} />
                          {s?.label ?? String(name)}
                        </span>
                        <span className="font-mono tabular-nums">{s ? s.format(Number(value)) : String(value)}</span>
                      </div>
                    )
                  }}
                />
              }
            />
            <Bar
              yAxisId="bar"
              dataKey={bar.key}
              fill={`var(--color-${bar.key})`}
              fillOpacity={0.85}
              radius={[4, 4, 0, 0]}
              maxBarSize={48}
              isAnimationActive={intro}
              animationDuration={260}
              animationEasing="ease-out"
              onAnimationEnd={() => setIntro(false)}
            />
            {line && (
              <Line
                yAxisId="line"
                dataKey={line.key}
                type="monotone"
                stroke={`var(--color-${line.key})`}
                strokeWidth={1.75}
                dot={{ r: 3, fill: `var(--color-${line.key})` }}
                isAnimationActive={intro}
                animationDuration={260}
                animationEasing="ease-out"
              />
            )}
          </ComposedChart>
        </ChartContainer>
        <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
