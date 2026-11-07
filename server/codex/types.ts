// The slice of the `codex app-server` v2 protocol SparkMan uses. Generated bindings
// (`codex app-server generate-ts`) are the source of truth; keep these in step with them.

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type AskForApproval = 'untrusted' | 'on-request' | 'never'
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean }

export type UserInput = { type: 'text'; text: string; text_elements: [] } | { type: 'image'; url: string }

export interface Thread {
  id: string
  model: string | null
}

export interface ThreadStartResponse {
  thread: Thread
  model: string
  cwd: string
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress'

export interface Turn {
  id: string
  status: TurnStatus
  error: { message: string } | null
  durationMs: number | null
}

export interface FileUpdateChange {
  path: string
  kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null }
  diff: string
}

export type ThreadItem =
  | { type: 'userMessage'; id: string }
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | { type: 'plan'; id: string; text: string }
  | { type: 'commandExecution'; id: string; command: string; cwd: string; status: 'inProgress' | 'completed' | 'failed' | 'declined'; aggregatedOutput: string | null; exitCode: number | null }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: string; arguments: unknown; result?: unknown; error?: { message: string } | null }
  | { type: 'dynamicToolCall'; id: string; tool: string; arguments: unknown; status: string }
  | { type: 'webSearch'; id: string; query: string }
  | { type: 'contextCompaction'; id: string }
  | { type: string; id: string }

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface UserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  isSecret: boolean
  options: { label: string; description: string }[] | null
}

export interface Model {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
}

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  planType: string | null
}

export interface PluginSummary {
  id: string
  name: string
  installed: boolean
  enabled: boolean
  version: string | null
  localVersion: string | null
  interface: { displayName: string | null; shortDescription: string | null } | null
}

export interface PluginMarketplaceEntry {
  name: string
  path: string | null
  plugins: PluginSummary[]
}

export interface SkillMetadata {
  name: string
  description: string
  shortDescription?: string
  enabled: boolean
}

export interface McpServerStatus {
  name: string
  runtimeStatus: 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | null
  serverInfo: { version?: string } | null
  tools: Record<string, { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } } | undefined>
  toolsError?: string | null
  authStatus?: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'
}

export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string } | { type: 'amazonBedrock' }
