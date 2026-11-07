import type { McpServerStatus, RewindFilesResult, SDKControlGetContextUsageResponse, SDKControlGetUsageResponse, SDKControlInitializeResponse, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { Capabilities, ContextUsage, Effort, McpServerInfo, PlanUsage, RewindResult, SlashCommandInfo } from '../../src/agent/protocol.ts'

/** Maps from Agent SDK control-API shapes to the UI wire protocol (keeps SDK types off the wire). */

export const toCommand = (c: SlashCommand): SlashCommandInfo => ({
  name: c.name.replace(/^\//, ''),
  description: c.description,
  argumentHint: c.argumentHint,
  ...(c.aliases?.length ? { aliases: c.aliases } : {}),
  ...(c.builtin !== undefined ? { builtin: c.builtin } : {}),
})

export function toCapabilities(init: SDKControlInitializeResponse, extra: { skills: string[]; terminalCommands: string[]; commands?: SlashCommand[] }): Capabilities {
  return {
    commands: (extra.commands ?? init.commands).map(toCommand),
    terminalCommands: extra.terminalCommands.map((n) => n.replace(/^\//, '')),
    // the raw init message (first turn) names skills; before that, non-builtin commands are skills and custom commands
    skills: extra.skills.length ? extra.skills : (extra.commands ?? init.commands).filter((c) => c.builtin !== true).map((c) => toCommand(c).name),
    models: init.models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      ...(m.supportedEffortLevels ? { supportedEffortLevels: m.supportedEffortLevels as Effort[] } : {}),
    })),
    agents: init.agents.map((a) => ({ name: a.name, description: a.description, ...(a.model ? { model: a.model } : {}) })),
    account: init.account
      ? { email: init.account.email, organization: init.account.organization, subscriptionType: init.account.subscriptionType, apiProvider: init.account.apiProvider }
      : null,
    outputStyle: init.output_style ?? null,
  }
}

export const toMcpServer = (s: McpServerStatus): McpServerInfo => ({
  name: s.name,
  status: s.status,
  ...(s.error ? { error: s.error } : {}),
  ...(s.scope ? { scope: s.scope } : {}),
  ...(s.serverInfo?.version ? { version: s.serverInfo.version } : {}),
  tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description, readOnly: t.annotations?.readOnly, destructive: t.annotations?.destructive })),
})

export const toContextUsage = (u: SDKControlGetContextUsageResponse): ContextUsage => ({
  model: u.model,
  totalTokens: u.totalTokens,
  maxTokens: u.maxTokens,
  percentage: u.percentage,
  // deferred tools aren't loaded into the window, and free space is the remainder
  categories: u.categories.filter((c) => c.tokens > 0 && !c.name.includes('(deferred)') && c.name !== 'Free space').map((c) => ({ name: c.name, tokens: c.tokens, color: c.color })),
  memoryFiles: u.memoryFiles.map((f) => ({ path: f.path, tokens: f.tokens })),
  mcpTools: u.mcpTools.map((t) => ({ name: t.name, serverName: t.serverName, tokens: t.tokens })),
})

/** Plan windows worth showing (the endpoint also returns internal / per-app windows). */
const PLAN_WINDOWS: Record<string, string> = {
  five_hour: 'Current session (5-hour)',
  seven_day: 'Weekly · all models',
  seven_day_opus: 'Weekly · Opus',
  seven_day_sonnet: 'Weekly · Sonnet',
}

export function toPlanUsage(u: SDKControlGetUsageResponse): PlanUsage {
  const windows: PlanUsage['windows'] = []
  const limits = (u.rate_limits ?? {}) as Record<string, { utilization?: number | null; resets_at?: string | null } | null | undefined>
  for (const [key, label] of Object.entries(PLAN_WINDOWS)) {
    const w = limits[key]
    if (!w || typeof w.utilization !== 'number') continue
    const resets = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
    // utilization is a percentage, 0-100
    windows.push({ label, utilization: Math.min(100, Math.max(0, w.utilization)), resetsAt: Number.isNaN(resets) ? null : resets })
  }
  return { available: u.rate_limits_available, subscriptionType: u.subscription_type, windows }
}

export const toRewind = (r: RewindFilesResult): RewindResult => ({
  canRewind: r.canRewind,
  ...(r.error ? { error: r.error } : {}),
  filesChanged: r.filesChanged ?? [],
  insertions: r.insertions ?? 0,
  deletions: r.deletions ?? 0,
})
