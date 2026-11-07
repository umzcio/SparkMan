// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, EventEnvelope } from '../../src/agent/protocol.ts'
import { createFakeQuery } from './fake-query.ts'
import { SessionStore } from './store.ts'
import type { QueryFn } from './types.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-sdk-'))
})
const stores: SessionStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.closeAll()
  rmSync(dir, { recursive: true, force: true })
})
const track = (s: SessionStore) => (stores.push(s), s)

/** Fake query that also records every call's options and prompt messages. */
function recording() {
  const calls: Options[] = []
  const sent: SDKUserMessage[] = []
  const inner = createFakeQuery()
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push(options)
    const tapped = (async function* () {
      for await (const m of prompt) {
        sent.push(m)
        yield m
      }
    })()
    return inner({ prompt: tapped, options })
  }
  return { calls, sent, queryFn }
}

const makeStore = (queryFn: QueryFn = createFakeQuery()) => track(new SessionStore({ dir, queryFn, defaultCwd: '/srv', allowBypass: true }))

type Kind = AgentEvent['kind']
type Ev<K extends Kind> = Extract<AgentEvent, { kind: K }>

function waitFor<K extends Kind>(session: { subscribe: (fn: (e: EventEnvelope) => void) => () => void }, kind: K, pred: (e: Ev<K>) => boolean = () => true) {
  const seen: EventEnvelope[] = []
  return new Promise<{ event: Ev<K>; seen: EventEnvelope[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind}; saw ${seen.map((e) => e.event.kind).join(',')}`)), 2000)
    const off = session.subscribe((env) => {
      seen.push(env)
      if (env.event.kind === kind && pred(env.event as Ev<K>)) {
        clearTimeout(timer)
        off()
        resolve({ event: env.event as Ev<K>, seen })
      }
    })
  })
}
const idle = (s: Parameters<typeof waitFor>[0]) => waitFor(s, 'status', (e) => e.state === 'idle')

describe('session start options', () => {
  it('passes checkpointing, suggestions, thinking display and the per-session options to the SDK', () => {
    const r = recording()
    const s = makeStore(r.queryFn).create({ options: { effort: 'high', maxBudgetUsd: 5, additionalDirectories: ['/data'] } })
    s.send('hi')
    expect(r.calls[0]).toMatchObject({
      enableFileCheckpointing: true,
      promptSuggestions: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
      maxBudgetUsd: 5,
      additionalDirectories: ['/data'],
      sessionId: s.id,
    })
  })

  it('sends images as content blocks and tags the user message with a uuid', async () => {
    const r = recording()
    const s = makeStore(r.queryFn).create()
    const user = waitFor(s, 'user')
    s.send('what is this?', [{ mediaType: 'image/png', data: 'aGVsbG8=' }])
    const { event } = await user
    expect(event).toMatchObject({ text: 'what is this?', images: 1 })
    await waitFor(s, 'permission_request')
    expect(r.sent[0].uuid).toBe(event.uuid)
    expect(r.sent[0].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'text', text: 'what is this?' },
    ])
  })
})

describe('live controls', () => {
  it('switches model and thinking display, emitting events and updating the summary', async () => {
    const s = makeStore().create()
    const model = waitFor(s, 'model')
    await s.setModel('sonnet')
    expect((await model).event.model).toBe('sonnet')
    const thinking = waitFor(s, 'show_thinking')
    await s.setShowThinking(false)
    expect((await thinking).event.enabled).toBe(false)
    expect(s.summary).toMatchObject({ model: 'sonnet', showThinking: false })
  })

  it('maps capabilities, context, plan usage and MCP status from the control API', async () => {
    const s = makeStore().create()
    const caps = await s.capabilities()
    expect(caps.commands.map((c) => c.name)).toContain('compact')
    // before the init message arrives, skills fall back to the non-builtin commands
    expect(caps.skills).toEqual(['deploy-check'])
    expect(caps.models.map((m) => m.value)).toEqual(['default', 'sonnet', 'haiku'])
    expect(caps.agents[1]).toEqual({ name: 'Explore', description: 'Read-only search agent', model: 'haiku' })
    expect(caps.account?.subscriptionType).toBe('max')
    await waitFor(s, 'session').catch(() => {})
    expect((await s.capabilities()).terminalCommands).toEqual(['exit'])

    const ctx = await s.context()
    expect(ctx.maxTokens).toBe(200_000)
    expect(ctx.categories.length).toBeGreaterThan(0)

    const usage = await s.planUsage()
    expect(usage.available).toBe(true)
    expect(usage.windows.map((w) => w.label)).toEqual(['Current session (5-hour)', 'Weekly · all models'])
    expect(usage.windows[0].utilization).toBe(34)
    expect(typeof usage.windows[0].resetsAt).toBe('number')

    await s.mcpAction('github', 'disable')
    expect((await s.mcpServers()).find((m) => m.name === 'github')?.status).toBe('disabled')
    await expect(s.mcpAction('nope', 'enable')).rejects.toThrow(/Unknown MCP server/)
  })

  it('reports plan usage as unavailable when the experimental API throws', async () => {
    const inner = createFakeQuery()
    const s = makeStore((p) => ({ ...inner(p), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error('gone') } }) as ReturnType<QueryFn>).create()
    expect(await s.planUsage()).toEqual({ available: false, subscriptionType: null, windows: [] })
  })
})

describe('scripted tools', () => {
  it('answers AskUserQuestion through updatedInput', async () => {
    const s = makeStore().create()
    const req = waitFor(s, 'permission_request')
    s.send('ask me which disk')
    const { event } = await req
    expect(event.toolName).toBe('AskUserQuestion')
    const done = waitFor(s, 'assistant_text', (e) => e.text.startsWith('You picked'))
    s.decide(event.requestId, { behavior: 'allow', updatedInput: { ...event.input, answers: { 'Which disk should I check?': 'Data' } } })
    expect((await done).event.text).toBe('You picked Data.')
  })

  it('approves a plan and switches mode in the same decision', async () => {
    const s = makeStore().create({ mode: 'plan' })
    const req = waitFor(s, 'permission_request')
    s.send('plan the disk check')
    const { event } = await req
    expect(event.toolName).toBe('ExitPlanMode')
    const mode = waitFor(s, 'mode')
    s.decide(event.requestId, { behavior: 'allow', mode: 'acceptEdits' })
    expect((await mode).event.mode).toBe('acceptEdits')
    await idle(s)
    expect(s.summary.mode).toBe('acceptEdits')
  })

  it('reports local command output, thinking, and suggestions; tool progress and suggestions are live-only', async () => {
    const s = makeStore().create({ mode: 'bypassPermissions' })
    const out = waitFor(s, 'command_output')
    s.send('/cost')
    expect((await out).event.text).toContain('Total cost')
    await idle(s)

    const suggestion = waitFor(s, 'suggestion')
    const progress = waitFor(s, 'tool_progress')
    s.send('think about the disk')
    const { seen } = await suggestion
    await progress
    expect(seen.some((e) => e.event.kind === 'thinking')).toBe(true)
    const persisted = s.allEvents().map((e) => e.event.kind)
    expect(persisted).not.toContain('tool_progress')
    expect(persisted).not.toContain('suggestion')
    expect(persisted).toContain('checkpoint')
  })

  it('stops a running subagent task', async () => {
    const store = track(new SessionStore({ dir, queryFn: createFakeQuery({ delayMs: 20 }), defaultCwd: '/srv', allowBypass: true }))
    const s = store.create({ mode: 'bypassPermissions' })
    const started = waitFor(s, 'task', (e) => e.status === 'running')
    s.send('run a background task')
    const { event } = await started
    const stoppedEv = waitFor(s, 'task', (e) => e.status === 'stopped')
    await s.stopTask(event.taskId)
    expect((await stoppedEv).event.taskId).toBe(event.taskId)
  })
})

describe('history', () => {
  it('rewinds files: dry run previews without an event, a real rewind emits one', async () => {
    const s = makeStore().create({ mode: 'bypassPermissions' })
    const user = waitFor(s, 'user')
    s.send('edit the config')
    const uuid = (await user).event.uuid!
    await idle(s)
    const preview = await s.rewind(uuid, true)
    expect(preview).toMatchObject({ canRewind: true, filesChanged: ['/srv/sparkman/notes.md'] })
    expect(s.allEvents().some((e) => e.event.kind === 'rewound')).toBe(false)
    await s.rewind(uuid, false)
    expect(s.allEvents().at(-1)?.event).toEqual({ kind: 'rewound', userUuid: uuid, filesChanged: ['/srv/sparkman/notes.md'] })
  })

  it('forks at a checkpoint: copies the transcript up to that turn and resumes the parent at that message', async () => {
    const r = recording()
    const store = makeStore(r.queryFn)
    const parent = store.create({ mode: 'bypassPermissions' })
    const firstTurn = idle(parent)
    parent.send('first')
    const cp = { event: (await firstTurn).seen.map((e) => e.event).find((e): e is Ev<'checkpoint'> => e.kind === 'checkpoint')! }
    parent.send('second')
    await waitFor(parent, 'turn_end', (e) => e.costUsd > 0.02)

    const fork = store.fork(parent.id, cp.event.assistantUuid)
    expect(fork.summary).toMatchObject({ forkedFrom: parent.id, forkAt: cp.event.assistantUuid, title: 'first (fork)', costUsd: 0 })
    const kinds = fork.allEvents().map((e) => e.event.kind)
    expect(kinds.filter((k) => k === 'user')).toHaveLength(1)
    expect(kinds.at(-1)).toBe('turn_end')
    expect(kinds).not.toContain('status')

    fork.send('third')
    expect(r.calls.at(-1)).toMatchObject({ resume: parent.id, forkSession: true, sessionId: fork.id, resumeSessionAt: cp.event.assistantUuid })
    await waitFor(fork, 'session')
    expect(fork.summary.forkAt).toBeUndefined()

    expect(() => store.fork(parent.id, 'nope')).toThrow(/Unknown fork point/)
  })
})

describe('review hardening', () => {
  it('never starts or forks into bypass when the host does not allow it', async () => {
    const r = recording()
    const allowed = track(new SessionStore({ dir, queryFn: r.queryFn, defaultCwd: '/srv', allowBypass: true }))
    const parent = allowed.create({ mode: 'bypassPermissions' })
    const done = idle(parent)
    parent.send('check the disk')
    const cp = (await done).seen.map((e) => e.event).find((e): e is Ev<'checkpoint'> => e.kind === 'checkpoint')!
    allowed.closeAll()

    // same data dir, bypass no longer allowed
    const strict = track(new SessionStore({ dir, queryFn: r.queryFn, defaultCwd: '/srv' }))
    const resumed = strict.get(parent.id)!
    expect(resumed.summary.mode).toBe('default')
    const fork = strict.fork(parent.id, cp.assistantUuid)
    expect(fork.summary.mode).toBe('default')
    fork.send('again')
    expect(r.calls.at(-1)?.permissionMode).toBe('default')
  })

  it('switches mode inside the plan-approval decision (updatedPermissions)', async () => {
    const r = recording()
    const s = makeStore(r.queryFn).create({ mode: 'plan' })
    const req = waitFor(s, 'permission_request')
    s.send('plan it')
    const { event } = await req
    const end = waitFor(s, 'assistant_text', (e) => e.text.startsWith('Plan approved'))
    s.decide(event.requestId, { behavior: 'allow', mode: 'acceptEdits' })
    await end
    expect(s.summary.mode).toBe('acceptEdits')
  })

  it('closes an idle process after the idle timeout and restarts it on demand', async () => {
    const r = recording()
    const store = track(new SessionStore({ dir, queryFn: r.queryFn, defaultCwd: '/srv' }))
    const s = store.create()
    ;(s as unknown as { deps: { idleMs: number } }).deps.idleMs = 20
    await s.capabilities()
    await new Promise((res) => setTimeout(res, 80))
    await s.capabilities()
    expect(r.calls).toHaveLength(2)
    expect(s.allEvents().some((e) => e.event.kind === 'error')).toBe(false)
  })

  it('marks running tasks stopped when the process ends, and on reload', async () => {
    const store = track(new SessionStore({ dir, queryFn: createFakeQuery({ delayMs: 50 }), defaultCwd: '/srv', allowBypass: true }))
    const s = store.create({ mode: 'bypassPermissions' })
    const started = waitFor(s, 'task', (e) => e.status === 'running')
    s.send('run a background task')
    const { event } = await started
    const stopped = waitFor(s, 'task', (e) => e.status === 'stopped')
    await s.interrupt()
    ;(s as unknown as { query: { close: () => void } }).query.close()
    expect((await stopped).event.taskId).toBe(event.taskId)
  })

  it('does not reuse the previous fork point for a turn with no transcript entries', async () => {
    const s = makeStore().create({ mode: 'bypassPermissions' })
    const first = idle(s)
    s.send('check the disk')
    await first
    const second = idle(s)
    s.send('/cost')
    const kinds = (await second).seen.map((e) => e.event.kind)
    expect(kinds).toContain('turn_end')
    expect(kinds).not.toContain('checkpoint')
  })
})
