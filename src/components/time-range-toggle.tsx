import type { TimeRange } from '@/api/types'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

export function TimeRangeToggle({ value, onChange, ranges = ['1h', '6h', '24h', '7d'] }: { value: TimeRange; onChange: (r: TimeRange) => void; ranges?: TimeRange[] }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as TimeRange)} aria-label="Time range">
      {ranges.map((r) => (
        <ToggleGroupItem key={r} value={r} className="px-3 font-mono text-xs data-[state=on]:text-brand">
          {r}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
