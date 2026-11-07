import { randomUUID } from 'node:crypto'
import {
  isCodexMode,
  isLiveOnly,
  type AgentEvent,
  type Capabilities,
  type CodexMode,
  type ContextUsage,
  type EventEnvelope,
  type HostMode,
  type ImageAttachment,
  type McpActionBody,
  type McpServerInfo,
  type PermissionDecisionBody,
  type PlanUsage,
  type PluginActionBody,
  type PluginInfo,
  type RewindResult,
  type SessionState,
  type SessionSummary,
} from '../../src/agent/protocol.ts'
import { UnsupportedError, type HostSession, type SessionHooks } from '../agent/host-session.ts'
import type { CodexHost, ThreadListener } from './host.ts'
import { toCapabilities, toContextUsage, toMcpServers, toPlanUsage, toPlugins } from './info.ts'
import { normalizeCodex, type CodexNormalizeContext } from './normalize.ts'
import type { Account, AskForApproval, McpServerStatus, Model, PluginMarketplaceEntry, RateLimitSnapshot, SandboxMode, SandboxPolicy, SkillMetadata, ThreadStartResponse, ThreadTokenUsage, Turn, UserInput, UserInputQuestion } from './types.ts'

export interface CodexSessionDeps extends SessionHooks {
  host: CodexHost
  /** offer `full-access` (opt-in per host, like Claude's bypass mode) */
  allowBypass?: boolean
  model?: string
}

interface Pending {
  kind: 'command' | 'fileChange' | 'userInput'
  resolve: (r: unknown) => void
  questions?: UserInputQuestion[]
}

/** How each SparkMan Codex mode maps onto Codex's sandbox + approval policy. */
export const MODE_POLICY: Record<CodexMode, { sandbox: SandboxMode; approval: AskForApproval; policy: SandboxPolicy }> = {
  'read-only': { sandbox: 'read-only', approval: 'on-request', policy: { type: 'readOnly', networkAccess: false } },
  auto: { sandbox: 'workspace-write', approval: 'on-request', policy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  untrusted: { sandbox: 'workspace-write', approval: 'untrusted', policy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } },
  'full-access': { sandbox: 'danger-full-access', approval: 'never', policy: { type: 'dangerFullAccess' } },
}

/** A Codex thread on the host, driven through the shared app-server, speaking SparkMan's event protocol. */
export class CodexSession implements HostSession, ThreadListener {
  readonly summary: SessionSummary
  private readonly deps: CodexSessionDeps
  private readonly events: EventEnvelope[]
  private seq: number
  private listeners = new Set<(env: EventEnvelope) => void>()
  private pending = new Map<string, Pending>()
  /** messages waiting for the current turn to finish (Codex runs one turn at a time) */
  private queue: { text: string; images: ImageAttachment[]; uuid: string }[] = []
  private turnId: string | null = null
  private turnStarting = false
  /** serialises thread start and turn start */
  private ops: Promise<unknown> = Promise.resolve()
  private ctx: CodexNormalizeContext = { items: new Map(), started: new Set(), planToolUseId: null, turnTokens: 0 }
  private tokenUsage: ThreadTokenUsage | null = null
  private closing = false

  constructor(summary: SessionSummary, events: EventEnvelope[], deps: CodexSessionDeps) {
    this.summary = summary
    this.events = events
    this.deps = deps
    this.seq = events.at(-1)?.seq ?? 0
    if (!isCodexMode(summary.mode) || (summary.mode === 'full-access' && deps.allowBypass !== true)) summary.mode = 'auto'
  }

  get id(): string {
    return this.summary.id
  }

  private get mode(): CodexMode {
    return isCodexMode(this.summary.mode) ? this.summary.mode : 'auto'
  }

  subscribe(fn: (env: EventEnvelope) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

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
    this.queue.push({ text: trimmed, images, uuid })
    this.setState('running')
    this.pumpQueue()
  }

  decide(requestId: string, body: PermissionDecisionBody): boolean {
    const p = this.pending.get(requestId)
    if (!p) return false
    this.pending.delete(requestId)
    this.emit({ kind: 'permission_resolved', requestId, behavior: body.behavior })
    if (p.kind === 'userInput') {
      const given = (body.behavior === 'allow' ? (body.updatedInput?.answers as Record<string, string> | undefined) : undefined) ?? {}
      const answers: Record<string, { answers: string[] }> = {}
      for (const q of p.questions ?? []) {
        const a = given[q.question]
        if (a) answers[q.id] = { answers: a.split(', ').filter(Boolean) }
      }
      p.resolve({ answers })
    } else {
      p.resolve({ decision: body.behavior === 'allow' ? (body.forSession ? 'acceptForSession' : 'accept') : 'decline' })
    }
    return true
  }

