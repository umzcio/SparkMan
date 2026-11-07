import type { Capabilities, ContextUsage, Effort, McpServerInfo, PlanUsage, PluginInfo } from '../../src/agent/protocol.ts'
import type { Account, McpServerStatus, Model, PluginMarketplaceEntry, RateLimitSnapshot, RateLimitWindow, SkillMetadata, ThreadTokenUsage } from './types.ts'

/** Maps from app-server responses to the UI wire protocol. */

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])

export function toCapabilities(models: Model[], account: Account | null, skills: SkillMetadata[]): Capabilities {
  return {
    // Codex's slash commands live in its TUI; the app-server has none to run
    commands: [],
    terminalCommands: [],
    skills: skills.map((s) => s.name),
    models: models
      .filter((m) => !m.hidden)
      .map((m) => ({
        value: m.model,
        displayName: m.displayName,
        description: m.description,
        supportedEffortLevels: m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter((e): e is Effort => EFFORTS.has(e)),
      })),
    agents: [],
    account: account
      ? account.type === 'chatgpt'
        ? { email: account.email ?? undefined, subscriptionType: `ChatGPT ${account.planType}`, apiProvider: 'openai' }
        : { apiProvider: account.type === 'apiKey' ? 'OpenAI API key' : 'Amazon Bedrock' }
      : null,
    outputStyle: null,
  }
}

const MCP_STATUS: Record<NonNullable<McpServerStatus['runtimeStatus']>, McpServerInfo['status']> = {
  notStarted: 'pending',
  starting: 'pending',
  connected: 'connected',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
}

export const toMcpServers = (servers: McpServerStatus[]): McpServerInfo[] =>
  servers.map((s) => ({
    name: s.name,
    status: s.authStatus === 'notLoggedIn' ? 'needs-auth' : s.runtimeStatus ? MCP_STATUS[s.runtimeStatus] : 'pending',
    ...(s.toolsError ? { error: s.toolsError } : {}),
    ...(s.serverInfo?.version ? { version: s.serverInfo.version } : {}),
    tools: Object.values(s.tools)
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({ name: t.name, description: t.description, readOnly: t.annotations?.readOnlyHint, destructive: t.annotations?.destructiveHint })),
  }))

export function toContextUsage(usage: ThreadTokenUsage | null, model: string): ContextUsage {
  const last = usage?.last
  const max = usage?.modelContextWindow ?? 0
  const used = last ? last.inputTokens + last.outputTokens : 0
  return {
    model,
    totalTokens: used,
    maxTokens: max,
    percentage: max > 0 ? (used / max) * 100 : 0,
    categories: last
      ? [
          { name: 'Cached input', tokens: last.cachedInputTokens, color: 'inactive' },
          { name: 'Input', tokens: Math.max(0, last.inputTokens - last.cachedInputTokens), color: 'claude' },
          { name: 'Output', tokens: last.outputTokens, color: 'success' },
        ].filter((c) => c.tokens > 0)
      : [],
    memoryFiles: [],
    mcpTools: [],
  }
}

const windowLabel = (w: RateLimitWindow, fallback: string) =>
  w.windowDurationMins === 300 ? 'Current session (5-hour)' : w.windowDurationMins === 10_080 ? 'Weekly' : w.windowDurationMins ? `${Math.round(w.windowDurationMins / 60)}-hour window` : fallback

export function toPlanUsage(r: RateLimitSnapshot): PlanUsage {
  const windows = [r.primary && { w: r.primary, label: windowLabel(r.primary, 'Primary') }, r.secondary && { w: r.secondary, label: windowLabel(r.secondary, 'Secondary') }]
    .filter((x): x is { w: RateLimitWindow; label: string } => !!x)
    .map(({ w, label }) => ({ label, utilization: Math.min(100, Math.max(0, w.usedPercent)), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }))
  return { available: windows.length > 0, subscriptionType: r.planType, windows }
}

export const toPlugins = (markets: PluginMarketplaceEntry[]): PluginInfo[] =>
  markets.flatMap((m) =>
    m.plugins.map((p) => ({
      id: p.id,
      name: p.interface?.displayName || p.name,
      marketplace: m.name,
      ...(p.interface?.shortDescription ? { description: p.interface.shortDescription } : {}),
      installed: p.installed,
      enabled: p.enabled,
      ...((p.localVersion ?? p.version) ? { version: (p.localVersion ?? p.version)! } : {}),
    })),
  )
