import type {
  Capabilities,
  ContextUsage,
  EventEnvelope,
  HostMode,
  ImageAttachment,
  McpActionBody,
  McpServerInfo,
  PermissionDecisionBody,
  PlanUsage,
  PluginActionBody,
  PluginInfo,
  RewindResult,
  SessionSummary,
} from '../../src/agent/protocol.ts'

/** A capability this agent doesn't have (the HTTP layer answers 501). */
export class UnsupportedError extends Error {
  constructor(what: string) {
    super(`${what} isn’t available for this agent`)
  }
}

/** Store-provided persistence hooks every session gets. */
export interface SessionHooks {
  now?: () => number
  /** persist one event (live-only events are never persisted) */
  persist: (sessionId: string, env: EventEnvelope) => void
  /** summary changed (title, state, mode, cost, model) */
  onChange: (summary: SessionSummary) => void
}

/** What the HTTP layer needs from a host agent session (Claude Code or Codex). */
export interface HostSession {
  readonly summary: SessionSummary
  readonly id: string
  subscribe(fn: (env: EventEnvelope) => void): () => void
  eventsAfter(after: number): EventEnvelope[]
  allEvents(): EventEnvelope[]
  send(text: string, images?: ImageAttachment[]): void
  decide(requestId: string, body: PermissionDecisionBody): boolean
  setMode(mode: HostMode): Promise<void>
  setModel(model: string): Promise<void>
  setShowThinking(enabled: boolean): Promise<void>
  interrupt(): Promise<void>
  capabilities(): Promise<Capabilities>
  mcpServers(): Promise<McpServerInfo[]>
  mcpAction(name: string, action: McpActionBody['action']): Promise<void>
  context(): Promise<ContextUsage>
  planUsage(): Promise<PlanUsage>
  reloadSkills(): Promise<string[]>
  stopTask(taskId: string): Promise<void>
  rewind(userUuid: string, dryRun: boolean): Promise<RewindResult>
  plugins(): Promise<PluginInfo[]>
  pluginAction(id: string, action: PluginActionBody['action']): Promise<void>
  close(): void
}