  async setMode(mode: HostMode): Promise<void> {
    if (!isCodexMode(mode)) throw new Error(`Unknown Codex mode: ${mode}`)
    if (mode === 'full-access' && this.deps.allowBypass !== true) throw new Error('Full access is disabled on this host')
    // applies from the next turn (Codex takes sandbox and approval policy per turn)
    this.summary.mode = mode
    this.emit({ kind: 'mode', mode })
    this.changed()
  }

  async setModel(model: string): Promise<void> {
    this.summary.model = model
    this.emit({ kind: 'model', model })
    this.changed()
  }

  async setShowThinking(enabled: boolean): Promise<void> {
    this.summary.showThinking = enabled
    this.emit({ kind: 'show_thinking', enabled })
    this.changed()
  }

  async interrupt(): Promise<void> {
    // queued messages are dropped too: Stop means stop
    if (this.queue.length) this.emit({ kind: 'notice', level: 'info', source: 'codex', text: `Dropped ${this.queue.length} queued message${this.queue.length === 1 ? '' : 's'}.` })
    this.queue = []
    this.denyAllPending()
    const threadId = this.summary.threadId
    if (threadId && this.turnId) await this.deps.host.request('turn/interrupt', { threadId, turnId: this.turnId })
    else if (!this.turnStarting) this.setState('idle')
  }

  async capabilities(): Promise<Capabilities> {
    const [models, account, skills] = await Promise.all([
      this.deps.host.request<{ data: Model[] }>('model/list', {}),
      this.deps.host.request<{ account: Account | null }>('account/read', {}).catch(() => ({ account: null })),
      this.listSkills(false).catch(() => [] as SkillMetadata[]),
    ])
    return toCapabilities(models.data, account.account, skills)
  }

