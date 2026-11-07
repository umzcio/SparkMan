// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent, EventEnvelope, SessionSummary } from '../../src/agent/protocol.ts'
import { SessionStore } from '../agent/store.ts'
import { createApp } from '../app.ts'
import { createFakeAppServer } from './fake-app-server.ts'
import { CodexHost } from './host.ts'
import type { CodexTransport, RpcMessage } from './rpc.ts'
import { CodexSession } from './session.ts'

let dir: string
const cleanup: (() => void)[] = []
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-codex-'))
})
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  rmSync(dir, { recursive: true, force: true })
})

/** A Codex store on the fake app-server; `sent` records every client → server message. */
function setup(opts: { allowBypass?: boolean } = {}) {
  const sent: RpcMessage[] = []
  const fake = createFakeAppServer()
  const host = new CodexHost((): CodexTransport => {
    const t = fake()
    return { ...t, send: (m) => (sent.push(m), t.send(m)) }
  })
  const make = () =>
    new SessionStore({
      dir,
      defaultCwd: '/srv',
      defaultMode: 'auto',
      allowBypass: opts.allowBypass,
      factory: (summary, events, hooks) => new CodexSession(summary, events, { ...hooks, host, allowBypass: opts.allowBypass }),
    })
  const store = make()
  cleanup.push(() => {
    store.closeAll()
    host.close()
  })
  return { store, host, sent, make }
}

