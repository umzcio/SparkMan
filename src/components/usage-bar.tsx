import { formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Ticker } from './ticker'

/** Thin vertical gauge + label + tweened value. `value` is 0–100 for the bar; `format` renders the number. */
export function UsageBar({ label, value, format = (v) => formatPercent(v) }: { label: string; value: number | null; format?: (v: number | null) => string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, value))
  const tone = value == null ? 'bg-muted' : pct >= 90 ? 'bg-level-error' : pct >= 75 ? 'bg-level-warn' : 'bg-brand'
  return (
    <div className="flex items-end gap-2" title={`${label} ${format(value)}`}>
      <div className="relative h-7 w-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('absolute inset-0 origin-bottom rounded-full transition-[transform,background-color] duration-500 ease-(--ease-out-strong)', tone)}
          style={{ transform: `scaleY(${pct / 100})` }}
        />
      </div>
      <div className="leading-none">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <Ticker value={value} format={format} className="mt-1 block font-mono text-sm" />
      </div>
    </div>
  )
}
