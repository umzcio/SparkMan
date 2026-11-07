import { isLiveOnly, type HostMode, type EventEnvelope, type NoticeLevel, type SessionState, type SessionSummary, type TaskStatus } from './protocol'

export type TranscriptItem =
  | { type: 'user'; key: string; text: string; uuid?: string; images?: number; rewound?: boolean }
  | { type: 'assistant'; key: string; messageId: string; text: string; streaming: boolean }
  | { type: 'thinking'; key: string; text: string }
  | { type: 'tool'; key: string; toolUseId: string; name: string; input: Record<string, unknown>; result?: { content: string; isError: boolean }; elapsedSeconds?: number }
  | { type: 'permission'; key: string; requestId: string; toolUseId: string; toolName: string; input: Record<string, unknown>; reason?: string; resolution?: 'allow' | 'deny' }
  | { type: 'turn'; key: string; costUsd: number; durationMs: number; isError: boolean; checkpoint?: string; tokens?: number }
  | { type: 'error'; key: string; message: string }
  | { type: 'notice'; key: string; level: NoticeLevel; source: string; text: string }
  | { type: 'command'; key: string; text: string }

export interface TaskInfo {
  taskId: string
  status: TaskStatus
  description: string
  summary?: string
  subagentType?: string
  lastTool?: string
}

export interface SessionView {
  items: TranscriptItem[]
  lastSeq: number
  mode: HostMode
  model: string | null
  cwd: string
  version: string | null
  state: SessionState
  costUsd: number
  showThinking: boolean
  tasks: TaskInfo[]
  /** follow-up Claude suggests after a turn (cleared when you send) */
  suggestion: string | null
  /** bumps when the session's slash commands change */
  commandsVersion: number
  /** assistant uuid of the last completed turn, waiting for its turn_end */
  pendingCheckpoint: string | null
}

export function initialView(summary: SessionSummary): SessionView {
  return {
    items: [],
    lastSeq: 0,
    mode: summary.mode,
    model: summary.model,
    cwd: summary.cwd,
    version: null,
    state: summary.state,
    costUsd: summary.costUsd,
    showThinking: summary.showThinking ?? true,
    tasks: [],
    suggestion: null,
    commandsVersion: 0,
    pendingCheckpoint: null,
  }
}

const append = (v: SessionView, item: TranscriptItem): SessionView => ({ ...v, items: [...v.items, item] })

