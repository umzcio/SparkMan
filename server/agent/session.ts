import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  isAgentMode,
  isLiveOnly,
  type AgentEvent,
  type HostMode,
  type PluginInfo,
  type Capabilities,
  type ContextUsage,
  type EventEnvelope,
  type ImageAttachment,
  type McpActionBody,
  type McpServerInfo,
  type PermissionDecisionBody,
  type PlanUsage,
  type RewindResult,
  type SessionState,
  type SessionSummary,
} from '../../src/agent/protocol.ts'
import { toCapabilities, toCommand, toContextUsage, toMcpServer, toPlanUsage, toRewind } from './info.ts'
import { UnsupportedError, type HostSession } from './host-session.ts'
import { InputQueue } from './input-queue.ts'
import { normalize, type NormalizeContext } from './normalize.ts'
import type { AgentQuery, QueryFn } from './types.ts'

export interface SessionDeps {
  queryFn: QueryFn
  model?: string
  /** pass allowDangerouslySkipPermissions to the SDK (bypass mode is opt-in per host) */
  allowBypass?: boolean
  now?: () => number
  /** close an idle Claude Code process after this long (default 10 min) */
  idleMs?: number
  /** persist one event (live-only events are never persisted) */
  persist: (sessionId: string, env: EventEnvelope) => void
  /** summary changed (title, state, mode, cost, model) */
  onChange: (summary: SessionSummary) => void
}

interface Pending {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
}

const DENIED_BY_OPERATOR = 'Denied by the operator in SparkMan.'
const FORK_REJECTED = 'Resume rejected'
const IDLE_MS = 10 * 60_000

export class AgentSession implements HostSession {
  readonly summary: SessionSummary
  private readonly deps: SessionDeps
  private readonly events: EventEnvelope[]
  private seq: number
  private listeners = new Set<(env: EventEnvelope) => void>()
  private queue: InputQueue<SDKUserMessage> | null = null
  private query: AgentQuery | null = null
  private pending = new Map<string, Pending>()
  /** true once an SDK transcript exists for this id (resume instead of starting fresh) */
  private resumable: boolean
  /** user messages sent whose turn has not produced a result yet (queued messages run back to back) */
  private outstandingTurns = 0
  /** SDK cost is cumulative per CLI process; carry earlier processes' spend forward */
  private costBaseline = 0
  private closing = false
  /** from the raw init message (not in initializationResult) */
  private initInfo: { skills: string[]; terminalCommands: string[] } = { skills: [], terminalCommands: [] }
  /** background tasks the current process reported as running */
  private runningTasks = new Map<string, string>()
  /** a user message went to the current process (errors from read-only starts aren't persisted) */
  private sentToProcess = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(summary: SessionSummary, events: EventEnvelope[], deps: SessionDeps, resumable: boolean) {
    this.summary = summary
    this.events = events
    this.deps = deps
    this.seq = events.at(-1)?.seq ?? 0
    this.resumable = resumable
    // bypass is opt-in per host: a session saved in bypass on a host that no longer allows it starts in default
    if (summary.mode === 'bypassPermissions' && deps.allowBypass !== true) summary.mode = 'default'
    // tasks left running by a process that is gone (server restart) can't be stopped or resumed
    const running = new Map<string, string>()
    for (const { event: e } of events) if (e.kind === 'task') e.status === 'running' ? running.set(e.taskId, e.description) : running.delete(e.taskId)
    for (const [taskId, description] of running) this.emit({ kind: 'task', taskId, status: 'stopped', description, summary: 'Claude Code process ended' })
  }

  get id(): string {
    return this.summary.id
  }

