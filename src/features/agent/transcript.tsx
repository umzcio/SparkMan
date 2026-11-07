import { Brain, ChevronRight, CircleAlert, GitBranch, ImageIcon, Info, SquareTerminal, TriangleAlert, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PermissionDecisionBody } from '@/agent/protocol'
import { isPendingPermission, type SessionView, type TranscriptItem } from '@/agent/reduce-events'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatCompact, formatDuration, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Markdown } from './markdown'
import { PermissionCard } from './permission-card'
import { useProvider } from './providers'
import { ToolCard } from './tool-card'

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ml-7 text-sm" data-testid="thinking">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn('size-3.5 transition-transform duration-200 ease-(--ease-out-strong)', open && 'rotate-90')} />
        <Brain className="size-3.5" />
        Thinking
      </button>
      <div className="collapsible" data-open={open} inert={!open}>
        <div>
          <div className="mt-1 border-l-2 border-claude/30 pl-3 text-muted-foreground italic">
            <Markdown text={text} />
          </div>
        </div>
      </div>
    </div>
  )
}

const NOTICE_ICON = { info: Info, warning: TriangleAlert, error: CircleAlert }
const NOTICE_CLS = { info: 'text-muted-foreground', warning: 'text-level-warn', error: 'text-level-error' }

function IconAction({ label, onClick, children, testId }: { label: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="size-6 text-muted-foreground" onClick={onClick} aria-label={label} data-testid={testId}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function Transcript({
  view, deciding, onDecide, onRewind, onFork,
}: {
  view: SessionView
  deciding: boolean
  onDecide: (requestId: string, body: PermissionDecisionBody) => void
  onRewind: (userUuid: string) => void
  onFork: (assistantUuid: string) => void
}) {
  const { Mark, name, features } = useProvider()
  const end = useRef<HTMLDivElement>(null)
  const last = view.items.at(-1)
  const lastSize = last?.type === 'assistant' ? last.text.length : 0
  const waitingOnOperator = view.items.some((i) => isPendingPermission(i, view))
  const streaming = last?.type === 'assistant' && last.streaming
  const working = view.state === 'running' && !waitingOnOperator && !streaming
  const idle = view.state === 'idle'

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [view.items.length, lastSize, working])

  if (view.items.length === 0) {
    return (
      <div className="grid h-full place-items-center text-center text-sm text-muted-foreground">
        <div className="enter-fade">
          <Mark className="mx-auto mb-3 size-8" label={null} />
          Ask {name} to do something on this host.
          <div className="mt-1 font-mono text-xs">{view.cwd}</div>
          <div className="mt-3 text-xs">
            {features.cost ? (
              <>
                Type <kbd className="rounded border px-1 font-mono">/</kbd> for commands and skills · paste images to attach them
              </>
            ) : (
              'Paste images to attach them · plugins and skills are in the session panel'
            )}
          </div>
        </div>
      </div>
    )
  }

  const render = (item: TranscriptItem) => {
    switch (item.type) {
      case 'user':
        return (
          <div key={item.key} className="group ml-auto flex max-w-[80%] items-start gap-1">
            {item.uuid && idle && features.rewind && (
              <span className="mt-1 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                <IconAction label="Rewind files to before this message" onClick={() => onRewind(item.uuid!)} testId="rewind-button">
                  <Undo2 />
                </IconAction>
              </span>
            )}
            <div className={cn('enter-pop origin-bottom-right whitespace-pre-wrap rounded-2xl rounded-br-sm bg-secondary px-3.5 py-2 text-sm', item.rewound && 'opacity-70')} data-testid="user-message">
              {item.images ? (
                <span className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                  <ImageIcon className="size-3" />
                  {item.images} image{item.images === 1 ? '' : 's'}
                </span>
              ) : null}
              {item.text}
            </div>
          </div>
        )
      case 'assistant':
        return (
          <div key={item.key} className="enter-fade flex max-w-[92%] gap-3" data-testid="assistant-message">
            <Mark className="mt-0.5 size-4" label={null} />
            <div className="min-w-0 flex-1">
              <Markdown text={item.text} />
              {item.streaming && <span className="ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 rounded-full bg-claude motion-safe:animate-pulse" aria-hidden />}
            </div>
          </div>
        )
      case 'thinking':
        return view.showThinking ? (
          <div key={item.key} className="enter-fade">
            <Thinking text={item.text} />
          </div>
        ) : null
      case 'tool':
        // AskUserQuestion / ExitPlanMode are shown by their permission card
        if ((item.name === 'AskUserQuestion' || item.name === 'ExitPlanMode') && view.items.some((i) => i.type === 'permission' && i.toolUseId === item.toolUseId)) return null
        return (
          <div key={item.key} className="enter-fade-up ml-7">
            <ToolCard name={item.name} input={item.input} result={item.result} elapsedSeconds={item.elapsedSeconds} />
          </div>
        )
      case 'permission':
        return (
          <div key={item.key} className="enter-pop ml-7">
            <PermissionCard
              toolName={item.toolName}
              input={item.input}
              reason={item.reason}
              resolution={item.resolution}
              pending={isPendingPermission(item, view)}
              busy={deciding}
              onDecide={(body) => onDecide(item.requestId, body)}
            />
          </div>
        )
      case 'turn':
        return (
          <div key={item.key} className="group flex items-center gap-3 text-xs text-muted-foreground" data-testid="turn-end">
            <span className="draw-x h-px flex-1 origin-right bg-border" />
            <span className="enter-fade font-mono tabular-nums">
              {item.isError ? 'stopped' : 'done'} · {formatDuration(item.durationMs)} · {item.tokens !== undefined && !features.cost ? `${formatCompact(item.tokens)} tokens` : `${formatUsd(item.costUsd)} total`}
            </span>
            {item.checkpoint && idle && features.fork && (
              <span className="opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                <IconAction label="Fork a new session from here" onClick={() => onFork(item.checkpoint!)} testId="fork-button">
                  <GitBranch />
                </IconAction>
              </span>
            )}
            <span className="draw-x h-px flex-1 origin-left bg-border" />
          </div>
        )
      case 'error':
        return (
          <div key={item.key} className="enter-fade-up ml-7 flex items-start gap-2 rounded-lg border border-level-error/40 bg-level-error/10 px-3 py-2 text-sm text-level-error">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {item.message}
          </div>
        )
      case 'notice': {
        const Icon = NOTICE_ICON[item.level]
        return (
          <div key={item.key} className={cn('enter-fade ml-7 flex items-start gap-2 text-xs', NOTICE_CLS[item.level])} data-testid="notice">
            <Icon className="mt-px size-3.5 shrink-0" />
            {item.text}
          </div>
        )
      }
      case 'command':
        return (
          <div key={item.key} className="enter-fade-up ml-7 rounded-lg border bg-card" data-testid="command-output">
            <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs text-muted-foreground">
              <SquareTerminal className="size-3.5" />
              Command output
            </div>
            <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs whitespace-pre-wrap">{item.text}</pre>
          </div>
        )
    }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="transcript">
      {view.items.map(render)}
      {working && (
        <div className="enter-fade flex items-center gap-3 text-sm" data-testid="agent-working" role="status">
          <Mark className="spin-slow size-4" label={null} />
          <span className="shimmer-text">Working…</span>
        </div>
      )}
      <div ref={end} />
    </div>
  )
}
