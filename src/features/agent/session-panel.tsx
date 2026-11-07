import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, Download, Package, Plug, RefreshCw, Sparkles, Square, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { Capabilities, McpServerInfo, PluginInfo } from '@/agent/protocol'
import { latestTodos, type SessionView, type TaskInfo } from '@/agent/reduce-events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useProvider } from './providers'
import { TodoList } from './tool-card'

const onError = (e: Error) => toast.error(e.message)

const MCP_STATUS: Record<McpServerInfo['status'], string> = {
  connected: 'text-brand',
  pending: 'text-level-info',
  failed: 'text-level-error',
  'needs-auth': 'text-level-warn',
  disabled: 'text-muted-foreground',
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  )
}

function Overview({ sessionId, view, caps }: { sessionId: string; view: SessionView; caps?: Capabilities }) {
  const { api, id } = useProvider()
  const usage = useQuery({ queryKey: [id, sessionId, 'usage'], queryFn: () => api.usage(sessionId), retry: false, staleTime: 60_000 })
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Session</h3>
        <Row label="Directory">
          <span className="font-mono text-xs">{view.cwd}</span>
        </Row>
        <Row label="Model">
          <span className="font-mono text-xs">{view.model ?? '—'}</span>
        </Row>
        {view.version && <Row label="Claude Code">{view.version}</Row>}
        {caps?.outputStyle && <Row label="Output style">{caps.outputStyle}</Row>}
      </section>
      <section>
        <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Account</h3>
        {caps ? (
          caps.account ? (
            <>
              {caps.account.email && <Row label="Signed in as">{caps.account.email}</Row>}
              {caps.account.organization && <Row label="Organization">{caps.account.organization}</Row>}
              {caps.account.subscriptionType && <Row label="Plan">{caps.account.subscriptionType}</Row>}
              {caps.account.apiProvider && <Row label="Provider">{caps.account.apiProvider}</Row>}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No account details reported.</p>
          )
        ) : (
          <Skeleton className="h-16" />
        )}
      </section>
      <section data-testid="plan-usage">
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Plan usage</h3>
        {usage.data ? (
          usage.data.available && usage.data.windows.length > 0 ? (
            <div className="space-y-3">
              {usage.data.windows.map((w) => (
                <div key={w.label} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="capitalize">{w.label}</span>
                    <span className="font-mono text-xs tabular-nums">{Math.round(w.utilization)}%</span>
                  </div>
                  <Progress value={w.utilization} className={cn(w.utilization > 85 && '[&>*]:bg-level-error', w.utilization > 65 && w.utilization <= 85 && '[&>*]:bg-level-warn')} />
                  {w.resetsAt && <div className="text-xs text-muted-foreground">resets {formatDateTime(w.resetsAt)}</div>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Plan limits don’t apply to this login (API key or cloud provider).</p>
          )
        ) : usage.isError ? (
          <p className="text-sm text-muted-foreground">{usage.error.message}</p>
        ) : (
          <Skeleton className="h-16" />
        )}
      </section>
    </div>
  )
}

function McpTab({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient()
  const { api, id } = useProvider()
  const key = [id, sessionId, 'mcp']
  const mcp = useQuery({ queryKey: key, queryFn: () => api.mcp(sessionId), retry: false })
  const act = useMutation({
    mutationFn: (v: { name: string; action: 'enable' | 'disable' | 'reconnect' }) => api.mcpAction(sessionId, v.name, v.action),
    onSuccess: (servers) => qc.setQueryData(key, servers),
    onError,
  })
  if (mcp.isPending) return <Skeleton className="h-32" />
  if (mcp.isError) return <p className="text-sm text-muted-foreground">{mcp.error.message}</p>
  if (mcp.data.length === 0) return <p className="text-sm text-muted-foreground">No MCP servers configured. Add them with <code className="font-mono">{id === 'codex' ? 'codex mcp add' : 'claude mcp add'}</code> on the host.</p>
  return (
    <ul className="space-y-2" data-testid="mcp-list">
      {mcp.data.map((s, i) => (
        <li key={s.name} className="enter-fade-up rounded-lg border p-3" style={{ '--i': i } as React.CSSProperties}>
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted-foreground" />
            <span className="font-medium">{s.name}</span>
            <span className={cn('text-xs', MCP_STATUS[s.status])}>{s.status}</span>
            {s.version && <span className="font-mono text-xs text-muted-foreground">v{s.version}</span>}
            <span className="ml-auto flex items-center gap-1">
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Reconnect ${s.name}`} disabled={act.isPending || s.status === 'disabled'} onClick={() => act.mutate({ name: s.name, action: 'reconnect' })}>
                <RefreshCw />
              </Button>
              {id === 'claude' && <Switch size="sm" checked={s.status !== 'disabled'} disabled={act.isPending} onCheckedChange={(on) => act.mutate({ name: s.name, action: on ? 'enable' : 'disable' })} aria-label={`Enable ${s.name}`} />}
            </span>
          </div>
          {s.error && <p className="mt-1 text-xs text-level-error">{s.error}</p>}
          {s.status === 'needs-auth' && <p className="mt-1 text-xs text-level-warn">Needs sign-in — run <code className="font-mono">{id === 'codex' ? `codex mcp login ${s.name}` : '/mcp'}</code> on the host to authenticate.</p>}
          {s.tools.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {s.tools.map((t) => (
                <Badge key={t.name} variant="outline" className="font-mono text-[11px]" title={t.description}>
                  {t.name}
                </Badge>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function AgentsSkillsTab({ sessionId, caps }: { sessionId: string; caps?: Capabilities }) {
  const qc = useQueryClient()
  const { api, id } = useProvider()
  const reload = useMutation({
    mutationFn: () => api.reloadSkills(sessionId),
    onSuccess: (r) => {
      toast.success(`Reloaded ${r.skills.length} skill${r.skills.length === 1 ? '' : 's'}`)
      void qc.invalidateQueries({ queryKey: [id, sessionId, 'caps'] })
    },
    onError,
  })
  if (!caps) return <Skeleton className="h-32" />
  const skillCommands = caps.commands.filter((c) => caps.skills.includes(c.name))
  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Skills</h3>
          <Button size="sm" variant="outline" className="h-7" onClick={() => reload.mutate()} disabled={reload.isPending}>
            <RefreshCw className={cn(reload.isPending && 'motion-safe:animate-spin')} />
            Reload
          </Button>
        </div>
        {caps.skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No skills found.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="skills-list">
            {caps.skills.map((name) => (
              <li key={name} className="flex items-start gap-2 text-sm">
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-claude" />
                <span className="font-mono">/{name}</span>
                <span className="truncate text-xs text-muted-foreground">{skillCommands.find((c) => c.name === name)?.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Subagents</h3>
        <ul className="space-y-2" data-testid="agents-list">
          {caps.agents.map((a) => (
            <li key={a.name} className="text-sm">
              <div className="flex items-center gap-2">
                <Bot className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{a.name}</span>
                {a.model && <Badge variant="outline" className="font-mono text-[11px]">{a.model}</Badge>}
              </div>
              <p className="ml-5.5 text-xs text-muted-foreground">{a.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

const TASK_CLS: Record<TaskInfo['status'], string> = { running: 'text-level-info', completed: 'text-brand', failed: 'text-level-error', stopped: 'text-muted-foreground' }

function TasksTab({ sessionId, view }: { sessionId: string; view: SessionView }) {
  const { api, features } = useProvider()
  const stop = useMutation({ mutationFn: (taskId: string) => api.stopTask(sessionId, taskId), onError })
  const todos = latestTodos(view.items)
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Todos</h3>
        {todos.length ? <TodoList todos={todos} /> : <p className="text-sm text-muted-foreground">No todo list or plan in this session yet.</p>}
      </section>
      {features.tasks && (
      <section>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Background tasks</h3>
        {view.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No subagents or background tasks yet.</p>
        ) : (
          <ul className="space-y-2" data-testid="tasks-list">
            {[...view.tasks].reverse().map((t) => (
              <li key={t.taskId} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center gap-2">
                  <Bot className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium">{t.description}</span>
                  <span className={cn('text-xs', TASK_CLS[t.status])}>{t.status}</span>
                  {t.status === 'running' && (
                    <Button size="sm" variant="outline" className="h-6" onClick={() => stop.mutate(t.taskId)} disabled={stop.isPending}>
                      <Square />
                      Stop
                    </Button>
                  )}
                </div>
                {(t.summary || t.lastTool) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t.subagentType && <span className="mr-1 font-mono">{t.subagentType}</span>}
                    {t.summary}
                    {t.status === 'running' && t.lastTool && <span className="ml-1">· {t.lastTool}</span>}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  )
}

function PluginsTab({ sessionId }: { sessionId: string }) {
  const { api, id } = useProvider()
  const qc = useQueryClient()
  const key = [id, sessionId, 'plugins']
  const plugins = useQuery({ queryKey: key, queryFn: () => api.plugins(sessionId), retry: false })
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'install' | 'uninstall' }) => api.pluginAction(sessionId, v.id, v.action),
    onSuccess: (list, v) => {
      qc.setQueryData(key, list)
      void qc.invalidateQueries({ queryKey: [id, sessionId, 'caps'] })
      toast.success(`${v.action === 'install' ? 'Installed' : 'Removed'} ${list.find((p) => p.id === v.id)?.name ?? v.id}`)
    },
    onError,
  })
  if (plugins.isPending) return <Skeleton className="h-32" />
  if (plugins.isError) return <p className="text-sm text-muted-foreground">{plugins.error.message}</p>
  const byMarket = new Map<string, PluginInfo[]>()
  for (const p of plugins.data) byMarket.set(p.marketplace, [...(byMarket.get(p.marketplace) ?? []), p])
  return (
    <div className="space-y-5" data-testid="plugins-list">
      {[...byMarket].map(([market, list]) => (
        <section key={market}>
          <h3 className="mb-2 font-mono text-xs text-muted-foreground">{market}</h3>
          <ul className="space-y-2">
            {list.map((p, i) => (
              <li key={p.id} className="enter-fade-up flex items-start gap-3 rounded-lg border p-3" style={{ '--i': i } as React.CSSProperties} data-testid="plugin-item">
                <Package className={cn('mt-0.5 size-4 shrink-0', p.installed ? 'text-brand' : 'text-muted-foreground')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{p.name}</span>
                    {p.version && <span className="font-mono text-[11px] text-muted-foreground">v{p.version}</span>}
                    {p.installed && <Badge variant="outline" className="text-[10px] text-brand">installed</Badge>}
                  </div>
                  {p.description && <p className="text-xs text-muted-foreground">{p.description}</p>}
                </div>
                <Button
                  size="sm"
                  variant={p.installed ? 'ghost' : 'outline'}
                  className="h-7"
                  disabled={act.isPending}
                  onClick={() => act.mutate({ id: p.id, action: p.installed ? 'uninstall' : 'install' })}
                  aria-label={`${p.installed ? 'Uninstall' : 'Install'} ${p.name}`}
                >
                  {p.installed ? <Trash2 /> : <Download />}
                  {p.installed ? 'Remove' : 'Install'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

export function SessionPanel({ open, onOpenChange, sessionId, view, caps }: { open: boolean; onOpenChange: (o: boolean) => void; sessionId: string; view: SessionView; caps?: Capabilities }) {
  const { features, name } = useProvider()
  const running = view.tasks.filter((t) => t.status === 'running').length
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Session details</SheetTitle>
          <SheetDescription>What this {name} session can see and do.</SheetDescription>
        </SheetHeader>
        <Tabs defaultValue="overview" className="min-h-0 flex-1 px-4 pb-4">
          <TabsList className="w-full">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="skills">Skills</TabsTrigger>
            {features.plugins && <TabsTrigger value="plugins">Plugins</TabsTrigger>}
            <TabsTrigger value="tasks">
              {features.tasks ? 'Tasks' : 'Plan'}
              {running > 0 && <span className="ml-1 rounded-full bg-level-info/20 px-1.5 text-[10px] text-level-info">{running}</span>}
            </TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto pt-3">
            <TabsContent value="overview">
              <Overview sessionId={sessionId} view={view} caps={caps} />
            </TabsContent>
            <TabsContent value="mcp">
              <McpTab sessionId={sessionId} />
            </TabsContent>
            <TabsContent value="skills">
              <AgentsSkillsTab sessionId={sessionId} caps={caps} />
            </TabsContent>
            {features.plugins && (
              <TabsContent value="plugins">
                <PluginsTab sessionId={sessionId} />
              </TabsContent>
            )}
            <TabsContent value="tasks">
              <TasksTab sessionId={sessionId} view={view} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