type Kind = AgentEvent['kind']
type Ev<K extends Kind> = Extract<AgentEvent, { kind: K }>
function waitFor<K extends Kind>(s: { subscribe: (fn: (e: EventEnvelope) => void) => () => void }, kind: K, pred: (e: Ev<K>) => boolean = () => true) {
  const seen: AgentEvent[] = []
  return new Promise<{ event: Ev<K>; seen: AgentEvent[] }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${kind}; saw ${seen.map((e) => e.kind).join(',')}`)), 2000)
    const off = s.subscribe((env) => {
      seen.push(env.event)
      if (env.event.kind === kind && pred(env.event as Ev<K>)) {
        clearTimeout(timer)
        off()
        resolve({ event: env.event as Ev<K>, seen })
      }
    })
  })
}
const idle = (s: Parameters<typeof waitFor>[0]) => waitFor(s, 'status', (e) => e.state === 'idle')

describe('CodexSession', () => {
  it('runs a turn in auto mode without asking: streams, runs the command, reports tokens', async () => {
    const { store, sent } = setup()
    const s = store.create()
    expect(s.summary.mode).toBe('auto')
    const done = idle(s)
    s.send('How full is the disk?')
    const kinds = (await done).seen.map((e) => e.kind)
    expect(kinds).toContain('session')
    expect(kinds).toContain('thinking')
    expect(kinds).not.toContain('permission_request')
    const events = s.allEvents().map((e) => e.event)
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'Shell', input: { command: 'df -h /' } })
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: false })
    expect(events.find((e) => e.kind === 'turn_end')).toMatchObject({ costUsd: 0, tokens: 2400, isError: false })
    expect(s.summary.threadId).toMatch(/^thr_fake/)
    const turnStart = sent.find((m) => m.method === 'turn/start')!.params as Record<string, unknown>
    expect(turnStart).toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, summary: 'auto' })
  })

  it('asks before commands in "Ask every time" mode and reports a decline', async () => {
    const { store } = setup()
    const s = store.create({ mode: 'untrusted' })
    const req = waitFor(s, 'permission_request')
    s.send('check the disk')
    const { event } = await req
    expect(event).toMatchObject({ toolName: 'Shell', input: { command: 'df -h /' } })
    const done = waitFor(s, 'assistant_text', (e) => e.text.startsWith('Okay'))
    s.decide(event.requestId, { behavior: 'deny' })
    await done
    expect(s.allEvents().map((e) => e.event).find((e) => e.kind === 'tool_result')).toMatchObject({ isError: true })
  })

  it('answers request_user_input questions through the question card', async () => {
    const { store } = setup()
    const s = store.create()
    const req = waitFor(s, 'permission_request')
    s.send('ask me which disk')
    const { event } = await req
    expect(event.toolName).toBe('AskUserQuestion')
    const done = waitFor(s, 'assistant_text', (e) => e.text.startsWith('You picked'))
    s.decide(event.requestId, { behavior: 'allow', updatedInput: { ...event.input, answers: { 'Which disk should I check?': 'Data' } } })
    expect((await done).event.text).toBe('You picked Data.')
  })

  it('shows file changes for approval and updates the plan card in place', async () => {
    const { store } = setup()
    const s = store.create({ mode: 'read-only' })
    const req = waitFor(s, 'permission_request')
    s.send('edit the config')
    const { event } = await req
    expect(event.toolName).toBe('ApplyPatch')
    expect((event.input.changes as { diff: string }[])[0].diff).toContain('+replicas: 3')
    const done = idle(s)
    s.decide(event.requestId, { behavior: 'allow', forSession: true })
    await done

    const planDone = idle(s)
    s.send('make a plan')
    await planDone
    const plans = s.allEvents().map((e) => e.event).filter((e): e is Ev<'tool_use'> => e.kind === 'tool_use' && e.name === 'TodoWrite')
    expect(plans).toHaveLength(2)
    expect(new Set(plans.map((p) => p.toolUseId)).size).toBe(1)
  })

  it('applies mode, model and thinking on the next turn, and never offers full access without opt-in', async () => {
    const { store, sent } = setup()
    const s = store.create({ mode: 'full-access' })
    expect(s.summary.mode).toBe('auto')
    await expect(s.setMode('full-access')).rejects.toThrow(/disabled/)
    await expect(s.setMode('bypassPermissions')).rejects.toThrow(/Unknown/)
    await s.setMode('read-only')
    await s.setModel('gpt-6.1-mini')
    await s.setShowThinking(false)
    const req = waitFor(s, 'permission_request')
    s.send('check the disk')
    await req
    const turnStart = sent.filter((m) => m.method === 'turn/start').at(-1)!.params as Record<string, unknown>
    expect(turnStart).toMatchObject({ model: 'gpt-6.1-mini', summary: 'none', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } })
  })

  it('queues messages sent mid-turn and drops the queue on interrupt', async () => {
    const { store, sent } = setup()
    const s = store.create({ mode: 'untrusted' })
    const req = waitFor(s, 'permission_request')
    s.send('check the disk')
    s.send('and again')
    await req
    const done = idle(s)
    await s.interrupt()
    const { seen } = await done
    expect(seen.some((e) => e.kind === 'notice' && e.text.includes('Dropped 1 queued'))).toBe(true)
    expect(sent.filter((m) => m.method === 'turn/start')).toHaveLength(1)
    expect(sent.some((m) => m.method === 'turn/interrupt')).toBe(true)
  })

  it('resumes its thread after a SparkMan restart', async () => {
    const { store, make, sent, host } = setup()
    const s = store.create()
    const done = idle(s)
    s.send('check the disk')
    await done
    const threadId = s.summary.threadId
    store.closeAll()
    host.close() // the app-server goes too
    const again = make().get(s.id)!
    expect(again.summary.threadId).toBe(threadId)
    const done2 = idle(again)
    again.send('check again')
    await done2
    expect(sent.find((m) => m.method === 'thread/resume')?.params).toMatchObject({ threadId })
  })

  it('maps capabilities, usage, context, MCP and plugins; unsupported actions are flagged', async () => {
    const { store } = setup()
    const s = store.create()
    const caps = await s.capabilities()
    expect(caps.models.map((m) => m.value)).toEqual(['gpt-6.1-sol', 'gpt-6.1-mini'])
    expect(caps.account).toMatchObject({ email: 'ops@example.com', subscriptionType: 'ChatGPT edu' })
    expect(caps.skills).toEqual(['deploy-check'])
    expect(caps.commands).toEqual([])
    expect((await s.planUsage()).windows.map((w) => [w.label, w.utilization])).toEqual([
      ['Current session (5-hour)', 21],
      ['Weekly', 8],
    ])
    expect((await s.context()).totalTokens).toBe(0)
    const done = idle(s)
    s.send('check the disk')
    await done
    expect(await s.context()).toMatchObject({ totalTokens: 2400, maxTokens: 272_000 })
    expect((await s.mcpServers())[0]).toMatchObject({ name: 'github', status: 'connected' })
    await expect(s.mcpAction('github', 'disable')).rejects.toThrow(/isn’t available/)
    await expect(s.rewind('x', true)).rejects.toThrow(/isn’t available/)

    const plugins = await s.plugins()
    expect(plugins.find((p) => p.id === 'github@openai-curated')).toMatchObject({ installed: false, marketplace: 'openai-curated' })
    await s.pluginAction('github@openai-curated', 'install')
    expect((await s.plugins()).find((p) => p.id === 'github@openai-curated')?.installed).toBe(true)
    await s.pluginAction('github@openai-curated', 'uninstall')
    expect((await s.plugins()).find((p) => p.id === 'github@openai-curated')?.installed).toBe(false)
  })

  it('is served under /api/codex with Codex modes, 501s for unsupported actions, and no fork', async () => {
    const { store: codexStore } = setup()
    const claude = new SessionStore({ dir: path.join(dir, 'claude'), queryFn: (() => { throw new Error('unused') }) as never, defaultCwd: '/srv' })
    cleanup.push(() => claude.closeAll())
    const app = createApp({ store: claude, codexStore, allowedUsers: [], defaultCwd: '/srv', fake: true, isLoopback: () => true })
    const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await app.request('/api/codex/health')).status).toBe(200)
    expect((await app.request('/api/codex/sessions', json({ mode: 'bypassPermissions' }))).status).toBe(400)
    expect((await app.request('/api/codex/sessions', json({ mode: 'full-access' }))).status).toBe(400)
    const s = (await (await app.request('/api/codex/sessions', json({ mode: 'untrusted' }))).json()) as SessionSummary
    expect(s.mode).toBe('untrusted')
    expect((await app.request(`/api/codex/sessions/${s.id}/rewind`, json({ userUuid: 'u', dryRun: true }))).status).toBe(501)
    expect((await app.request(`/api/codex/sessions/${s.id}/fork`, json({ atUuid: 'x' }))).status).toBe(501)
    expect((await app.request(`/api/codex/sessions/${s.id}/plugins`)).status).toBe(200)
    expect((await app.request(`/api/agent/sessions/${s.id}`)).status).toBe(404)
    expect((await app.request(`/api/agent/sessions/${s.id}/plugins`)).status).toBe(404)
  })
})
