import { useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { Bar, BarChart, ReferenceArea, XAxis, YAxis } from 'recharts'
import type { LogQueryResult, TimeRange } from '@/api/types'
import { Card } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { formatDateTime, formatNumber, formatTimeTick } from '@/lib/format'

const LEVELS = [
  { key: 'error', label: 'Error', color: 'var(--level-error)' },
  { key: 'warn', label: 'Warn', color: 'var(--level-warn)' },
  { key: 'info', label: 'Info', color: 'var(--level-info)' },
  { key: 'debug', label: 'Debug', color: 'var(--level-debug)' },
] as const

const RANGE_LABEL: Record<TimeRange, string> = { '15m': 'Last 15 minutes', '1h': 'Last hour', '6h': 'Last 6 hours', '24h': 'Last 24 hours', '7d': 'Last 7 days' }
const config: ChartConfig = Object.fromEntries(LEVELS.map((l) => [l.key, { label: l.label, color: l.color }]))

export function LogHistogram({ result, range, around, compact = false }: { result: LogQueryResult; range: TimeRange; around?: number; compact?: boolean }) {
  const width = result.histogram.length > 1 ? result.histogram[1].t - result.histogram[0].t : 1
  const reduce = useReducedMotion()
  // bars grow in once; live refreshes then update in place
  const [intro, setIntro] = useState(!reduce)
  return (
    <Card className="gap-2 py-4" data-testid="log-histogram">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 text-sm">
        <span>
          <span className="font-mono font-semibold tabular-nums">{formatNumber(result.total)}</span>{' '}
          <span className="text-muted-foreground">lines · {around !== undefined ? `±60 s around ${formatDateTime(around)}` : RANGE_LABEL[range]} · newest first</span>
        </span>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {LEVELS.map((l) => (
            <span key={l.key} className="flex items-center gap-1.5">
              <span className="size-2 rounded-[2px]" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
          {result.bands.length > 0 && (
            <span className="flex items-center gap-1.5 text-level-error">
              <span className="size-2 rounded-full border border-level-error" />
              Incidents {result.bands.length}
            </span>
          )}
        </div>
      </div>
      <ChartContainer config={config} className="aspect-auto w-full px-2" style={{ height: compact ? 96 : 140 }}>
        <BarChart data={result.histogram} margin={{ top: 18, right: 8, left: 8, bottom: 0 }} barCategoryGap={1}>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={[result.from, result.to]}
            tickFormatter={(t: number) => formatTimeTick(t, range === '7d' ? '7d' : '1h')}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            fontSize={11}
          />
          <YAxis hide />
          {result.bands.map((b) => (
            <ReferenceArea
              key={`${b.label}-${b.from}`}
              x1={b.from}
              x2={Math.max(b.to, b.from + width)}
              fill="var(--level-error)"
              fillOpacity={0.12}
              stroke="var(--level-error)"
              strokeOpacity={0.35}
              ifOverflow="hidden"
              // several bands' labels pile up on each other; the legend above counts them instead
              label={result.bands.length === 1 ? { value: `● Incident · ${b.label}`, position: 'insideTopLeft', fill: 'var(--level-error)', fontSize: 11 } : undefined}
            />
          ))}
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, payload) => {
                  const t = payload?.[0]?.payload?.t
                  return typeof t === 'number' ? formatDateTime(t) : ''
                }}
              />
            }
          />
          {(['debug', 'info', 'warn', 'error'] as const).map((k) => (
            <Bar key={k} dataKey={k} stackId="lvl" fill={`var(--color-${k})`} isAnimationActive={intro} animationDuration={500} animationEasing="ease-out" onAnimationEnd={() => setIntro(false)} />
          ))}
        </BarChart>
      </ChartContainer>
    </Card>
  )
}