/** Pure reducer: fold one server event into the view. Duplicate/out-of-order envelopes are ignored. */
export function reduceEvent(view: SessionView, env: EventEnvelope): SessionView {
  // live-only events carry the last persisted seq; everything else dedupes by seq
  const live = isLiveOnly(env.event)
  if (!live && env.seq <= view.lastSeq) return view
  const v: SessionView = live ? { ...view } : { ...view, lastSeq: env.seq }
  const key = String(env.seq)
  const ev = env.event
  switch (ev.kind) {
    case 'session':
      return { ...v, model: ev.model, mode: ev.mode, cwd: ev.cwd, version: ev.version }
    case 'user':
      return { ...append(v, { type: 'user', key, text: ev.text, uuid: ev.uuid, images: ev.images }), suggestion: null }
    case 'text_delta': {
      const idx = v.items.findIndex((i) => i.type === 'assistant' && i.messageId === ev.messageId && i.streaming)
      if (idx === -1) return append(v, { type: 'assistant', key: `d${key}-${ev.messageId}`, messageId: ev.messageId, text: ev.text, streaming: true })
      const items = [...v.items]
      const item = items[idx] as Extract<TranscriptItem, { type: 'assistant' }>
      items[idx] = { ...item, text: item.text + ev.text }
      return { ...v, items }
    }
    case 'assistant_text': {
      const idx = v.items.findIndex((i) => i.type === 'assistant' && i.messageId === ev.messageId && i.streaming)
      const finalItem: TranscriptItem = { type: 'assistant', key: idx === -1 ? key : v.items[idx].key, messageId: ev.messageId, text: ev.text, streaming: false }
      if (idx === -1) return append(v, finalItem)
      const items = [...v.items]
      items[idx] = finalItem
      return { ...v, items }
    }
    case 'thinking':
      return append(v, { type: 'thinking', key, text: ev.text })
    case 'tool_use':
      // a repeated id updates the card in place (Codex re-sends its plan as it changes)
      if (v.items.some((i) => i.type === 'tool' && i.toolUseId === ev.toolUseId)) {
        return { ...v, items: v.items.map((i) => (i.type === 'tool' && i.toolUseId === ev.toolUseId ? { ...i, input: ev.input } : i)) }
      }
      return append(v, { type: 'tool', key, toolUseId: ev.toolUseId, name: ev.name, input: ev.input })
    case 'tool_progress':
      return { ...v, items: v.items.map((i) => (i.type === 'tool' && i.toolUseId === ev.toolUseId ? { ...i, elapsedSeconds: ev.elapsedSeconds } : i)) }
    case 'tool_result':
      return {
        ...v,
        items: v.items.map((i) => (i.type === 'tool' && i.toolUseId === ev.toolUseId ? { ...i, result: { content: ev.content, isError: ev.isError } } : i)),
      }
    case 'permission_request':
      return append(v, { type: 'permission', key, requestId: ev.requestId, toolUseId: ev.toolUseId, toolName: ev.toolName, input: ev.input, reason: ev.reason })
    case 'permission_resolved':
      return { ...v, items: v.items.map((i) => (i.type === 'permission' && i.requestId === ev.requestId ? { ...i, resolution: ev.behavior } : i)) }
    case 'mode':
      return { ...v, mode: ev.mode }
    case 'model':
      return { ...v, model: ev.model }
    case 'show_thinking':
      return { ...v, showThinking: ev.enabled }
    case 'status':
      // a turn that ends drops any half-streamed text that never got a final block
      return { ...v, state: ev.state, items: ev.state === 'idle' ? v.items.map((i) => (i.type === 'assistant' && i.streaming ? { ...i, streaming: false } : i)) : v.items }
    case 'checkpoint':
      return { ...v, pendingCheckpoint: ev.assistantUuid }
    case 'turn_end':
      return {
        ...append(v, { type: 'turn', key, costUsd: ev.costUsd, durationMs: ev.durationMs, isError: ev.isError, ...(ev.tokens !== undefined ? { tokens: ev.tokens } : {}), ...(v.pendingCheckpoint ? { checkpoint: v.pendingCheckpoint } : {}) }),
        costUsd: ev.costUsd,
        pendingCheckpoint: null,
      }
    case 'error':
      return append(v, { type: 'error', key, message: ev.message })
    case 'notice':
      return append(v, { type: 'notice', key, level: ev.level, source: ev.source, text: ev.text })
    case 'command_output':
      return append(v, { type: 'command', key, text: ev.text })
    case 'suggestion':
      return { ...v, suggestion: ev.text }
    case 'commands_changed':
      return { ...v, commandsVersion: v.commandsVersion + 1 }
    case 'task': {
      const { kind: _kind, toolUseId: _t, ...info } = ev
      const idx = v.tasks.findIndex((t) => t.taskId === ev.taskId)
      const tasks = idx === -1 ? [...v.tasks, info] : v.tasks.map((t, i) => (i === idx ? { ...t, ...info, description: t.description || info.description } : t))
      return { ...v, tasks }
    }
    case 'rewound':
      return {
        ...v,
        items: [
          ...v.items.map((i) => (i.type === 'user' && i.uuid === ev.userUuid ? { ...i, rewound: true } : i)),
          { type: 'notice', key, level: 'info', source: 'rewind', text: `Rewound ${ev.filesChanged.length} file${ev.filesChanged.length === 1 ? '' : 's'}: ${ev.filesChanged.join(', ') || 'nothing to change'}` },
        ],
      }
  }
}

/** A permission card is actionable only while unresolved and the session is still running. */
export const isPendingPermission = (item: TranscriptItem, view: SessionView) => item.type === 'permission' && !item.resolution && view.state === 'running'

export interface TodoItem {
  content: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Claude's current todo list: the input of the latest TodoWrite call. */
export function latestTodos(items: TranscriptItem[]): TodoItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.type === 'tool' && it.name === 'TodoWrite' && Array.isArray(it.input.todos)) return it.input.todos as TodoItem[]
  }
  return []
}
