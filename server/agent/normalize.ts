import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { isAgentMode, type AgentEvent, type NoticeLevel } from '../../src/agent/protocol.ts'

const MAX_RESULT_CHARS = 20_000

export interface NormalizeContext {
  /** id of the assistant message currently streaming (from message_start) */
  messageId: string
  /** uuid of the last top-level transcript entry of the current turn (its fork point) */
  lastAssistantUuid: string
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: { type?: string; text?: string }) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type ? `[${b.type}]` : ''))
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

const clip = (s: string) => (s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (${s.length - MAX_RESULT_CHARS} more characters)` : s)
const notice = (level: NoticeLevel, source: string, text: string): AgentEvent => ({ kind: 'notice', level, source, text })

type Sys = Extract<SDKMessage, { type: 'system' }>
type SysOf<S extends string> = Extract<Sys, { subtype: S }>

function normalizeSystem(msg: Sys): AgentEvent[] {
  switch (msg.subtype) {
    case 'init': {
      const init = msg as SysOf<'init'>
      return [{ kind: 'session', cwd: init.cwd, model: init.model, mode: isAgentMode(init.permissionMode) ? init.permissionMode : 'default', version: init.claude_code_version }]
    }
    case 'compact_boundary':
      return [notice('info', 'compact', 'Context compacted: earlier conversation was summarized to free up room.')]
    case 'api_retry': {
      const m = msg as SysOf<'api_retry'>
      return [notice('warning', 'api', `API error${m.error_status ? ` ${m.error_status}` : ''}: retrying (attempt ${m.attempt}/${m.max_retries}) in ${Math.round(m.retry_delay_ms / 1000)} s`)]
    }
    case 'local_command_output':
      return [{ kind: 'command_output', text: clip((msg as SysOf<'local_command_output'>).content) }]
    case 'notification': {
      const m = msg as SysOf<'notification'>
      return [notice(m.priority === 'high' || m.priority === 'immediate' ? 'warning' : 'info', 'notification', m.text)]
    }
    case 'informational': {
      const m = msg as SysOf<'informational'>
      return [notice(m.level === 'warning' ? 'warning' : 'info', 'info', m.content)]
    }
    case 'permission_denied': {
      const m = msg as SysOf<'permission_denied'>
      return [notice('warning', 'permissions', `${m.tool_name} was denied: ${m.message}`)]
    }
    case 'model_refusal_fallback': {
      const m = msg as SysOf<'model_refusal_fallback'>
      return [notice('warning', 'model', `${m.original_model} declined; continued on ${m.fallback_model}.`)]
    }
    case 'task_started': {
      const m = msg as SysOf<'task_started'>
      return [{ kind: 'task', taskId: m.task_id, status: 'running', description: m.description, subagentType: m.subagent_type, toolUseId: m.tool_use_id }]
    }
    case 'task_progress': {
      const m = msg as SysOf<'task_progress'>
      return [{ kind: 'task', taskId: m.task_id, status: 'running', description: m.description, subagentType: m.subagent_type, lastTool: m.last_tool_name, summary: m.summary, toolUseId: m.tool_use_id }]
    }
    case 'task_notification': {
      const m = msg as SysOf<'task_notification'>
      return [{ kind: 'task', taskId: m.task_id, status: m.status, description: m.summary, summary: m.summary, toolUseId: m.tool_use_id }]
    }
    case 'commands_changed':
      return [{ kind: 'commands_changed' }]
    default:
      return []
  }
}

/** Map one SDK message to zero or more UI events. Subagent traffic (parent_tool_use_id set) is dropped. */
export function normalize(msg: SDKMessage, ctx: NormalizeContext): AgentEvent[] {
  switch (msg.type) {
    case 'system':
      return normalizeSystem(msg)
    case 'stream_event': {
      if (msg.parent_tool_use_id) return []
      const ev = msg.event
      if (ev.type === 'message_start') {
        ctx.messageId = ev.message.id
        return []
      }
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        return [{ kind: 'text_delta', messageId: ctx.messageId, text: ev.delta.text }]
      }
      return []
    }
    case 'assistant': {
      if (msg.parent_tool_use_id) return []
      ctx.lastAssistantUuid = msg.uuid
      const out: AgentEvent[] = []
      for (const block of msg.message.content) {
        if (block.type === 'thinking' && block.thinking) out.push({ kind: 'thinking', messageId: msg.message.id, text: block.thinking })
        else if (block.type === 'text' && block.text) out.push({ kind: 'assistant_text', messageId: msg.message.id, text: block.text })
        else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolUseId: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> })
      }
      return out
    }
    case 'user': {
      if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return []
      const out: AgentEvent[] = []
      // a completed tool result belongs to the turn: forking before it would drop it
      if (msg.uuid && msg.message.content.some((b) => b.type === 'tool_result')) ctx.lastAssistantUuid = msg.uuid
      for (const block of msg.message.content) {
        if (block.type === 'tool_result') out.push({ kind: 'tool_result', toolUseId: block.tool_use_id, content: clip(resultText(block.content)), isError: block.is_error === true })
      }
      return out
    }
    case 'tool_progress':
      if (msg.parent_tool_use_id) return []
      return [{ kind: 'tool_progress', toolUseId: msg.tool_use_id, elapsedSeconds: msg.elapsed_time_seconds }]
    case 'prompt_suggestion':
      return msg.suggestion ? [{ kind: 'suggestion', text: msg.suggestion }] : []
    case 'rate_limit_event': {
      const info = msg.rate_limit_info
      if (info.status === 'allowed') return []
      const when = info.resetsAt ? ` (resets ${new Date(info.resetsAt * 1000).toLocaleTimeString()})` : ''
      return [notice(info.status === 'rejected' ? 'error' : 'warning', 'rate-limit', `${info.status === 'rejected' ? 'Rate limit reached' : 'Approaching your usage limit'}${info.rateLimitType ? ` · ${info.rateLimitType.replaceAll('_', ' ')}` : ''}${when}`)]
    }
    case 'result': {
      const events: AgentEvent[] = []
      if (msg.subtype !== 'success') {
        const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('; ') : ''
        events.push({ kind: 'error', message: errors || `Turn ended: ${msg.subtype}` })
      }
      if (ctx.lastAssistantUuid) events.push({ kind: 'checkpoint', assistantUuid: ctx.lastAssistantUuid })
      // a turn without transcript entries (local command) must not reuse the previous turn's fork point
      ctx.lastAssistantUuid = ''
      events.push({ kind: 'turn_end', costUsd: msg.total_cost_usd ?? 0, durationMs: msg.duration_ms ?? 0, isError: msg.is_error, numTurns: msg.num_turns ?? 0 })
      return events
    }
    default:
      return []
  }
}
