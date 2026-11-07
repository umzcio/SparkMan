import { useEffect, useRef } from 'react'
import type { LogLevel, LogLine } from '@/api/types'
import { formatClock } from '@/lib/format'
import { cn } from '@/lib/utils'

const LEVEL_CLASS: Record<LogLevel, string> = {
  error: 'bg-level-error/15 text-level-error',
  warn: 'bg-level-warn/15 text-level-warn',
  info: 'bg-level-info/15 text-level-info',
  debug: 'bg-muted text-muted-foreground',
}

export function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <span className={cn('inline-flex w-14 justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase', LEVEL_CLASS[level])} data-testid="level-badge">
      {level}
    </span>
  )
}

export function LogTable({ lines, selectedId, onSelect }: { lines: LogLine[]; selectedId: string | null; onSelect: (l: LogLine) => void }) {
  const seen = useRef(new Set<string>())
  const primed = seen.current.size > 0
  useEffect(() => {
    for (const l of lines) seen.current.add(l.id)
  }, [lines])

  return (
    <div className="overflow-x-auto rounded-xl border">
      {/* phones: each line is a two-row grid (time, level, service, host / message); md+ is a table */}
      <table className="block w-full text-sm md:table md:table-fixed">
        <colgroup>
          <col className="w-32" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-32" />
          <col />
        </colgroup>
        <thead className="hidden text-left text-xs text-muted-foreground md:table-header-group">
          <tr className="border-b">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Level</th>
            <th className="px-3 py-2 font-medium">Service</th>
            <th className="px-3 py-2 font-medium">Host</th>
            <th className="px-3 py-2 font-medium">Message</th>
          </tr>
        </thead>
        <tbody className="block font-mono md:table-row-group">
          {lines.map((l) => {
            const [hms, ms] = formatClock(l.ts).split('.')
            const selected = l.id === selectedId
            return (
              <tr
                key={l.id}
                data-testid="log-row"
                aria-selected={selected}
                tabIndex={0}
                onClick={() => onSelect(l)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSelect(l)
                }}
                className={cn(
                  'grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center border-b border-border/50 py-1 last:border-0 hover:bg-muted/40 focus-visible:bg-muted/60 focus-visible:outline-none md:table-row md:py-0',
                  primed && !seen.current.has(l.id) && 'animate-row-in',
                  selected && 'bg-brand/10 shadow-[inset_3px_0_0_var(--brand)]',
                )}
              >
                <td className="px-3 py-0.5 text-xs tabular-nums md:py-1.5 md:text-sm">
                  {hms}
                  <span className="text-muted-foreground">.{ms}</span>
                </td>
                <td className="py-0.5 md:px-3 md:py-1.5">
                  <LevelBadge level={l.level} />
                </td>
                <td className="truncate px-3 py-0.5 text-xs md:py-1.5 md:text-sm">{l.service}</td>
                <td className="truncate px-3 py-0.5 text-xs text-muted-foreground md:py-1.5 md:text-sm">{l.host}</td>
                <td className="col-span-4 line-clamp-2 px-3 py-0.5 text-xs break-all md:col-span-1 md:line-clamp-none md:truncate md:py-1.5 md:text-sm md:break-normal" title={l.message}>
                  {l.message}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
