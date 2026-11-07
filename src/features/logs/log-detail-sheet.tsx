import { ChevronDown, ChevronUp, Funnel, Rows3 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LogLine } from '@/api/types'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatClock, formatCompact, formatDateTime, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { LevelBadge } from './log-table'

const STATUS_TEXT: Record<string, string> = { '200': 'OK', '502': 'Bad Gateway', '504': 'Gateway Timeout' }

function annotate(key: string, value: string): { text: string; bad: boolean } | null {
  if (key === 'duration_ms') return { text: formatDuration(Number(value)), bad: Number(value) > 5000 }
  if (key === 'http.status_code') return STATUS_TEXT[value] ? { text: STATUS_TEXT[value], bad: Number(value) >= 500 } : null
  if (key.startsWith('tokens_')) return { text: `${formatCompact(Number(value))} tokens`, bad: false }
  return null
}

export function formatForAi(line: LogLine): string {
  return [
    'Log line from the SparkMan fleet (NVIDIA DGX Spark / GB10):',
    '',
    `- time: ${new Date(line.ts).toISOString()}`,
    `- level: ${line.level}`,
    `- host: ${line.host}`,
    `- service: ${line.service}`,
    `- source: ${line.source}`,
    `- pattern: ${line.pattern}`,
    '',
    'Message:',
    '```',
    line.message,
    '```',
    '',
    'Attributes:',
    '```json',
    JSON.stringify(line.attributes, null, 2),
    '```',
  ].join('\n')
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 font-mono text-[11px]">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function KvTable({ rows }: { rows: { k: string; v: string; note?: { text: string; bad: boolean } | null }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] overflow-hidden rounded-lg border font-mono text-sm">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="border-b bg-surface-2/60 px-3 py-1.5 text-muted-foreground last-of-type:border-0">{r.k}</dt>
          <dd className="break-all border-b px-3 py-1.5">
            {r.v}
            {r.note && <span className={cn('ml-2', r.note.bad ? 'text-level-error' : 'text-muted-foreground')}>// {r.note.text}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function LogDetailSheet({
  line, index, total, onClose, onStep, onLinesAround, onSamePattern,
}: {
  line: LogLine | null
  index: number
  total: number
  onClose: () => void
  onStep: (dir: 1 | -1) => void
  onLinesAround: (l: LogLine) => void
  onSamePattern: (l: LogLine) => void
}) {
  const attrs = line ? Object.entries(line.attributes) : []
  return (
    <Sheet open={line !== null} onOpenChange={(o) => !o && onClose()} modal={false}>
      <SheetContent className="w-[520px] gap-0 overflow-y-auto sm:max-w-[520px]" onInteractOutside={(e) => e.preventDefault()} data-testid="log-detail">
        {line && (
          <>
            <SheetHeader className="gap-3 border-b">
              <div className="flex items-center gap-2 pr-8">
                <LevelBadge level={line.level} />
                <SheetTitle className="font-mono text-base tabular-nums" data-testid="log-detail-time">
                  {formatClock(line.ts)}
                </SheetTitle>
                <span className="truncate font-mono text-sm text-muted-foreground">{line.service}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Button size="icon" variant="ghost" aria-label="Newer line" disabled={index <= 0} onClick={() => onStep(-1)}>
                    <ChevronUp />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Older line" disabled={index === -1 || index >= total - 1} onClick={() => onStep(1)}>
                    <ChevronDown />
                  </Button>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="log-detail-position">
                    {index === -1 ? '–' : index + 1} / {total}
                  </span>
                </div>
              </div>
              <SheetDescription className="sr-only">Details for the selected log line</SheetDescription>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => onLinesAround(line)}>
                  <Rows3 />
                  Lines around
                </Button>
                <CopyButton value={formatForAi(line)} label="Copy for AI" toastText="Log line copied for AI" />
                <Button size="sm" variant="outline" onClick={() => onSamePattern(line)}>
                  <Funnel />
                  Same pattern
                </Button>
              </div>
            </SheetHeader>
            <div className="flex flex-col gap-5 p-4">
              <Section title="Message">
                <pre className="whitespace-pre-wrap break-words rounded-lg border bg-surface-2 p-3 font-mono text-sm">{line.message}</pre>
              </Section>
              <Section title="Fields">
                <KvTable
                  rows={[
                    { k: 'time', v: `${formatDateTime(line.ts)}.${formatClock(line.ts).split('.')[1]}` },
                    { k: 'service', v: line.service },
                    { k: 'host', v: line.host },
                    { k: 'source', v: line.source },
                    { k: 'severity', v: line.level, note: line.level === 'error' ? { text: 'ERROR', bad: true } : null },
                    { k: 'pattern', v: line.pattern },
                  ]}
                />
              </Section>
              <Section title="Attributes" count={attrs.length}>
                {attrs.length ? <KvTable rows={attrs.map(([k, v]) => ({ k, v: `"${v}"`, note: annotate(k, v) }))} /> : <p className="text-sm text-muted-foreground">No attributes</p>}
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
