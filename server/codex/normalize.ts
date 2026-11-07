import type { AgentEvent } from '../../src/agent/protocol.ts'
import type { ThreadItem, Turn, TurnPlanStep } from './types.ts'

const MAX_OUTPUT_CHARS = 20_000

export interface CodexNormalizeContext {
  /** items seen this session, by id (approval requests refer to them) */
  items: Map<string, ThreadItem>
  /** ids that already got their tool card from item/started */
  started: Set<string>
  /** the plan card for the current turn (plan updates replace it) */
  planToolUseId: string | null
  /** thread token total, from thread/tokenUsage/updated */
  turnTokens: number
}

const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n… (${s.length - MAX_OUTPUT_CHARS} more characters)` : s)
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v })

/** Tool-call view of an item, or null for items that aren't tools. */
function toolUse(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case 'commandExecution':
      if (!('command' in item)) return null
      return { kind: 'tool_use', toolUseId: item.id, name: 'Shell', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange':
      if (!('changes' in item)) return null
      return { kind: 'tool_use', toolUseId: item.id, name: 'ApplyPatch', input: { changes: item.changes } }
    case 'mcpToolCall':
      if (!('server' in item)) return null
      return { kind: 'tool_use', toolUseId: item.id, name: `${item.server}.${item.tool}`, input: asRecord(item.arguments) }
    case 'dynamicToolCall':
      if (!('tool' in item)) return null
      return { kind: 'tool_use', toolUseId: item.id, name: item.tool, input: asRecord(item.arguments) }
    case 'webSearch':
      if (!('query' in item)) return null
      return { kind: 'tool_use', toolUseId: item.id, name: 'WebSearch', input: { query: item.query } }
    default:
      return null
  }
}

function toolResult(item: ThreadItem): AgentEvent | null {
  switch (item.type) {
    case 'commandExecution': {
      if (!('status' in item) || !('command' in item)) return null
      const failed = item.status !== 'completed' || (item.exitCode !== null && item.exitCode !== 0)
      const tail = item.exitCode !== null && item.exitCode !== 0 ? `\n(exit ${item.exitCode})` : item.status === 'declined' ? 'Declined.' : ''
      return { kind: 'tool_result', toolUseId: item.id, content: clip(`${item.aggregatedOutput ?? ''}${tail}`), isError: failed }
    }
    case 'fileChange':
      if (!('status' in item)) return null
      return { kind: 'tool_result', toolUseId: item.id, content: item.status === 'completed' ? 'Applied.' : item.status, isError: item.status !== 'completed' }
    case 'mcpToolCall': {
      if (!('status' in item)) return null
      const err = 'error' in item && item.error ? item.error.message : null
      return { kind: 'tool_result', toolUseId: item.id, content: clip(err ?? JSON.stringify('result' in item ? item.result ?? null : null, null, 2)), isError: !!err || item.status === 'failed' }
    }
    case 'dynamicToolCall':
      return 'status' in item ? { kind: 'tool_result', toolUseId: item.id, content: String(item.status), isError: item.status === 'failed' } : null
    case 'webSearch':
      return { kind: 'tool_result', toolUseId: item.id, content: 'Searched.', isError: false }
    default:
      return null
  }
}

const PLAN_STATUS = { pending: 'pending', inProgress: 'in_progress', completed: 'completed' } as const

/** Map one app-server notification for a thread to zero or more SparkMan events. */
export function normalizeCodex(method: string, params: Record<string, unknown>, ctx: CodexNormalizeContext): AgentEvent[] {
  switch (method) {
    case 'item/started': {
      const item = params.item as ThreadItem
      ctx.items.set(item.id, item)
      const ev = toolUse(item)
      if (ev) ctx.started.add(item.id)
      return ev ? [ev] : []
    }
    case 'item/completed': {
      const item = params.item as ThreadItem
      ctx.items.set(item.id, item)
      if (item.type === 'agentMessage' && 'text' in item) return item.text ? [{ kind: 'assistant_text', messageId: item.id, text: item.text }] : []
      if (item.type === 'reasoning' && 'summary' in item) {
        const text = (item.summary.length ? item.summary : item.content).join('\n\n').trim()
        return text ? [{ kind: 'thinking', messageId: item.id, text }] : []
      }
      if (item.type === 'contextCompaction') return [{ kind: 'notice', level: 'info', source: 'compact', text: 'Context compacted: earlier conversation was summarized to free up room.' }]
      const out: AgentEvent[] = []
      // items that completed without a started event (fast tools) still get their card
      const use = toolUse(item)
      if (use && !ctx.started.has(item.id)) out.push(use)
      const res = toolResult(item)
      if (res) out.push(res)
      return out
    }
    case 'item/agentMessage/delta':
      return [{ kind: 'text_delta', messageId: String(params.itemId), text: String(params.delta ?? '') }]
    case 'turn/plan/updated': {
      const plan = (params.plan as TurnPlanStep[]) ?? []
      const todos = plan.map((s) => ({ content: s.step, activeForm: s.step, status: PLAN_STATUS[s.status] ?? 'pending' }))
      ctx.planToolUseId ??= `plan-${String(params.turnId)}`
      return [{ kind: 'tool_use', toolUseId: ctx.planToolUseId, name: 'TodoWrite', input: { todos } }, { kind: 'tool_result', toolUseId: ctx.planToolUseId, content: 'Plan updated', isError: false }]
    }
    case 'turn/completed': {
      const turn = params.turn as Turn
      const out: AgentEvent[] = []
      if (turn.status === 'failed') out.push({ kind: 'error', message: turn.error?.message ?? 'Turn failed' })
      out.push({ kind: 'turn_end', costUsd: 0, durationMs: turn.durationMs ?? 0, isError: turn.status !== 'completed', numTurns: 1, tokens: ctx.turnTokens })
      return out
    }
    case 'error': {
      const e = params as { error?: { message?: string }; willRetry?: boolean }
      if (!e.willRetry) return [] // the failed turn reports it
      return [{ kind: 'notice', level: 'warning', source: 'api', text: `${e.error?.message ?? 'Error'} — retrying` }]
    }
    case 'model/rerouted':
      return [{ kind: 'notice', level: 'info', source: 'model', text: `Model rerouted${typeof params.toModel === 'string' ? ` to ${params.toModel}` : ''}.` }]
    case 'thread/compacted':
      return [{ kind: 'notice', level: 'info', source: 'compact', text: 'Context compacted.' }]
    default:
      return []
  }
}
