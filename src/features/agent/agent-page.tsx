import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, GitBranch, PanelRight, Plus } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { CreateSessionBody, HostMode, ImageAttachment, PermissionDecisionBody, SessionSummary } from '@/agent/protocol'
import { useAgentSession } from '@/agent/use-agent-session'
import { PageBody, PageHeader } from '@/components/page-header'
import { StatusLine } from '@/components/status-line'
import { EmptyState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompact, formatRelative, formatUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Composer, type MenuCommand } from './composer'
import { ModePicker } from './mode-picker'
import { NewSessionDialog } from './new-session-dialog'
import { ProviderProvider, useProvider, type AgentProvider } from './providers'
import { RewindDialog } from './rewind-dialog'
import { ContextMeter, ModelPicker, ThinkingToggle } from './session-controls'
import { SessionPanel } from './session-panel'
import { Transcript } from './transcript'

const onError = (e: Error) => toast.error(e.message)

function SessionList({ sessions, selected, onSelect }: { sessions: SessionSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  const { Mark } = useProvider()
  const now = Date.now()
  const reduce = useReducedMotion()
  if (sessions.length === 0) return <p className="enter-fade px-2 py-6 text-center text-sm text-muted-foreground">No sessions yet.</p>
  return (
    <ul className="flex flex-col gap-1">
      <AnimatePresence initial={false}>
      {sessions.map((s) => (
        <motion.li
          key={s.id}
          layout={!reduce}
          initial={reduce ? false : { opacity: 0, transform: 'translateY(-6px)' }}
          animate={{ opacity: 1, transform: 'translateY(0px)' }}
          transition={{ type: 'spring', duration: 0.35, bounce: 0 }}
        >
          <button
            type="button"
            onClick={() => onSelect(s.id)}
            aria-current={s.id === selected}
            data-testid="session-item"
            className={cn('w-full rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-muted/50 active:scale-[0.99]', s.id === selected && 'bg-secondary')}
          >
            <div className="flex items-center gap-2">
              {s.state === 'running' ? <Mark className="spin-slow size-3" label="running" /> : <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
              <span className="truncate text-sm">{s.title}</span>
              {s.forkedFrom && <GitBranch className="ml-auto size-3 shrink-0 text-muted-foreground" aria-label="fork" />}
            </div>
            <div className="mt-0.5 flex justify-between pl-3.5 text-xs text-muted-foreground">
              <span>{formatRelative(s.updatedAt, now)}</span>
              <span className="font-mono tabular-nums">{s.costUsd > 0 ? formatUsd(s.costUsd) : ''}</span>
            </div>
          </button>
        </motion.li>
      ))}
      </AnimatePresence>
    </ul>
  )
}

function ChatPanel({ sessionId, allowBypass, onOpenSession }: { sessionId: string; allowBypass: boolean; onOpenSession: (id: string) => void }) {
  const { api, id, Mark, features } = useProvider()
  const { load, reconnect } = useAgentSession(api, sessionId)
  const qc = useQueryClient()
  const [panelOpen, setPanelOpen] = useState(false)
  const [rewindUuid, setRewindUuid] = useState<string | null>(null)
  const refreshList = () => void qc.invalidateQueries({ queryKey: [id, 'sessions'] })
  const view = load.status === 'ready' ? load.view : null
  const caps = useQuery({
    queryKey: [id, sessionId, 'caps', view?.commandsVersion ?? 0],
    queryFn: () => api.capabilities(sessionId),
    enabled: view !== null,
    retry: false,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  })
  const send = useMutation({ mutationFn: (v: { text: string; images: ImageAttachment[] }) => api.sendMessage(sessionId, v.text, v.images), onSuccess: refreshList, onError })
  const decide = useMutation({ mutationFn: (v: { requestId: string; body: PermissionDecisionBody }) => api.decide(sessionId, v.requestId, v.body), onError })
  const setMode = useMutation({ mutationFn: (mode: HostMode) => api.setMode(sessionId, mode), onSuccess: refreshList, onError })
  const setModel = useMutation({ mutationFn: (model: string) => api.setModel(sessionId, model), onError })
  const setThinking = useMutation({ mutationFn: (enabled: boolean) => api.setThinking(sessionId, enabled), onError })
  const stop = useMutation({ mutationFn: () => api.interrupt(sessionId), onError })
  const fork = useMutation({
    mutationFn: (atUuid: string) => api.fork(sessionId, atUuid),
    onSuccess: (s) => {
      refreshList()
      toast.success('Forked into a new session')
      onOpenSession(s.id)
    },
    onError,
  })

  const commands = useMemo<MenuCommand[]>(() => {
    if (!caps.data) return []
    const hidden = new Set(caps.data.terminalCommands)
    return caps.data.commands.filter((c) => !hidden.has(c.name)).map((c) => ({ ...c, skill: caps.data.skills.includes(c.name) }))
  }, [caps.data])

  if (load.status === 'error') return <EmptyState title="Couldn’t open this session" description={load.message} />
  if (load.status !== 'ready' || !view) return <Skeleton className="h-full w-full" />

  const { connection } = load
  const running = view.state === 'running'
  const turns = view.items.filter((i) => i.type === 'turn').length
  const runningTasks = view.tasks.filter((t) => t.status === 'running').length
  const lastTokens = [...view.items].reverse().find((i) => i.type === 'turn' && i.tokens !== undefined)
  return (
    <div className="flex h-full min-h-0 flex-col">
      {connection !== 'live' && (
        <div className="enter-fade flex items-center gap-2 border-b border-level-warn/30 bg-level-warn/10 px-4 py-1.5 text-xs text-level-warn" role="status" data-testid="stream-status">
          {connection === 'reconnecting' ? 'Reconnecting to the host…' : 'Disconnected from the host agent.'}
          {connection === 'closed' && (
            <Button size="sm" variant="outline" className="ml-auto h-6" onClick={reconnect}>
              Retry
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <ModePicker mode={view.mode} allowBypass={allowBypass} onChange={(m) => setMode.mutate(m)} disabled={setMode.isPending} />
        <ModelPicker model={view.model} models={caps.data?.models ?? []} onChange={(m) => setModel.mutate(m)} disabled={setModel.isPending} />
        <ThinkingToggle enabled={view.showThinking} onChange={(on) => setThinking.mutate(on)} disabled={setThinking.isPending} />
        <span className="hidden truncate font-mono text-xs text-muted-foreground xl:inline" title={view.cwd}>
          {view.cwd}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          {running && (
            <span className="enter-fade mr-1 flex items-center gap-1.5 text-claude" data-testid="agent-running">
              <Mark className="spin-slow size-3" label={null} />
              working
            </span>
          )}
          <ContextMeter sessionId={sessionId} turns={turns} />
          <span className="px-1 font-mono tabular-nums" data-testid="session-spend">
            {features.cost ? formatUsd(view.costUsd) : lastTokens?.type === 'turn' && lastTokens.tokens !== undefined ? `${formatCompact(lastTokens.tokens)} tok` : '–'}
          </span>
          <Button variant="ghost" size="icon" className="relative size-7" onClick={() => setPanelOpen(true)} aria-label="Session details">
            <PanelRight />
            {runningTasks > 0 && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-level-info" />}
          </Button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Transcript
          view={view}
          deciding={decide.isPending}
          onDecide={(requestId, body) => decide.mutate({ requestId, body })}
          onRewind={setRewindUuid}
          onFork={(at) => fork.mutate(at)}
        />
      </div>
      <Composer
        running={running}
        sending={send.isPending}
        commands={commands}
        suggestion={view.suggestion}
        onSend={(text, images) => send.mutate({ text, images })}
        onStop={() => stop.mutate()}
      />
      <SessionPanel open={panelOpen} onOpenChange={setPanelOpen} sessionId={sessionId} view={view} caps={caps.data} />
      <RewindDialog sessionId={sessionId} userUuid={rewindUuid} onClose={() => setRewindUuid(null)} />
    </div>
  )
}

/** The chat page for one host agent (Claude Code or Codex). */
export function AgentPage({ provider, sessionId, onSelect }: { provider: AgentProvider; sessionId: string | null; onSelect: (id: string | null) => void }) {
  return (
    <ProviderProvider value={provider}>
      <AgentPageBody sessionId={sessionId} onSelect={onSelect} />
    </ProviderProvider>
  )
}

function AgentPageBody({ sessionId, onSelect }: { sessionId: string | null; onSelect: (id: string | null) => void }) {
  const { api, id, name, Mark, setupHint } = useProvider()
  const qc = useQueryClient()
  const health = useQuery({ queryKey: [id, 'health'], queryFn: api.health, retry: false })
  const sessions = useQuery({ queryKey: [id, 'sessions'], queryFn: api.listSessions, refetchInterval: 4000, enabled: health.isSuccess })
  const [newOpen, setNewOpen] = useState(false)
  const create = useMutation({
    mutationFn: (body: CreateSessionBody) => api.createSession(body),
    onSuccess: (s) => {
      setNewOpen(false)
      void qc.invalidateQueries({ queryKey: [id, 'sessions'] })
      onSelect(s.id)
    },
    onError,
  })

  const header = (
    <PageHeader
      crumbs={[{ label: 'SparkMan', to: '/' }, { label: name }]}
      fleetData={false}
      title={
        <span className="flex items-center gap-3">
          <Mark className="size-8" label={null} />
          {name}
        </span>
      }
      description={
        <StatusLine
          items={
            health.isError
              ? [{ text: 'Not available on this host', tone: 'muted' }]
              : sessions.data
                ? [
                    sessions.data.some((x) => x.state === 'running')
                      ? { text: `${sessions.data.filter((x) => x.state === 'running').length} working`, tone: 'info' }
                      : { text: 'Idle', tone: 'muted' },
                    { text: `${sessions.data.length} session${sessions.data.length === 1 ? '' : 's'}` },
                    { text: 'Runs on this host, not the Sparks' },
                  ]
                : null
          }
        />
      }
      actions={
        health.data && (
          <>
            {sessionId && (
              <Button variant="outline" className="lg:hidden" onClick={() => onSelect(null)} data-testid="back-to-sessions">
                <ChevronLeft />
                Sessions
              </Button>
            )}
            {health.data.fake && <Badge variant="outline" className="hidden text-level-warn sm:inline-flex">simulated agent</Badge>}
            <Badge variant="outline" className="hidden font-mono sm:inline-flex">
              {health.data.user ?? 'local'}
            </Badge>
            <Button onClick={() => setNewOpen(true)}>
              <Plus />
              New session
            </Button>
          </>
        )
      }
    />
  )

  if (health.isPending) {
    return (
      <>
        {header}
        <PageBody>
          <Skeleton className="h-96 w-full" />
        </PageBody>
      </>
    )
  }
  if (health.isError) {
    return (
      <>
        {header}
        <PageBody>
          <EmptyState
            title={`${name} isn’t available on this host`}
            description={
              <>
                {health.error.message}. {setupHint}
              </>
            }
          />
        </PageBody>
      </>
    )
  }

  return (
    <>
      {header}
      <PageBody className="pb-6">
        {/* phones and tablets show one pane at a time: the session list, or the open chat */}
        <div className="grid h-[calc(100dvh-16.5rem)] min-h-[22rem] gap-4 md:h-[calc(100svh-14rem)] md:min-h-[28rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card className={cn('min-h-0 gap-0 overflow-y-auto p-2', sessionId && 'hidden lg:flex')}>{sessions.data ? <SessionList sessions={sessions.data} selected={sessionId} onSelect={onSelect} /> : <Skeleton className="h-40" />}</Card>
          <Card className={cn('min-h-0 gap-0 overflow-hidden py-0', !sessionId && 'hidden lg:flex')}>
            {sessionId ? (
              <ChatPanel key={sessionId} sessionId={sessionId} allowBypass={health.data.allowBypass} onOpenSession={onSelect} />
            ) : (
              <div className="grid h-full place-items-center">
                <EmptyState
                  title={`Start a ${id === 'codex' ? 'Codex' : 'Claude Code'} session`}
                  description="Pick a working directory and a permission mode. You can switch modes any time, just like in the terminal."
                  action={
                    <Button onClick={() => setNewOpen(true)}>
                      <Mark mono label={null} className="size-4" />
                      New session
                    </Button>
                  }
                />
              </div>
            )}
          </Card>
        </div>
      </PageBody>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} defaultCwd={health.data.defaultCwd} creating={create.isPending} onCreate={(b) => create.mutate(b)} />
    </>
  )
}
