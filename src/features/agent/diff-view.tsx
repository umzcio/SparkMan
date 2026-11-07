import { cn } from '@/lib/utils'

type Line = { kind: ' ' | '-' | '+'; text: string }

const MAX_LINES = 400

/** Line diff of one replacement: shared head/tail lines become context, the middle is -/+. */
export function diffLines(before: string, after: string): Line[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ctx = (lines: string[]) => lines.map((text): Line => ({ kind: ' ', text }))
  return [
    ...ctx(a.slice(Math.max(0, head - 2), head)),
    ...a.slice(head, a.length - tail).map((text): Line => ({ kind: '-', text })),
    ...b.slice(head, b.length - tail).map((text): Line => ({ kind: '+', text })),
    ...ctx(b.slice(b.length - tail, b.length - tail + 2)),
  ]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The edits a file tool call would make, or null when the tool doesn't change files. */
export function fileEdits(name: string, input: Record<string, unknown>): { path: string; lines: Line[] } | null {
  const path = str(input.file_path) || str(input.notebook_path)
  if (name === 'Edit') return { path, lines: diffLines(str(input.old_string), str(input.new_string)) }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines = (input.edits as { old_string?: unknown; new_string?: unknown }[]).flatMap((e, i) => [
      ...(i > 0 ? [{ kind: ' ' as const, text: '⋯' }] : []),
      ...diffLines(str(e.old_string), str(e.new_string)),
    ])
    return { path, lines }
  }
  if (name === 'Write') return { path, lines: str(input.content).split('\n').map((text) => ({ kind: '+' as const, text })) }
  if (name === 'ApplyPatch' && Array.isArray(input.changes)) {
    // Codex: one unified diff per file
    const changes = input.changes as { path?: unknown; diff?: unknown }[]
    const lines = changes.flatMap((c, i) => [
      ...(changes.length > 1 ? [{ kind: ' ' as const, text: `${i > 0 ? '\n' : ''}── ${str(c.path)}` }] : []),
      ...unifiedLines(str(c.diff)),
    ])
    return { path: changes.length === 1 ? str(changes[0].path) : `${changes.length} files`, lines }
  }
  return null
}

/** Lines of a unified diff body (hunk headers and file headers dropped). */
export function unifiedLines(diff: string): Line[] {
  return diff
    .split('\n')
    .filter((l) => !l.startsWith('@@') && !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff ') && !l.startsWith('index '))
    .filter((l, i, all) => l !== '' || i < all.length - 1)
    .map((l): Line => (l.startsWith('+') ? { kind: '+', text: l.slice(1) } : l.startsWith('-') ? { kind: '-', text: l.slice(1) } : { kind: ' ', text: l.startsWith(' ') ? l.slice(1) : l }))
}

export function DiffView({ path, lines, className }: { path: string; lines: Line[]; className?: string }) {
  const shown = lines.slice(0, MAX_LINES)
  const added = lines.filter((l) => l.kind === '+').length
  const removed = lines.filter((l) => l.kind === '-').length
  return (
    <div className={cn('overflow-hidden rounded-md border bg-surface-2 font-mono text-xs', className)} data-testid="diff-view">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        <span className="text-brand">+{added}</span>
        <span className="text-level-error">−{removed}</span>
      </div>
      <pre className="max-h-72 overflow-auto py-1">
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn('px-2', l.kind === '+' && 'bg-brand/10 text-brand', l.kind === '-' && 'bg-level-error/10 text-level-error', l.kind === ' ' && 'text-muted-foreground')}
          >
            <span className="mr-2 select-none opacity-60">{l.kind}</span>
            {l.text || ' '}
          </div>
        ))}
        {lines.length > MAX_LINES && <div className="px-2 text-muted-foreground">… {lines.length - MAX_LINES} more lines</div>}
      </pre>
    </div>
  )
}
