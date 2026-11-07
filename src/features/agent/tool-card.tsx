import { Bot, CheckCircle2, ChevronRight, Circle, CircleDot, FilePen, FileText, Globe, ListTodo, Loader, MessageCircleQuestion, NotebookPen, Search, Terminal, Wrench, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { TodoItem } from '@/agent/reduce-events'
import { cn } from '@/lib/utils'
import { DiffView, fileEdits } from './diff-view'

const ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  Shell: Terminal,
  ApplyPatch: FilePen,
  Read: FileText,
  Edit: FilePen,
  MultiEdit: FilePen,
  Write: FilePen,
  NotebookEdit: FilePen,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  TodoWrite: ListTodo,
  Agent: Bot,
  Task: Bot,
  AskUserQuestion: MessageCircleQuestion,
  ExitPlanMode: NotebookPen,
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** One-line description of a tool call for card headers and permission prompts. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) return str((input.questions[0] as { question?: unknown })?.question) ?? 'question'
  if (name === 'ExitPlanMode') return 'plan ready for review'
  if (name === 'ApplyPatch' && Array.isArray(input.changes)) {
    const paths = (input.changes as { path?: unknown }[]).map((c) => str(c.path) ?? '?')
    return paths.length === 1 ? paths[0] : `${paths.length} files: ${paths.join(', ')}`
  }
  return (
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description) ??
    (Object.keys(input).join(', ') || name)
  )
}

export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? Wrench
}

export function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <ul className="space-y-1" data-testid="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={cn('flex items-start gap-2 text-sm', t.status === 'completed' && 'text-muted-foreground line-through')}>
          {t.status === 'completed' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-brand" /> : t.status === 'in_progress' ? <CircleDot className="mt-0.5 size-3.5 shrink-0 text-claude" /> : <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <span className={cn(t.status === 'in_progress' && 'font-medium')}>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  )
}

export function ToolCard({ name, input, result, elapsedSeconds }: { name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean }; elapsedSeconds?: number }) {
  const [open, setOpen] = useState(false)
  const Icon = toolIcon(name)
  const edits = fileEdits(name, input)
  const todos = name === 'TodoWrite' && Array.isArray(input.todos) ? (input.todos as TodoItem[]) : null
  return (
    <div className={cn('rounded-lg border bg-card text-sm', result?.isError && 'border-level-error/40')} data-testid="tool-card">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/40">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-(--ease-out-strong)', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{toolSummary(name, input)}</span>
        {!result && elapsedSeconds !== undefined && <span className="font-mono text-xs tabular-nums text-muted-foreground">{Math.round(elapsedSeconds)}s</span>}
        {!result && <Loader className="size-3.5 shrink-0 text-level-info motion-safe:animate-spin" aria-label="running" />}
        {result && !result.isError && <span className="enter-fade text-xs text-muted-foreground">done</span>}
        {result?.isError && <span className="enter-fade text-xs text-level-error">failed</span>}
      </button>
      {todos && (
        <div className="border-t px-3 py-2">
          <TodoList todos={todos} />
        </div>
      )}
      <div className="collapsible" data-open={open} inert={!open}>
        <div>
          <div className="space-y-2 border-t px-3 py-2">
            {edits ? <DiffView path={edits.path} lines={edits.lines} /> : !todos && <pre className="overflow-x-auto rounded bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(input, null, 2)}</pre>}
            {result && <pre className={cn('max-h-80 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs', result.isError && 'text-level-error')}>{result.content || '(no output)'}</pre>}
          </div>
        </div>
      </div>
    </div>
  )
}
