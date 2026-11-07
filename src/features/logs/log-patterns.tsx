import { useMemo } from 'react'
import type { LogLevel, LogLine } from '@/api/types'
import { Card } from '@/components/ui/card'
import { LevelBadge } from './log-table'

const template = (message: string) => message.replace(/\d+(\.\d+)?/g, '<n>')

export function LogPatterns({ lines, onPick }: { lines: LogLine[]; onPick: (pattern: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { pattern: string; level: LogLevel; sample: string; count: number }>()
    for (const l of lines) {
      const g = map.get(l.pattern)
      if (g) g.count++
      else map.set(l.pattern, { pattern: l.pattern, level: l.level, sample: l.message, count: 1 })
    }
    return [...map.values()].sort((a, b) => b.count - a.count)
  }, [lines])

  return (
    <Card className="gap-0 py-0">
      <div className="flex justify-between border-b px-4 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Grouped by pattern</span>
        <span className="font-mono">{lines.length} lines</span>
      </div>
      <ul className="divide-y">
        {groups.map((g) => (
          <li key={g.pattern}>
            <button type="button" data-testid="pattern-row" onClick={() => onPick(g.pattern)} className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/40">
              <LevelBadge level={g.level} />
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{template(g.sample)}</span>
              <span className="font-mono text-sm tabular-nums text-muted-foreground">{g.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
