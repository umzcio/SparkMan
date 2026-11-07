import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** `name old → new` or `name (held back)`, as the server lists them */
function parse(line: string): { name: string; from: string | null; to: string | null; held: boolean } {
  const held = /^(\S+) \(held back\)$/.exec(line)
  if (held) return { name: held[1], from: null, to: null, held: true }
  const m = /^(\S+) (\S+) → (\S+)$/.exec(line)
  return m ? { name: m[1], from: m[2], to: m[3], held: false } : { name: line, from: null, to: null, held: false }
}

/** "19 pending", opening the list on hover, focus or tap. */
export function PendingPackages({ nodeId, packages }: { nodeId: string; packages: string[] }) {
  const [open, setOpen] = useState(false)
  const rows = packages.map(parse).sort((a, b) => Number(b.held) - Number(a.held) || a.name.localeCompare(b.name))
  const held = rows.filter((r) => r.held).length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="cursor-help rounded-sm font-mono text-sm underline decoration-dotted underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {packages.length} pending
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
          <span className="text-sm font-medium">{packages.length} packages</span>
          <span className="font-mono text-xs text-muted-foreground">
            {nodeId}
            {held > 0 && ` · ${held} held back`}
          </span>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1" data-testid="pending-packages">
          {rows.map((r) => (
            <li key={r.name} className="px-3 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">{r.name}</span>
                {r.held && <span className="shrink-0 text-[11px] text-level-warn">held back</span>}
              </div>
              {r.from && (
                <div className="truncate font-mono text-[11px] text-muted-foreground" title={`${r.from} → ${r.to}`}>
                  {r.from} <span className="text-brand">→ {r.to}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