  subscribe(fn: (env: EventEnvelope) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Persisted events with seq > after (for replay / SSE catch-up). */
  eventsAfter(after: number): EventEnvelope[] {
    return this.events.filter((e) => e.seq > after)
  }

  allEvents(): EventEnvelope[] {
    return [...this.events]
  }

  send(text: string, images: ImageAttachment[] = []): void {
    const trimmed = text.trim()
    if (!trimmed && images.length === 0) throw new Error('Message is empty')
    if (this.summary.title === 'New session' && trimmed) this.summary.title = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed
    const uuid = randomUUID()
    this.emit({ kind: 'user', text: trimmed, uuid, ...(images.length ? { images: images.length } : {}) })
    this.ensureLive()
    this.sentToProcess = true
    this.clearIdleTimer()
    this.outstandingTurns += 1
    this.setState('running')
    const content = images.length
      ? [
          ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
          ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
        ]
      : trimmed
    this.queue!.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null })
  }

  decide(requestId: string, body: PermissionDecisionBody): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    this.emit({ kind: 'permission_resolved', requestId, behavior: body.behavior })
    p.resolve(
      body.behavior === 'allow'
        ? {
            behavior: 'allow',
            updatedInput: body.updatedInput ?? p.input,
            // switch mode as part of the decision so it can't race the CLI's own mode change (plan approval)
            ...(body.mode ? { updatedPermissions: [{ type: 'setMode', mode: body.mode, destination: 'session' }] } : {}),
          }
        : { behavior: 'deny', message: body.message?.trim() || DENIED_BY_OPERATOR },
    )
    if (body.mode && body.behavior === 'allow') {
      this.summary.mode = body.mode
      this.emit({ kind: 'mode', mode: body.mode })
      this.changed()
    }
    return true
  }

  async setMode(mode: HostMode): Promise<void> {
    if (!isAgentMode(mode)) throw new Error(`Unknown permission mode: ${mode}`)
    if (this.query) await this.query.setPermissionMode(mode)
    this.summary.mode = mode
    this.emit({ kind: 'mode', mode })
    this.changed()
  }

  async setModel(model: string): Promise<void> {
    if (this.query) await this.query.setModel(model)
    this.summary.model = model
    this.emit({ kind: 'model', model })
    this.changed()
  }

  async setShowThinking(enabled: boolean): Promise<void> {
    if (this.query) await this.query.setMaxThinkingTokens(null, enabled ? 'summarized' : 'omitted')
    this.summary.showThinking = enabled
    this.emit({ kind: 'show_thinking', enabled })
    this.changed()
  }

  async interrupt(): Promise<void> {
    this.denyAllPending('Interrupted by the operator.')
    if (this.query) await this.query.interrupt()
  }

  // ---- control-API pass-throughs (these start the Claude Code process if it is not running) ----

  async capabilities(): Promise<Capabilities> {
    const q = this.ensureLive()
    const [init, commands] = await Promise.all([q.initializationResult(), q.supportedCommands().catch(() => undefined)])
    return toCapabilities(init, { ...this.initInfo, ...(commands ? { commands } : {}) })
  }

  async mcpServers(): Promise<McpServerInfo[]> {
    return (await this.ensureLive().mcpServerStatus()).map(toMcpServer)
  }

  async mcpAction(name: string, action: McpActionBody['action']): Promise<void> {
    const q = this.ensureLive()
    if (action === 'reconnect') await q.reconnectMcpServer(name)
    else await q.toggleMcpServer(name, action === 'enable')
  }

  async context(): Promise<ContextUsage> {
    return toContextUsage(await this.ensureLive().getContextUsage({ detail: 'summary' }))
  }

  async planUsage(): Promise<PlanUsage> {
    try {
      return toPlanUsage(await this.ensureLive().usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
    } catch {
      // experimental API: treat any failure as "not available"
      return { available: false, subscriptionType: null, windows: [] }
    }
  }

  async reloadSkills(): Promise<string[]> {
    const { skills } = await this.ensureLive().reloadSkills()
    this.initInfo.skills = skills.map((s) => toCommand(s).name)
    return this.initInfo.skills
  }

  async stopTask(taskId: string): Promise<void> {
    await this.ensureLive().stopTask(taskId)
  }

  async rewind(userUuid: string, dryRun: boolean): Promise<RewindResult> {
    const result = toRewind(await this.ensureLive().rewindFiles(userUuid, { dryRun }))
    if (!dryRun && result.canRewind && !result.error) this.emit({ kind: 'rewound', userUuid, filesChanged: result.filesChanged })
    return result
  }

  async plugins(): Promise<PluginInfo[]> {
    throw new UnsupportedError('Plugin management')
  }

  async pluginAction(): Promise<void> {
    throw new UnsupportedError('Plugin management')
  }

  close(): void {
    this.closing = true
    this.clearIdleTimer()
    this.denyAllPending('Session closed.')
    this.query?.close()
    this.queue?.close()
  }

  /** The running query, starting the Claude Code process first if needed. */
  private ensureLive(): AgentQuery {
    if (this.query) {
      if (this.summary.state === 'idle') this.scheduleIdleClose()
      return this.query
    }
    if (this.summary.mode === 'bypassPermissions' && this.deps.allowBypass !== true) {
      this.summary.mode = 'default'
      this.emit({ kind: 'mode', mode: 'default' })
    }
    this.sentToProcess = false
    this.queue = new InputQueue<SDKUserMessage>()
    this.costBaseline = this.summary.costUsd
    const { options } = this.summary
    const fork = this.summary.forkAt && this.summary.forkedFrom ? { resume: this.summary.forkedFrom, forkSession: true, sessionId: this.id, resumeSessionAt: this.summary.forkAt } : null
    const model = this.summary.model ?? this.deps.model
    const query = this.deps.queryFn({
      prompt: this.queue,
      options: {
        cwd: this.summary.cwd,
        permissionMode: isAgentMode(this.summary.mode) ? this.summary.mode : 'default',
        allowDangerouslySkipPermissions: this.deps.allowBypass === true,
        includePartialMessages: true,
        promptSuggestions: true,
        enableFileCheckpointing: true,
        thinking: { type: 'adaptive', display: this.summary.showThinking ? 'summarized' : 'omitted' },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        canUseTool: this.canUseTool,
        ...(model ? { model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.maxBudgetUsd ? { maxBudgetUsd: options.maxBudgetUsd } : {}),
        ...(options.additionalDirectories?.length ? { additionalDirectories: options.additionalDirectories } : {}),
        ...(fork ?? (this.resumable ? { resume: this.id } : { sessionId: this.id })),
      },
    })
    this.query = query
    void this.pump(query)
    this.scheduleIdleClose()
    return query
  }

  /** Close the Claude Code process once it has sat idle (it is restarted on demand). */
  private scheduleIdleClose(): void {
    this.clearIdleTimer()
    const timer = setTimeout(() => {
      if (this.idleTimer !== timer || !this.query || this.summary.state !== 'idle' || this.pending.size > 0 || this.runningTasks.size > 0) return
      this.idleTimer = null
      // ending the input stream lets the CLI exit cleanly; pump's finally clears the query
      this.queue?.close()
      this.query.close()
    }, this.deps.idleMs ?? IDLE_MS)
    timer.unref?.()
    this.idleTimer = timer
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  private captureInit(msg: SDKMessage): void {
    if (msg.type !== 'system' || msg.subtype !== 'init') return
    this.initInfo = { skills: msg.skills ?? [], terminalCommands: msg.terminal_slash_commands ?? [] }
  }

  private async pump(query: AgentQuery): Promise<void> {
    const ctx: NormalizeContext = { messageId: '', lastAssistantUuid: '' }
    try {
      for await (const msg of query) {
        this.captureInit(msg)
        for (const ev of normalize(msg, ctx)) {
          if (ev.kind === 'session') {
            this.summary.model = ev.model
            this.summary.mode = ev.mode === 'bypassPermissions' && this.deps.allowBypass !== true ? 'default' : ev.mode
            this.resumable = true
            if (this.summary.forkAt) {
              delete this.summary.forkAt
              this.changed()
            }
          }
          if (ev.kind === 'error' && ev.message.startsWith(FORK_REJECTED) && this.summary.forkAt) {
            // deterministic refusal: drop the fork point so the next attempt resumes plainly
            delete this.summary.forkAt
            this.changed()
          }
          if (ev.kind === 'task') {
            if (ev.status === 'running') this.runningTasks.set(ev.taskId, ev.description || this.runningTasks.get(ev.taskId) || '')
            else this.runningTasks.delete(ev.taskId)
          }
          if (ev.kind === 'turn_end') {
            ev.costUsd = this.costBaseline + ev.costUsd
            this.summary.costUsd = ev.costUsd
          }
          this.emit(ev)
          if (ev.kind === 'turn_end') {
            this.outstandingTurns = Math.max(0, this.outstandingTurns - 1)
            if (this.outstandingTurns === 0) {
              this.setState('idle')
              this.scheduleIdleClose()
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // a process started only to answer a read-only request (capabilities, context…) shouldn't litter the transcript
      if (!this.closing && this.sentToProcess) this.emit({ kind: 'error', message })
      else if (!this.closing) console.warn(`[agent ${this.id}] ${message}`)
    } finally {
      if (this.query === query) {
        this.query = null
        this.queue = null
        this.clearIdleTimer()
      }
      for (const [taskId, description] of this.runningTasks) this.emit({ kind: 'task', taskId, status: 'stopped', description, summary: 'Claude Code process ended' })
      this.runningTasks.clear()
      this.denyAllPending('Claude Code process ended.')
      this.outstandingTurns = 0
      this.setState('idle')
    }
  }

  private canUseTool: CanUseTool = (toolName, input, { signal, toolUseID, decisionReason }) =>
    new Promise<PermissionResult>((resolve) => {
      if (signal.aborted) {
        resolve({ behavior: 'deny', message: 'Request cancelled.' })
        return
      }
      const requestId = randomUUID()
      const onAbort = () => {
        if (!this.pending.delete(requestId)) return
        this.emit({ kind: 'permission_resolved', requestId, behavior: 'deny' })
        resolve({ behavior: 'deny', message: 'Request cancelled.' })
      }
      this.pending.set(requestId, {
        input,
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort)
          resolve(r)
        },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ kind: 'permission_request', requestId, toolUseId: toolUseID, toolName, input, ...(decisionReason ? { reason: decisionReason } : {}) })
    })

  private denyAllPending(message: string): void {
    for (const [requestId, p] of this.pending) {
      this.emit({ kind: 'permission_resolved', requestId, behavior: 'deny' })
      p.resolve({ behavior: 'deny', message })
    }
    this.pending.clear()
  }

  private setState(state: SessionState): void {
    if (this.summary.state === state) return
    this.summary.state = state
    this.emit({ kind: 'status', state })
    this.changed()
  }

  private changed(): void {
    // once closing, the store has already saved the index (and may be gone, in tests)
    if (!this.closing) this.deps.onChange(this.summary)
  }

  private emit(event: AgentEvent): void {
    // Live-only events (text deltas, tool timers, suggestions) reuse the current seq instead of consuming
    // one, so seq always equals the last persisted event and a restarted server never hands out numbers
    // clients have seen.
    const ts = (this.deps.now ?? Date.now)()
    const live = isLiveOnly(event)
    const env: EventEnvelope = { seq: live ? this.seq : ++this.seq, ts, event }
    if (!live && !this.closing) {
      this.events.push(env)
      this.deps.persist(this.id, env)
      this.summary.updatedAt = env.ts
    }
    for (const fn of this.listeners) fn(env)
  }
}
