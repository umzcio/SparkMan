// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, EventEnvelope } from '../../src/agent/protocol.ts'
import { createFakeQuery } from './fake-query.ts'
import { SessionStore } from './store.ts'
import type { QueryFn } from './types.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-test-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const makeStore = (queryFn: QueryFn = createFakeQuery()) => new SessionStore({ dir, queryFn, defaultCwd: '/srv', allowBypass: true })

/** Collect events until `until` returns true (or time out). */
function collect(session: { subscribe: (fn: (e: EventEnvelope) => void) => () => void }, until: (e: AgentEvent) => boolean) {
  const seen: AgentEvent[] = []
  return new Promise<AgentEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; saw ${seen.map((e) => e.kind).join(',')}`)), 2000)
    const off = session.subscribe((env) => {
      seen.push(env.event)
      if (until(env.event)) {
        clearTimeout(timer)
        off()
        resolve(seen)
      }
    })
  })
}

describe('AgentSession + SessionStore', () => {
  it('runs a turn: streams text, asks permission, applies the decision, reports cost', async () => {
    const store = makeStore()
    const s = store.create()
    expect(s.summary).toMatchObject({ cwd: '/srv', mode: 'default', state: 'idle', title: 'New session' })

    const toPermission = collect(s, (e) => e.kind === 'permission_request')
    s.send('How full is the disk?')
    const first = await toPermission
    expect(first.map((e) => e.kind)).toEqual(['user', 'status', 'session', 'text_delta', 'text_delta', 'text_delta', 'assistant_text', 'tool_use', 'permission_request'])
    expect(s.summary.title).toBe('How full is the disk?')
    const req = first.at(-1) as Extract<AgentEvent, { kind: 'permission_request' }>
    expect(req.toolName).toBe('Bash')
    expect(req.input).toMatchObject({ command: 'df -h /' })

    const toEnd = collect(s, (e) => e.kind === 'status' && e.state === 'idle')
    expect(s.decide(req.requestId, { behavior: 'allow' })).toBe(true)
    expect(s.decide(req.requestId, { behavior: 'allow' })).toBe(false)
    const rest = await toEnd
    const result = rest.find((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>
    expect(result.isError).toBe(false)
    expect(result.content).toContain('42%')
    expect(rest.some((e) => e.kind === 'assistant_text' && e.text.includes('42% full'))).toBe(true)
    expect(s.summary.costUsd).toBeCloseTo(0.0123)
    expect(s.summary.state).toBe('idle')
  })

  it('a denial is passed back to Claude with the operator message', async () => {
    const s = makeStore().create()
    const toPermission = collect(s, (e) => e.kind === 'permission_request')
    s.send('check disk')
    const req = (await toPermission).at(-1) as Extract<AgentEvent, { kind: 'permission_request' }>
    const toEnd = collect(s, (e) => e.kind === 'turn_end')
    s.decide(req.requestId, { behavior: 'deny', message: 'not now' })
    const rest = await toEnd
    const result = rest.find((e) => e.kind === 'tool_result') as Extract<AgentEvent, { kind: 'tool_result' }>
    expect(result).toMatchObject({ isError: true, content: 'not now' })
  })

  it('mode changes reach the live query and skip prompts in bypass mode', async () => {
    const s = makeStore().create({ mode: 'plan' })
    expect(s.summary.mode).toBe('plan')
    await s.setMode('bypassPermissions')
    const toEnd = collect(s, (e) => e.kind === 'turn_end')
    s.send('check disk')
    const events = await toEnd
    expect(events.some((e) => e.kind === 'permission_request')).toBe(false)
    expect(events.some((e) => e.kind === 'assistant_text' && e.text.includes('42% full'))).toBe(true)
    expect(s.allEvents().some((e) => e.event.kind === 'mode' && e.event.mode === 'bypassPermissions')).toBe(true)
  })

  it('persists events (not text deltas) and resumes after a restart', async () => {
    const calls: { resume?: string; sessionId?: string }[] = []
    const fake = createFakeQuery()
    const spy: QueryFn = (p) => {
      calls.push({ resume: p.options.resume, sessionId: p.options.sessionId })
      return fake(p)
    }
    const store = makeStore(spy)
    const s = store.create({ mode: 'bypassPermissions' })
    const toEnd = collect(s, (e) => e.kind === 'status' && e.state === 'idle')
    s.send('hello')
    await toEnd
    store.closeAll()

    const reopened = makeStore(spy)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]).toMatchObject({ id: s.id, title: 'hello', state: 'idle' })
    const again = reopened.get(s.id)!
    const kinds = again.allEvents().map((e) => e.event.kind)
    expect(kinds).toContain('assistant_text')
    expect(kinds).not.toContain('text_delta')
    expect(again.eventsAfter(again.allEvents().at(-1)!.seq)).toEqual([])

    const toEnd2 = collect(again, (e) => e.kind === 'turn_end')
    again.send('again')
    await toEnd2
    expect(calls).toEqual([{ resume: undefined, sessionId: s.id }, { resume: s.id, sessionId: undefined }])
  })

  it('interrupt denies a pending permission request', async () => {
    const s = makeStore().create()
    const toPermission = collect(s, (e) => e.kind === 'permission_request')
    s.send('check disk')
    const req = (await toPermission).at(-1) as Extract<AgentEvent, { kind: 'permission_request' }>
    const resolved = collect(s, (e) => e.kind === 'permission_resolved')
    await s.interrupt()
    expect((await resolved).at(-1)).toMatchObject({ kind: 'permission_resolved', requestId: req.requestId, behavior: 'deny' })
    expect(s.decide(req.requestId, { behavior: 'allow' })).toBe(false)
  })

  it('stays running across queued messages until the last turn finishes', async () => {
    const s = makeStore().create()
    const firstPermission = collect(s, (e) => e.kind === 'permission_request')
    s.send('one')
    s.send('two')
    const req1 = (await firstPermission).at(-1) as Extract<AgentEvent, { kind: 'permission_request' }>
    const secondPermission = collect(s, (e) => e.kind === 'permission_request')
    s.decide(req1.requestId, { behavior: 'allow' })
    const second = await secondPermission
    // the first turn ended, but the queued one is still in flight: no idle in between
    expect(second.some((e) => e.kind === 'turn_end')).toBe(true)
    expect(second.some((e) => e.kind === 'status' && e.state === 'idle')).toBe(false)
    expect(s.summary.state).toBe('running')
    const req2 = second.at(-1) as Extract<AgentEvent, { kind: 'permission_request' }>
    const toIdle = collect(s, (e) => e.kind === 'status' && e.state === 'idle')
    s.decide(req2.requestId, { behavior: 'allow' })
    await toIdle
    expect(s.summary.costUsd).toBeCloseTo(0.0246)
  })

  it('text deltas never consume seq numbers (restart-safe numbering)', async () => {
    const s = makeStore().create({ mode: 'bypassPermissions' })
    const seen: EventEnvelope[] = []
    s.subscribe((e) => seen.push(e))
    const toEnd = collect(s, (e) => e.kind === 'turn_end')
    s.send('hi')
    await toEnd
    const persisted = s.allEvents().map((e) => e.seq)
    expect(persisted).toEqual(persisted.map((_, i) => i + 1))
    for (const d of seen.filter((e) => e.event.kind === 'text_delta')) expect(persisted).toContain(d.seq)
  })

  it('carries cost across a Claude Code process restart', async () => {
    const store = makeStore()
    const s = store.create({ mode: 'bypassPermissions' })
    const t1 = collect(s, (e) => e.kind === 'status' && e.state === 'idle')
    s.send('a')
    await t1
    store.closeAll()
    const again = makeStore().get(s.id)!
    const t2 = collect(again, (e) => e.kind === 'turn_end')
    again.send('b')
    await t2
    expect(again.summary.costUsd).toBeCloseTo(0.0246)
  })

  it('rejects empty messages and unknown sessions', () => {
    const store = makeStore()
    expect(() => store.create().send('   ')).toThrow('Message is empty')
    expect(store.get('nope')).toBeNull()
  })
})
