import type {
  HostMode,
  Capabilities,
  ContextUsage,
  CreateSessionBody,
  HealthResponse,
  ImageAttachment,
  McpActionBody,
  McpServerInfo,
  PermissionDecisionBody,
  PlanUsage,
  PluginActionBody,
  PluginInfo,
  RewindResult,
  SessionDetail,
  SessionSummary,
} from './protocol'

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

/** HTTP client for one host agent's session API (Claude Code at /api/agent, Codex at /api/codex). */
export function createAgentApi(base: string) {
  const call = <T>(path: string, init?: RequestInit) => request<T>(base, path, init)
  const post = <T>(path: string, body: unknown) => call<T>(path, { method: 'POST', body: JSON.stringify(body) })
  return {
    health: () => call<HealthResponse>('/health'),
    listSessions: () => call<SessionSummary[]>('/sessions'),
    createSession: (body: CreateSessionBody) => post<SessionSummary>('/sessions', body),
    getSession: (id: string) => call<SessionDetail>(`/sessions/${id}`),
    sendMessage: (id: string, text: string, images: ImageAttachment[] = []) => post<{ ok: true }>(`/sessions/${id}/messages`, images.length ? { text, images } : { text }),
    decide: (id: string, requestId: string, body: PermissionDecisionBody) => post<{ ok: true }>(`/sessions/${id}/permissions/${requestId}`, body),
    setMode: (id: string, mode: HostMode) => post<SessionSummary>(`/sessions/${id}/mode`, { mode }),
    setModel: (id: string, model: string) => post<SessionSummary>(`/sessions/${id}/model`, { model }),
    setThinking: (id: string, enabled: boolean) => post<SessionSummary>(`/sessions/${id}/thinking`, { enabled }),
    interrupt: (id: string) => post<{ ok: true }>(`/sessions/${id}/interrupt`, {}),
    capabilities: (id: string) => call<Capabilities>(`/sessions/${id}/capabilities`),
    context: (id: string) => call<ContextUsage>(`/sessions/${id}/context`),
    usage: (id: string) => call<PlanUsage>(`/sessions/${id}/usage`),
    mcp: (id: string) => call<McpServerInfo[]>(`/sessions/${id}/mcp`),
    mcpAction: (id: string, name: string, action: McpActionBody['action']) => post<McpServerInfo[]>(`/sessions/${id}/mcp/${encodeURIComponent(name)}`, { action }),
    reloadSkills: (id: string) => post<{ skills: string[] }>(`/sessions/${id}/skills/reload`, {}),
    stopTask: (id: string, taskId: string) => post<{ ok: true }>(`/sessions/${id}/tasks/${encodeURIComponent(taskId)}/stop`, {}),
    rewind: (id: string, userUuid: string, dryRun: boolean) => post<RewindResult>(`/sessions/${id}/rewind`, { userUuid, dryRun }),
    fork: (id: string, atUuid: string) => post<SessionSummary>(`/sessions/${id}/fork`, { atUuid }),
    plugins: (id: string) => call<PluginInfo[]>(`/sessions/${id}/plugins`),
    pluginAction: (id: string, pluginId: string, action: PluginActionBody['action']) => post<PluginInfo[]>(`/sessions/${id}/plugins/${encodeURIComponent(pluginId)}`, { action }),
    streamUrl: (id: string, after: number) => `${base}/sessions/${id}/stream?after=${after}`,
  }
}

export type AgentApi = ReturnType<typeof createAgentApi>

export const agentApi = createAgentApi('/api/agent')
export const codexApi = createAgentApi('/api/codex')