  async mcpServers(): Promise<McpServerInfo[]> {
    const r = await this.deps.host.request<{ data: McpServerStatus[] }>('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', ...(this.summary.threadId ? { threadId: this.summary.threadId } : {}) })
    return toMcpServers(r.data)
  }

  async mcpAction(_name: string, action: McpActionBody['action']): Promise<void> {
    if (action !== 'reconnect') throw new UnsupportedError('Turning MCP servers on and off')
    await this.deps.host.request('config/mcpServer/reload', {})
  }

  async context(): Promise<ContextUsage> {
    return toContextUsage(this.tokenUsage, this.summary.model ?? 'codex')
  }

  async planUsage(): Promise<PlanUsage> {
    try {
      const r = await this.deps.host.request<{ rateLimits: RateLimitSnapshot }>('account/rateLimits/read', {})
      return toPlanUsage(r.rateLimits)
    } catch {
      return { available: false, subscriptionType: null, windows: [] }
    }
  }

  async reloadSkills(): Promise<string[]> {
    return (await this.listSkills(true)).map((s) => s.name)
  }

  async stopTask(): Promise<void> {
    throw new UnsupportedError('Stopping background tasks')
  }

  async rewind(): Promise<RewindResult> {
    throw new UnsupportedError('Rewinding files')
  }

  async plugins(): Promise<PluginInfo[]> {
    const r = await this.deps.host.request<{ marketplaces: PluginMarketplaceEntry[] }>('plugin/list', {})
    return toPlugins(r.marketplaces)
  }

  async pluginAction(id: string, action: PluginActionBody['action']): Promise<void> {
    if (action === 'uninstall') {
      await this.deps.host.request('plugin/uninstall', { pluginId: id })
      return
    }
    const { marketplaces } = await this.deps.host.request<{ marketplaces: PluginMarketplaceEntry[] }>('plugin/list', {})
    const market = marketplaces.find((m) => m.plugins.some((p) => p.id === id))
    const plugin = market?.plugins.find((p) => p.id === id)
    if (!market || !plugin) throw new Error(`Unknown plugin: ${id}`)
    await this.deps.host.request('plugin/install', { pluginName: plugin.name, ...(market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: market.name }) })
  }

  close(): void {
    this.closing = true
    this.denyAllPending()
    if (this.summary.threadId) this.deps.host.detach(this.summary.threadId)
  }

  // ---- app-server traffic for this thread ----

  onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'thread/tokenUsage/updated') {
      this.tokenUsage = params.tokenUsage as ThreadTokenUsage
      this.ctx.turnTokens = this.tokenUsage.total.totalTokens
    }
    if (method === 'turn/started') {
      this.turnId = (params.turn as Turn).id
      this.turnStarting = false
    }
    for (const ev of normalizeCodex(method, params, this.ctx)) this.emit(ev)
    if (method === 'turn/completed') {
      this.turnId = null
      this.denyAllPending()
      if (this.queue.length) this.pumpQueue()
      else this.setState('idle')
    }
  }

  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const requestId = randomUUID()
    const itemId = String(params.itemId ?? requestId)
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    return new Promise((resolve) => {
      if (method === 'item/commandExecution/requestApproval') {
        this.pending.set(requestId, { kind: 'command', resolve })
        const input = { command: params.command ?? this.commandFor(itemId), ...(params.cwd ? { cwd: params.cwd } : {}) }
        this.emit({ kind: 'permission_request', requestId, toolUseId: itemId, toolName: 'Shell', input, ...(reason ? { reason } : {}) })
      } else if (method === 'item/fileChange/requestApproval') {
        this.pending.set(requestId, { kind: 'fileChange', resolve })
        const item = this.ctx.items.get(itemId)
        const changes = item && item.type === 'fileChange' && 'changes' in item ? item.changes : []
        this.emit({ kind: 'permission_request', requestId, toolUseId: itemId, toolName: 'ApplyPatch', input: { changes, ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) }, ...(reason ? { reason } : {}) })
      } else if (method === 'item/tool/requestUserInput') {
        const questions = (params.questions as UserInputQuestion[]) ?? []
        this.pending.set(requestId, { kind: 'userInput', resolve, questions })
        const input = { questions: questions.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options ?? [] })) }
        this.emit({ kind: 'permission_request', requestId, toolUseId: itemId, toolName: 'AskUserQuestion', input })
      } else {
        // permission-profile and MCP elicitation requests aren't supported from the browser yet
        this.emit({ kind: 'notice', level: 'warning', source: 'codex', text: `Codex asked for ${method}, which SparkMan can’t answer yet — declined.` })
        resolve(method === 'mcpServer/elicitation/request' ? { action: 'decline' } : { decision: 'decline' })
      }
    })
  }

  private commandFor(itemId: string): string {
    const item = this.ctx.items.get(itemId)
    return item && item.type === 'commandExecution' && 'command' in item ? item.command : ''
  }

  // ---- turn plumbing ----

  private pumpQueue(): void {
    if (this.turnId || this.turnStarting || this.queue.length === 0) return
    const next = this.queue.shift()!
    this.turnStarting = true
    this.ops = this.ops
      .then(() => this.startTurn(next))
      .catch((err: unknown) => {
        this.turnStarting = false
        if (!this.closing) this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
        if (this.queue.length) this.pumpQueue()
        else this.setState('idle')
      })
  }

  private async ensureThread(): Promise<string> {
    const { host } = this.deps
    const policy = MODE_POLICY[this.mode]
    const threadId = this.summary.threadId
    if (threadId && host.isLoaded(threadId)) return threadId
    const base = { cwd: this.summary.cwd, approvalPolicy: policy.approval, sandbox: policy.sandbox }
    const res = threadId
      ? await host.request<ThreadStartResponse>('thread/resume', { threadId, ...base })
      : await host.request<ThreadStartResponse>('thread/start', { ...base, ...(this.summary.model ?? this.deps.model ? { model: this.summary.model ?? this.deps.model } : {}) })
    const id = res.thread.id
    host.attach(id, this)
    if (this.summary.threadId !== id) {
      this.summary.threadId = id
      this.changed()
    }
    this.summary.model = this.summary.model ?? res.model
    this.emit({ kind: 'session', cwd: res.cwd ?? this.summary.cwd, model: res.model, mode: this.mode, version: host.version })
    return id
  }

  private async startTurn(msg: { text: string; images: ImageAttachment[]; uuid: string }): Promise<void> {
    const threadId = await this.ensureThread()
    const policy = MODE_POLICY[this.mode]
    const input: UserInput[] = [
      ...msg.images.map((i): UserInput => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` })),
      ...(msg.text ? [{ type: 'text' as const, text: msg.text, text_elements: [] as [] }] : []),
    ]
    this.ctx.planToolUseId = null
    const res = await this.deps.host.request<{ turn: Turn }>('turn/start', {
      threadId,
      input,
      clientUserMessageId: msg.uuid,
      approvalPolicy: policy.approval,
      sandboxPolicy: policy.policy,
      summary: this.summary.showThinking ? 'auto' : 'none',
      ...(this.summary.model ? { model: this.summary.model } : {}),
      ...(this.summary.options.effort ? { effort: this.summary.options.effort } : {}),
    })
    this.turnId = res.turn.id
    this.turnStarting = false
  }

  private async listSkills(forceReload: boolean): Promise<SkillMetadata[]> {
    const r = await this.deps.host.request<{ data: { skills: SkillMetadata[] }[] }>('skills/list', { cwds: [this.summary.cwd], forceReload })
    return r.data.flatMap((e) => e.skills).filter((s) => s.enabled)
  }

  private denyAllPending(): void {
    for (const [requestId, p] of this.pending) {
      this.emit({ kind: 'permission_resolved', requestId, behavior: 'deny' })
      p.resolve(p.kind === 'userInput' ? { answers: {} } : { decision: 'cancel' })
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
    if (!this.closing) this.deps.onChange(this.summary)
  }

  private emit(event: AgentEvent): void {
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

