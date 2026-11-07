import type { CodexTransport, RpcMessage } from './rpc.ts'

/**
 * Scripted stand-in for `codex app-server` so tests and the e2e suite never call OpenAI.
 * A default turn streams a sentence, runs `df -h /` (asking first in "Ask every time" or read-only)
 * and reports token usage. Keywords script other paths: "ask me" request_user_input ·
 * "edit" a file change · "plan" plan updates.
 */
export function createFakeAppServer(opts: { delayMs?: number } = {}): () => CodexTransport {
  const delay = opts.delayMs ?? 0
  const sleep = (n = 1) => (delay > 0 ? new Promise((r) => setTimeout(r, delay * n)) : Promise.resolve())
  // plugin install state survives app-server restarts, like the real ~/.codex
  const installed = new Set(['documents@openai-primary-runtime', 'linear@openai-curated'])

  return () => {
    const onMsg: ((m: RpcMessage) => void)[] = []
    const onEnd: ((r: string) => void)[] = []
    const waiting = new Map<string, (result: unknown) => void>()
    const interrupted = new Set<string>()
    let threadSeq = 0
    let turnSeq = 0
    let reqSeq = 0
    let closed = false
    const tokens = new Map<string, number>()

    const out = (m: RpcMessage) => {
      if (closed) return
      // deliver asynchronously, like a pipe
      queueMicrotask(() => onMsg.forEach((fn) => fn(m)))
    }
    const notify = (method: string, params: unknown) => out({ method, params })
    const ask = (method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = `srv-${++reqSeq}`
        waiting.set(id, resolve as (r: unknown) => void)
        out({ id, method, params })
      })

    async function say(threadId: string, turnId: string, itemId: string, text: string) {
      notify('item/started', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text: '' } })
      for (const piece of text.match(/.{1,12}/g) ?? []) {
        await sleep()
        notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: piece })
      }
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: itemId, text } })
    }

    async function runTurn(threadId: string, turnId: string, text: string, params: Record<string, unknown>) {
      const approval = params.approvalPolicy as string
      const sandbox = (params.sandboxPolicy as { type: string } | undefined)?.type
      const lower = text.toLowerCase()
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress', error: null, durationMs: null, items: [] } })
      await sleep()
      if (params.summary !== 'none') {
        notify('item/completed', { threadId, turnId, item: { type: 'reasoning', id: `${turnId}-r`, summary: ['Checking disk usage with df is the quickest way.'], content: [] } })
      }
      if (lower.includes('ask me')) {
        const answer = await ask('item/tool/requestUserInput', {
          threadId, turnId, itemId: `${turnId}-q`, isBlocking: true, autoResolutionMs: null,
          questions: [{ id: 'disk', header: 'Disk', question: 'Which disk should I check?', isOther: true, isSecret: false, options: [{ label: 'Root', description: 'The / filesystem' }, { label: 'Data', description: 'The /data volume' }] }],
        })
        const picked = (answer.answers as Record<string, { answers: string[] }> | undefined)?.disk?.answers[0]
        await say(threadId, turnId, `${turnId}-a`, picked ? `You picked ${picked}.` : 'Okay — I’ll pick for you.')
      } else if (lower.includes('plan')) {
        notify('turn/plan/updated', { threadId, turnId, explanation: null, plan: [{ step: 'Check disk usage', status: 'inProgress' }, { step: 'Report findings', status: 'pending' }] })
        await sleep()
        notify('turn/plan/updated', { threadId, turnId, explanation: null, plan: [{ step: 'Check disk usage', status: 'completed' }, { step: 'Report findings', status: 'inProgress' }] })
        await say(threadId, turnId, `${turnId}-a`, 'Plan is underway.')
      } else if (lower.includes('edit')) {
        const item = { type: 'fileChange', id: `${turnId}-f`, status: 'inProgress', changes: [{ path: '/srv/sparkman/notes.md', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n-replicas: 2\n+replicas: 3\n port: 8000\n' }] }
        notify('item/started', { threadId, turnId, item })
        let ok = true
        if (approval === 'untrusted' || sandbox === 'readOnly') {
          const r = await ask('item/fileChange/requestApproval', { threadId, turnId, itemId: item.id, startedAtMs: Date.now(), reason: 'Edit notes.md' })
          ok = r.decision === 'accept' || r.decision === 'acceptForSession'
        }
        notify('item/completed', { threadId, turnId, item: { ...item, status: ok ? 'completed' : 'declined' } })
        await say(threadId, turnId, `${turnId}-a`, ok ? 'Replicas are now 3.' : 'Okay — I won’t edit it.')
      } else {
        await say(threadId, turnId, `${turnId}-a`, 'I’ll check that for you.')
        const cmd = { type: 'commandExecution', id: `${turnId}-c`, command: 'df -h /', cwd: '/srv', status: 'inProgress', aggregatedOutput: null, exitCode: null }
        notify('item/started', { threadId, turnId, item: cmd })
        let ok = true
        if (approval === 'untrusted' || sandbox === 'readOnly') {
          const r = await ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: cmd.id, startedAtMs: Date.now(), command: 'df -h /', cwd: '/srv', reason: 'Check root filesystem usage' })
          ok = r.decision === 'accept' || r.decision === 'acceptForSession'
        }
        if (interrupted.has(turnId)) return finish(threadId, turnId, 'interrupted')
        await sleep()
        notify('item/completed', {
          threadId, turnId,
          item: ok
            ? { ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  3.6T  1.5T  2.1T  42% /' }
            : { ...cmd, status: 'declined' },
        })
        await say(threadId, turnId, `${turnId}-b`, ok ? 'Root filesystem is 42% full (2.1 TB free).' : 'Okay — I won’t run that.')
      }
      finish(threadId, turnId, interrupted.has(turnId) ? 'interrupted' : 'completed')
    }

    function finish(threadId: string, turnId: string, status: string) {
      const total = (tokens.get(threadId) ?? 0) + 2400
      tokens.set(threadId, total)
      const last = { totalTokens: 2400, inputTokens: 2100, cachedInputTokens: 1500, cacheWriteInputTokens: 0, outputTokens: 300, reasoningOutputTokens: 80 }
      notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { ...last, totalTokens: total }, last, modelContextWindow: 272_000 } })
      notify('turn/completed', { threadId, turn: { id: turnId, status, error: null, durationMs: 1234, items: [] } })
    }

    const markets = () => [
      {
        name: 'openai-primary-runtime', path: '/home/codex/.cache/plugins/marketplace.json',
        plugins: [{ id: 'documents@openai-primary-runtime', name: 'documents', interface: { displayName: 'Documents', shortDescription: 'Read and write Office documents' }, version: null, localVersion: '26.9.1' }],
      },
      {
        name: 'openai-curated', path: null,
        plugins: [
          { id: 'github@openai-curated', name: 'github', interface: { displayName: 'GitHub', shortDescription: 'Issues, PRs and code search' }, version: '1.2.0', localVersion: null },
          { id: 'linear@openai-curated', name: 'linear', interface: { displayName: 'Linear', shortDescription: 'Plan and track work' }, version: '0.9.0', localVersion: null },
        ],
      },
    ].map((m) => ({ ...m, plugins: m.plugins.map((p) => ({ ...p, installed: installed.has(p.id), enabled: installed.has(p.id) })) }))

    function handle(msg: RpcMessage): unknown {
      const p = (msg.params ?? {}) as Record<string, unknown>
      switch (msg.method) {
        case 'initialize':
          return { userAgent: 'sparkman/0.0.0-fake (fake)', codexHome: '/home/codex/.codex', platformFamily: 'unix', platformOs: 'linux' }
        case 'model/list':
          return {
            data: [
              { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', description: 'Workhorse model for coding', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }] },
              { id: 'gpt-6.1-mini', model: 'gpt-6.1-mini', displayName: 'GPT-6.1-Mini', description: 'Fast and cheap', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] },
            ],
            nextCursor: null,
          }
        case 'account/read':
          return { account: { type: 'chatgpt', email: 'ops@example.com', planType: 'edu' }, requiresOpenaiAuth: true }
        case 'account/rateLimits/read':
          return { rateLimits: { primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: 1_791_605_306 }, secondary: { usedPercent: 8, windowDurationMins: 10_080, resetsAt: 1_792_192_106 }, planType: 'edu' } }
        case 'skills/list':
          return { data: [{ cwd: (p.cwds as string[] | undefined)?.[0] ?? '/', skills: [{ name: 'deploy-check', description: 'Check a Spark node is ready to deploy', enabled: true }], errors: [] }] }
        case 'mcpServerStatus/list':
          return { data: [{ name: 'github', runtimeStatus: 'connected', serverInfo: { version: '1.4.0' }, tools: { create_issue: { name: 'create_issue', description: 'Create an issue' } }, toolsError: null, authStatus: 'oAuth' }], nextCursor: null }
        case 'config/mcpServer/reload':
          return {}
        case 'plugin/list':
          return { marketplaces: markets(), marketplaceLoadErrors: [], featuredPluginIds: [] }
        case 'plugin/install': {
          const id = markets().flatMap((m) => m.plugins).find((x) => x.name === p.pluginName)?.id
          if (!id) throw new Error(`Unknown plugin ${String(p.pluginName)}`)
          installed.add(id)
          return {}
        }
        case 'plugin/uninstall':
          installed.delete(String(p.pluginId))
          return {}
        case 'thread/start': {
          const id = `thr_fake_${++threadSeq}_${Math.random().toString(36).slice(2, 8)}`
          return { thread: { id, model: (p.model as string) ?? 'gpt-6.1-sol' }, model: (p.model as string) ?? 'gpt-6.1-sol', cwd: p.cwd ?? '/' }
        }
        case 'thread/resume':
          return { thread: { id: p.threadId, model: 'gpt-6.1-sol' }, model: 'gpt-6.1-sol', cwd: p.cwd ?? '/' }
        case 'turn/start': {
          const turnId = `turn_fake_${++turnSeq}`
          const input = (p.input as { type: string; text?: string }[]) ?? []
          const text = input.map((i) => i.text ?? '').join(' ')
          setTimeout(() => void runTurn(String(p.threadId), turnId, text, p), 0)
          return { turn: { id: turnId, status: 'inProgress', error: null, durationMs: null, items: [] } }
        }
        case 'turn/interrupt': {
          interrupted.add(String(p.turnId))
          // a pending approval is cancelled when the turn is interrupted
          for (const [id, resolve] of waiting) {
            waiting.delete(id)
            resolve({ decision: 'cancel' })
          }
          return {}
        }
        default:
          throw new Error(`fake app-server: ${msg.method} not implemented`)
      }
    }

    return {
      send(msg) {
        if (closed) return
        if (msg.method && msg.id !== undefined) {
          try {
            out({ id: msg.id, result: handle(msg) })
          } catch (err) {
            out({ id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
          }
        } else if (msg.id !== undefined && waiting.has(String(msg.id))) {
          const resolve = waiting.get(String(msg.id))!
          waiting.delete(String(msg.id))
          resolve(msg.result ?? {})
        }
      },
      onMessage: (fn) => onMsg.push(fn),
      onClose: (fn) => onEnd.push(fn),
      close() {
        if (closed) return
        closed = true
        onEnd.forEach((fn) => fn('closed'))
      },
    }
  }
}
