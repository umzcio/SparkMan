import { Fragment } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'muted'

export interface StatusItem {
  /** the fact, e.g. "11 online" */
  text: string
  /** colours the dot; omit for no dot */
  tone?: StatusTone
}

const DOT: Record<StatusTone, string> = {
  ok: 'bg-brand',
  warn: 'bg-level-warn',
  error: 'bg-level-error',
  info: 'bg-level-info',
  muted: 'bg-muted-foreground/60',
}

/** A page's live subtitle: a few facts that answer "is anything wrong here?" at a glance. */
export function StatusLine({ items }: { items: StatusItem[] | null }) {
  if (!items) return <Skeleton className="h-4 w-72" />
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="status-line">
      {items.map((it, i) => (
        <Fragment key={it.text}>
          {i > 0 && (
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            {it.tone && <span className={cn('size-1.5 rounded-full', DOT[it.tone], it.tone !== 'ok' && it.tone !== 'muted' && 'motion-safe:animate-pulse')} aria-hidden />}
            {it.text}
          </span>
        </Fragment>
      ))}
    </span>
  )
}
