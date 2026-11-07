import { Hand } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts'
import { Slider as SliderPrimitive } from 'radix-ui'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSetFanOverride } from '@/api/hooks'
import type { Fan } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { reasonText } from '@/lib/cooling'
import { cn } from '@/lib/utils'

/** keyboard steps arrive one commit per key; wait for a pause before pinning the fan */
const COMMIT_DELAY_MS = 350

export function FanCard({ fan, maxRpm, disabled = false, children }: { fan: Fan; maxRpm: number; disabled?: boolean; children?: ReactNode }) {
  const setOverride = useSetFanOverride()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const commit = (duty: number) => {
    clearTimeout(timer.current)
    // a failed override puts the slider back on the fan's real speed
    timer.current = setTimeout(() => setOverride.mutate({ fanId: fan.id, duty }, { onError: () => setDrag(null) }), COMMIT_DELAY_MS)
  }
  // the slider shows the commanded duty; while dragging it shows the drag value
  const [drag, setDrag] = useState<number | null>(null)
  // a saved override arriving from the simulator ends the drag (derived-state pattern, no effect)
  const [savedManual, setSavedManual] = useState(fan.manualDuty)
  if (savedManual !== fan.manualDuty) {
    setSavedManual(fan.manualDuty)
    setDrag(null)
  }
  const value = drag ?? fan.manualDuty ?? fan.duty
  return (
    <Card className={cn('gap-3 py-4', fan.stalled && 'border-level-error/50')} data-testid="fan-card" data-fan={fan.id}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {fan.name}
          {fan.mode === 'manual' && (
            <Badge variant="outline" className="gap-1 border-level-info/40 text-level-info">
              <Hand className="size-3" /> Manual
            </Badge>
          )}
          {fan.stalled && <Badge variant="destructive">Stalled</Badge>}
        </CardTitle>
        <span className="font-mono text-xs text-muted-foreground">{fan.nodeIds.join(' · ') || 'no boxes'}</span>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-3xl font-semibold tabular-nums" data-testid="fan-duty">{fan.duty}%</span>
          <span className="font-mono text-sm tabular-nums text-muted-foreground" data-testid="fan-rpm">
            {fan.rpm.toLocaleString()} <span className="text-xs">/ {maxRpm.toLocaleString()} rpm</span>
          </span>
        </div>
        <p className="truncate text-sm text-muted-foreground" data-testid="fan-reason">{reasonText(fan.reason)}</p>
        {children}
        <div className="flex items-center gap-3">
          <SliderPrimitive.Root
            min={0}
            max={100}
            step={5}
            value={[value]}
            onValueChange={([v]) => setDrag(v)}
            onValueCommit={([v]) => commit(v)}
            disabled={disabled}
            className="relative flex h-6 flex-1 touch-none items-center select-none"
          >
            <SliderPrimitive.Track className="relative h-1.5 grow overflow-hidden rounded-full bg-muted">
              <SliderPrimitive.Range className="absolute h-full bg-brand" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
              aria-label={`${fan.name} speed`}
              className="block size-4 rounded-full border-2 border-brand bg-background shadow-sm outline-none transition-transform duration-150 focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95"
            />
          </SliderPrimitive.Root>
          <Button size="sm" variant="outline" disabled={disabled || fan.mode === 'auto'} onClick={() => setOverride.mutate({ fanId: fan.id, duty: null })} data-testid="fan-auto">
            Back to auto
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** the last 15 minutes of a fan's commanded speed */
export function FanSparkline({ points }: { points: { t: number; d: number | undefined }[] }) {
  return (
    <div className="h-10" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          <YAxis hide domain={[0, 100]} />
          <Line dataKey="d" type="stepAfter" stroke="var(--brand)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
