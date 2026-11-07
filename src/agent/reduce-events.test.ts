import { describe, expect, it } from 'vitest'
import type { AgentEvent, EventEnvelope, SessionSummary } from './protocol'
import { initialView, isPendingPermission, latestTodos, reduceEvent, type SessionView } from './reduce-events'

const summary: SessionSummary = { id: 's', title: 't', cwd: '/srv', model: null, mode: 'default', state: 'idle', createdAt: 0, updatedAt: 0, costUsd: 0, showThinking: true, options: {} }
let seq = 0
const env = (event: AgentEvent): EventEnvelope => ({ seq: ++seq, ts: 0, event })
const fold = (events: AgentEvent[], start: SessionView = initialView(summary)) => events.map(env).reduce(reduceEvent, start)

describe('reduceEvent', () => {
  it('builds a transcript: user, streamed assistant text, tool with result, turn', () => {
    seq = 0
    const v = fold([
      { kind: 'session', cwd: '/home', model: 'claude-opus-5-5', mode: 'acceptEdits', version: '2.1' },
      { kind: 'user', text: 'hi' },
      { kind: 'status', state: 'running' },
      { kind: 'text_delta', messageId: 'm1', text: 'Hel' },
      { kind: 'text_delta', messageId: 'm1', text: 'lo' },
      { kind: 'assistant_text', messageId: 'm1', text: 'Hello.' },
      { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', toolUseId: 't1', content: 'a b', isError: false },
      { kind: 'turn_end', costUsd: 0.02, durationMs: 900, isError: false, numTurns: 1 },
      { kind: 'status', state: 'idle' },
    ])
    expect(v).toMatchObject({ model: 'claude-opus-5-5', mode: 'acceptEdits', cwd: '/home', version: '2.1', state: 'idle', costUsd: 0.02, lastSeq: 10 })
    expect(v.items.map((i) => i.type)).toEqual(['user', 'assistant', 'tool', 'turn'])
    expect(v.items[1]).toMatchObject({ text: 'Hello.', streaming: false })
    expect(v.items[2]).toMatchObject({ result: { content: 'a b', isError: false } })
  })

  it('ignores duplicate and stale envelopes (replay + live stream overlap)', () => {
    seq = 0
    const first = env({ kind: 'user', text: 'once' })
    let v = reduceEvent(initialView(summary), first)
    v = reduceEvent(v, first)
    expect(v.items).toHaveLength(1)
  })

  it('tracks permission requests until resolved, and only while running', () => {
    seq = 0
    let v = fold([
      { kind: 'status', state: 'running' },
      { kind: 'permission_request', requestId: 'r1', toolUseId: 't1', toolName: 'Bash', input: { command: 'rm x' } },
    ])
    const card = v.items.find((i) => i.type === 'permission')!
    expect(isPendingPermission(card, v)).toBe(true)
    v = fold([{ kind: 'permission_resolved', requestId: 'r1', behavior: 'deny' }], v)
    const resolved = v.items.find((i) => i.type === 'permission')!
    expect(resolved).toMatchObject({ resolution: 'deny' })
    expect(isPendingPermission(resolved, v)).toBe(false)
    const idle = fold([{ kind: 'status', state: 'idle' }], fold([{ kind: 'permission_request', requestId: 'r2', toolUseId: 't2', toolName: 'Edit', input: {} }], v))
    expect(isPendingPermission(idle.items.at(-1)!, idle)).toBe(false)
  })

  it('finalizes half-streamed text when a turn goes idle', () => {
    seq = 0
    const v = fold([
      { kind: 'status', state: 'running' },
      { kind: 'text_delta', messageId: 'm9', text: 'partial' },
      { kind: 'error', message: 'boom' },
      { kind: 'status', state: 'idle' },
    ])
    expect(v.items[0]).toMatchObject({ type: 'assistant', text: 'partial', streaming: false })
    expect(v.items[1]).toMatchObject({ type: 'error', message: 'boom' })
  })

  it('folds SDK extras: thinking, notices, command output, checkpoints, tasks, suggestions and rewinds', () => {
    seq = 0
    const v = fold([
      { kind: 'user', text: 'go', uuid: 'u1' },
      { kind: 'thinking', messageId: 'm1', text: 'hmm' },
      { kind: 'tool_use', toolUseId: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } },
      { kind: 'task', taskId: 'k1', status: 'running', description: 'Survey' },
      { kind: 'task', taskId: 'k1', status: 'completed', description: '', summary: 'done' },
      { kind: 'notice', level: 'warning', source: 'api', text: 'retrying' },
      { kind: 'command_output', text: 'Total cost: $0' },
      { kind: 'checkpoint', assistantUuid: 'a1' },
      { kind: 'turn_end', costUsd: 0.5, durationMs: 1, isError: false, numTurns: 1 },
      { kind: 'rewound', userUuid: 'u1', filesChanged: ['x.md'] },
      { kind: 'model', model: 'sonnet' },
      { kind: 'show_thinking', enabled: false },
    ])
    expect(v.items.map((i) => i.type)).toEqual(['user', 'thinking', 'tool', 'notice', 'command', 'turn', 'notice'])
    expect(v.items.find((i) => i.type === 'turn')).toMatchObject({ checkpoint: 'a1' })
    expect(v.items[0]).toMatchObject({ uuid: 'u1', rewound: true })
    expect(v.tasks).toEqual([{ taskId: 'k1', status: 'completed', description: 'Survey', summary: 'done' }])
    expect(latestTodos(v.items)).toEqual([{ content: 'a', status: 'pending' }])
    expect(v).toMatchObject({ model: 'sonnet', showThinking: false, pendingCheckpoint: null })
  })

  it('treats live-only events (progress, suggestions, command changes) without consuming seq', () => {
    seq = 0
    let v = fold([{ kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: {} }])
    v = reduceEvent(v, { seq: 1, ts: 0, event: { kind: 'tool_progress', toolUseId: 't1', elapsedSeconds: 3 } })
    v = reduceEvent(v, { seq: 1, ts: 0, event: { kind: 'suggestion', text: 'next?' } })
    v = reduceEvent(v, { seq: 1, ts: 0, event: { kind: 'commands_changed' } })
    expect(v.items[0]).toMatchObject({ elapsedSeconds: 3 })
    expect(v).toMatchObject({ suggestion: 'next?', commandsVersion: 1, lastSeq: 1 })
    v = reduceEvent(v, { seq: 2, ts: 0, event: { kind: 'user', text: 'ok' } })
    expect(v.suggestion).toBeNull()
  })
})
