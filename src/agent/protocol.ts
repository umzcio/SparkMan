// Wire protocol between the SparkMan host agent server and the UI.
// Kept free of SDK imports so the browser bundle never pulls in the Agent SDK.

export type AgentMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk' | 'bypassPermissions'

export const AGENT_MODES: { value: AgentMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Default', hint: 'Ask before edits and commands' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Auto-approve file edits; ask for commands' },
  { value: 'plan', label: 'Plan', hint: 'Explore and plan; no changes' },
  { value: 'auto', label: 'Auto', hint: 'A classifier approves routine actions' },
  { value: 'dontAsk', label: "Don't ask", hint: 'Deny anything not pre-approved' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'No permission checks at all' },
]

/** Codex approval presets: a sandbox plus an approval policy (mapped in server/codex). */
export type CodexMode = 'read-only' | 'auto' | 'untrusted' | 'full-access'

export const CODEX_MODES: { value: CodexMode; label: string; hint: string }[] = [
  { value: 'read-only', label: 'Read only', hint: 'Read files; ask before any change or network use' },
  { value: 'auto', label: 'Auto', hint: 'Edit and run in the workspace; ask for anything outside it' },
  { value: 'untrusted', label: 'Ask every time', hint: 'Ask before running any command that isn’t read-only' },
  { value: 'full-access', label: 'Full access', hint: 'No sandbox, no approvals' },
]

export const isCodexMode = (v: unknown): v is CodexMode => CODEX_MODES.some((m) => m.value === v)

/** Either agent's permission mode. */
export type HostMode = AgentMode | CodexMode

export type SessionState = 'idle' | 'running'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Fixed at session start (the SDK only takes these when the Claude Code process launches). */
export interface SessionOptions {
  effort?: Effort
  maxBudgetUsd?: number
  additionalDirectories?: string[]
}

export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** base64, no data: prefix */
  data: string
}

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped'
export type NoticeLevel = 'info' | 'warning' | 'error'

export type AgentEvent =
  | { kind: 'session'; cwd: string; model: string; mode: HostMode; version: string }
  | { kind: 'user'; text: string; uuid?: string; images?: number }
  | { kind: 'text_delta'; messageId: string; text: string }
  | { kind: 'assistant_text'; messageId: string; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { kind: 'permission_request'; requestId: string; toolUseId: string; toolName: string; input: Record<string, unknown>; reason?: string }
  | { kind: 'permission_resolved'; requestId: string; behavior: 'allow' | 'deny' }
  | { kind: 'mode'; mode: HostMode }
  | { kind: 'status'; state: SessionState }
  | { kind: 'turn_end'; costUsd: number; durationMs: number; isError: boolean; numTurns: number; /** Codex: tokens used by the thread so far (no dollar cost on a ChatGPT plan) */ tokens?: number }
  | { kind: 'error'; message: string }
  | { kind: 'thinking'; messageId: string; text: string }
  | { kind: 'tool_progress'; toolUseId: string; elapsedSeconds: number }
  | { kind: 'task'; taskId: string; status: TaskStatus; description: string; summary?: string; subagentType?: string; lastTool?: string; toolUseId?: string }
  | { kind: 'notice'; level: NoticeLevel; source: string; text: string }
  | { kind: 'command_output'; text: string }
  | { kind: 'suggestion'; text: string }
  | { kind: 'commands_changed' }
  | { kind: 'model'; model: string }
  | { kind: 'show_thinking'; enabled: boolean }
  | { kind: 'checkpoint'; assistantUuid: string }
  | { kind: 'rewound'; userUuid: string; filesChanged: string[] }

/** Live-only events reuse the current seq, are never persisted, and are never deduped by seq. */
export const isLiveOnly = (e: AgentEvent): boolean =>
  e.kind === 'text_delta' || e.kind === 'tool_progress' || e.kind === 'suggestion' || e.kind === 'commands_changed'

export interface EventEnvelope {
  seq: number
  ts: number
  event: AgentEvent
}

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  model: string | null
  mode: HostMode
  state: SessionState
  createdAt: number
  updatedAt: number
  costUsd: number
  showThinking: boolean
  options: SessionOptions
  /** set on forks: the session this one branched from */
  forkedFrom?: string
  /** set on forks until their first turn starts: the parent assistant message uuid to resume at */
  forkAt?: string
  /** Codex: the app-server thread this session drives */
  threadId?: string
}

export interface SessionDetail {
  session: SessionSummary
  events: EventEnvelope[]
}

export interface CreateSessionBody {
  cwd?: string
  mode?: HostMode
  options?: SessionOptions
}

export interface SendMessageBody {
  text: string
  images?: ImageAttachment[]
}

export interface PermissionDecisionBody {
  behavior: 'allow' | 'deny'
  message?: string
  /** replaces the tool input on allow (AskUserQuestion answers) */
  updatedInput?: Record<string, unknown>
  /** switch permission mode as part of the decision (plan approval) */
  mode?: AgentMode
  /** Codex: approve this and similar requests for the rest of the session */
  forSession?: boolean
}

// ---- capabilities & live info (pass-throughs of the Agent SDK control API) ----

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint: string
  aliases?: string[]
  builtin?: boolean
}

export interface ModelOption {
  value: string
  displayName: string
  description: string
  supportedEffortLevels?: Effort[]
}

export interface AgentDef {
  name: string
  description: string
  model?: string
}

export interface AccountSummary {
  email?: string
  organization?: string
  subscriptionType?: string
  apiProvider?: string
}

export interface Capabilities {
  commands: SlashCommandInfo[]
  /** commands that only make sense in a terminal (hidden in the menu) */
  terminalCommands: string[]
  skills: string[]
  models: ModelOption[]
  agents: AgentDef[]
  account: AccountSummary | null
  outputStyle: string | null
}

export interface McpServerInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  error?: string
  scope?: string
  version?: string
  tools: { name: string; description?: string; readOnly?: boolean; destructive?: boolean }[]
}

export interface ContextUsage {
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: { name: string; tokens: number; color: string }[]
  memoryFiles: { path: string; tokens: number }[]
  mcpTools: { name: string; serverName: string; tokens: number }[]
}

export interface PlanUsage {
  available: boolean
  subscriptionType: string | null
  windows: { label: string; utilization: number; resetsAt: number | null }[]
}

export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged: string[]
  insertions: number
  deletions: number
}

export interface SetModeBody {
  mode: HostMode
}

export interface PluginInfo {
  id: string
  name: string
  marketplace: string
  description?: string
  installed: boolean
  enabled: boolean
  version?: string
}

export interface PluginActionBody {
  action: 'install' | 'uninstall'
}

export interface SetModelBody {
  model: string
}

export interface SetThinkingBody {
  enabled: boolean
}

export interface McpActionBody {
  action: 'enable' | 'disable' | 'reconnect'
}

export interface RewindBody {
  userUuid: string
  dryRun: boolean
}

export interface ForkBody {
  /** assistant message uuid the fork resumes at (from a `checkpoint` event) */
  atUuid: string
}

export interface HealthResponse {
  ok: true
  user: string | null
  fake: boolean
  defaultCwd: string
  allowBypass: boolean
}

export const isAgentMode = (v: unknown): v is AgentMode => AGENT_MODES.some((m) => m.value === v)
