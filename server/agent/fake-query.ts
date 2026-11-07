import type { PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentMode } from '../../src/agent/protocol.ts'
import type { AgentQuery, QueryFn } from './types.ts'

type Q = AgentQuery
type Init = Awaited<ReturnType<Q['initializationResult']>>
type Commands = Awaited<ReturnType<Q['supportedCommands']>>
type Mcp = Awaited<ReturnType<Q['mcpServerStatus']>>
type Context = Awaited<ReturnType<Q['getContextUsage']>>
type Usage = Awaited<ReturnType<Q['usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET']>>

const COMMANDS = [
  { name: 'compact', description: 'Clear conversation history but keep a summary in context', argumentHint: '<optional instructions>', builtin: true },
  { name: 'cost', description: 'Show the total cost and duration of the current session', argumentHint: '', builtin: true },
  { name: 'context', description: 'Visualize current context usage', argumentHint: '', builtin: true },
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>', builtin: true },
  { name: 'exit', description: 'Exit the REPL', argumentHint: '', builtin: true },
  { name: 'deploy-check', description: 'Check a Spark node is ready to deploy (skill)', argumentHint: '<node>' },
] as unknown as Commands

const INIT = {
  commands: COMMANDS,
  agents: [
    { name: 'general-purpose', description: 'General-purpose agent for multi-step tasks' },
    { name: 'Explore', description: 'Read-only search agent', model: 'haiku' },
  ],
  output_style: 'default',
  available_output_styles: ['default', 'Explanatory'],
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · most capable', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · fast everyday model', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5 · fastest' },
  ],
  account: { email: 'ops@example.com', subscriptionType: 'max', apiProvider: 'firstParty' },
} as unknown as Init

/**
 * Scripted stand-in for the Agent SDK's query(): deterministic SDK-shaped messages so tests and
 * the e2e suite never spend money. A default turn streams a sentence, calls Bash (asking permission
 * when the mode would) and reports a result with cost. Keywords in the prompt script other paths:
 * "/cmd" local command output · "ask me" AskUserQuestion · plan mode ExitPlanMode · "todo" TodoWrite ·
 * "edit" an Edit diff · "task" a background subagent task · "think" a thinking block.
 */
export function createFakeQuery(opts: { delayMs?: number } = {}): QueryFn {
  const delay = opts.delayMs ?? 0
  const sleep = (n = 1) => (delay > 0 ? new Promise((r) => setTimeout(r, delay * n)) : Promise.resolve())

  return ({ prompt, options }) => {
    let mode = (options.permissionMode ?? 'default') as AgentMode
    let model = options.model ?? 'claude-opus-5-5'
    let showThinking = options.thinking?.type !== 'adaptive' || options.thinking.display !== 'omitted'
    let interrupted = false
    let turn = 0
    let cost = 0
    const stopped = new Set<string>()
    const mcp: Mcp = [
      { name: 'github', status: 'connected', scope: 'user', serverInfo: { name: 'github', version: '1.4.0' }, tools: [{ name: 'create_issue', description: 'Create an issue' }, { name: 'get_file', description: 'Read a file', annotations: { readOnly: true } }] },
      { name: 'linear', status: 'needs-auth', scope: 'project', tools: [] },
    ] as unknown as Mcp
    const sessionId = options.sessionId ?? options.resume ?? 'fake-session'
    const msg = (m: Record<string, unknown>) =>
      ({ session_id: sessionId, uuid: `${sessionId}-${Math.random().toString(36).slice(2)}`, parent_tool_use_id: null, ...m }) as unknown as SDKMessage
    const ask = async (tool: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult> => {
      const d = (await options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: toolUseId, requestId: `req_${toolUseId}` })) ?? { behavior: 'deny', message: 'No decision' }
      if (d.behavior === 'allow') for (const u of d.updatedPermissions ?? []) if (u.type === 'setMode') mode = u.mode as AgentMode
      return d
    }
    const denial = (d: PermissionResult) => (d.behavior === 'deny' ? d.message : 'Denied')

    async function* say(id: string, text: string): AsyncGenerator<SDKMessage> {
      yield msg({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
      yield msg({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
      yield msg({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] } })
    }
    const toolUse = (id: string, toolUseId: string, name: string, input: Record<string, unknown>, text?: string) =>
      msg({ type: 'assistant', message: { id, role: 'assistant', content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id: toolUseId, name, input }] } })
    const toolResult = (toolUseId: string, content: string, isError = false) =>
      msg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content }] } })
    const result = (subtype = 'success', extra: Record<string, unknown> = {}) =>
      msg({ type: 'result', subtype, is_error: subtype !== 'success', total_cost_usd: Number(cost.toFixed(4)), duration_ms: 1234, num_turns: 2, stop_reason: 'end_turn', ...extra })

    async function* askQuestion(t: number): AsyncGenerator<SDKMessage> {
      const toolUseId = `toolu_ask_${t}`
      const input = { questions: [{ question: 'Which disk should I check?', header: 'Disk', multiSelect: false, options: [{ label: 'Root', description: 'The / filesystem' }, { label: 'Data', description: 'The /data volume' }] }] }
      yield toolUse(`msg_${t}a`, toolUseId, 'AskUserQuestion', input)
      const d = await ask('AskUserQuestion', input, toolUseId)
      const answers = d.behavior === 'allow' ? ((d.updatedInput as { answers?: Record<string, string> }).answers ?? {}) : {}
      const picked = Object.values(answers)[0]
      yield toolResult(toolUseId, picked ? `User answered: ${picked}` : 'User declined to answer', !picked)
      yield* say(`msg_${t}b`, picked ? `You picked ${picked}.` : "Okay — I'll pick for you.")
    }

    async function* planTurn(t: number): AsyncGenerator<SDKMessage> {
      const toolUseId = `toolu_plan_${t}`
      const input = { plan: '## Plan\n\n1. Check disk usage with `df -h`\n2. Report anything over 80%' }
      yield* say(`msg_${t}a`, "Here's my plan.")
      yield toolUse(`msg_${t}b`, toolUseId, 'ExitPlanMode', input)
      const d = await ask('ExitPlanMode', input, toolUseId)
      yield toolResult(toolUseId, d.behavior === 'allow' ? 'User approved the plan' : denial(d), d.behavior !== 'allow')
      yield* say(`msg_${t}c`, d.behavior === 'allow' ? 'Plan approved — starting now.' : "Okay — I'll keep planning.")
    }

    async function* todoTurn(t: number): AsyncGenerator<SDKMessage> {
      const toolUseId = `toolu_todo_${t}`
      const input = { todos: [
        { content: 'Check disk usage', activeForm: 'Checking disk usage', status: 'completed' },
        { content: 'Rotate old logs', activeForm: 'Rotating old logs', status: 'in_progress' },
        { content: 'Report findings', activeForm: 'Reporting findings', status: 'pending' },
      ] }
      yield toolUse(`msg_${t}a`, toolUseId, 'TodoWrite', input)
      yield toolResult(toolUseId, 'Todos have been modified successfully')
      yield* say(`msg_${t}b`, 'Tracking three steps.')
    }

    async function* editTurn(t: number): AsyncGenerator<SDKMessage> {
      const toolUseId = `toolu_edit_${t}`
      const input = { file_path: '/srv/sparkman/notes.md', old_string: 'replicas: 2\nport: 8000', new_string: 'replicas: 3\nport: 8000' }
      yield toolUse(`msg_${t}a`, toolUseId, 'Edit', input, "I'll bump the replica count.")
      const auto = mode === 'acceptEdits' || mode === 'bypassPermissions'
      const d: PermissionResult = auto ? { behavior: 'allow', updatedInput: input } : mode === 'plan' || mode === 'dontAsk' ? { behavior: 'deny', message: 'Not allowed in this mode' } : await ask('Edit', input, toolUseId)
      yield toolResult(toolUseId, d.behavior === 'allow' ? 'The file has been updated.' : denial(d), d.behavior !== 'allow')
      yield* say(`msg_${t}b`, d.behavior === 'allow' ? 'Replicas are now 3.' : "Okay — I won't edit it.")
    }

    async function* taskTurn(t: number): AsyncGenerator<SDKMessage> {
      const toolUseId = `toolu_task_${t}`
      const taskId = `task_${t}`
      yield toolUse(`msg_${t}a`, toolUseId, 'Agent', { description: 'Survey GPU memory', subagent_type: 'Explore', prompt: 'Survey GPU memory on every node' })
      yield msg({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'Survey GPU memory', subagent_type: 'Explore' })
      for (let i = 0; i < 3 && !stopped.has(taskId); i++) {
        await sleep(3)
        yield msg({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId, description: 'Survey GPU memory', subagent_type: 'Explore', last_tool_name: 'Bash', summary: `Checked ${i + 1} of 3 nodes`, usage: { total_tokens: 100, tool_uses: i + 1, duration_ms: 10 } })
      }
      const status = stopped.has(taskId) ? 'stopped' : 'completed'
      yield msg({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status, output_file: '', summary: status === 'stopped' ? 'Stopped by the operator' : 'All nodes under 70% GPU memory' })
      yield toolResult(toolUseId, status === 'stopped' ? 'Task stopped' : 'All nodes under 70% GPU memory')
      yield* say(`msg_${t}b`, status === 'stopped' ? 'The survey was stopped.' : 'Every node is under 70% GPU memory.')
    }

    async function* bashTurn(t: number): AsyncGenerator<SDKMessage> {
      const messageId = `msg_fake_${t}a`
      const toolUseId = `toolu_fake_${t}`
      const command = { command: 'df -h /', description: 'Check root filesystem usage' }
      yield msg({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } })
      for (const piece of ["I'll ", 'check that ', 'for you.']) {
        await sleep()
        yield msg({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } })
      }
      yield toolUse(messageId, toolUseId, 'Bash', command, "I'll check that for you.")

      let decision: PermissionResult
      // acceptEdits still asks for Bash, like Claude Code
      if (mode === 'bypassPermissions') decision = { behavior: 'allow', updatedInput: command }
      else if (mode === 'dontAsk') decision = { behavior: 'deny', message: 'Not pre-approved (dontAsk mode).' }
      else decision = (await options.canUseTool!('Bash', command, { signal: new AbortController().signal, toolUseID: toolUseId, requestId: `req_fake_${t}`, decisionReason: `Bash: ${command.command}` })) ?? { behavior: 'deny', message: 'No decision' }
      if (interrupted) return
      const allowed = decision.behavior === 'allow'
      if (allowed) yield msg({ type: 'tool_progress', tool_use_id: toolUseId, tool_name: 'Bash', elapsed_time_seconds: 1 })
      await sleep()
      yield toolResult(toolUseId, allowed ? 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p2  3.6T  1.5T  2.1T  42% /' : denial(decision), !allowed)
      yield* say(`msg_fake_${t}b`, allowed ? 'Root filesystem is 42% full (2.1 TB free).' : "Okay — I won't run that.")
    }

    async function* turnMessages(text: string): AsyncGenerator<SDKMessage> {
      turn += 1
      interrupted = false
      const t = turn
      const lower = text.toLowerCase()
      if (lower.startsWith('/')) {
        const name = lower.slice(1).split(/\s/)[0]
        yield msg({ type: 'system', subtype: 'local_command_output', content: name === 'cost' ? `Total cost: $${cost.toFixed(4)}\nTotal duration (API): 4.2s` : `/${name} ran (fake)` })
        yield result()
        return
      }
      if (lower.includes('think') && showThinking) {
        yield msg({ type: 'assistant', message: { id: `msg_${t}t`, role: 'assistant', content: [{ type: 'thinking', thinking: 'The user wants disk usage; df is the quickest check.', signature: 'x' }] } })
      }
      if (lower.includes('ask me')) yield* askQuestion(t)
      else if (mode === 'plan') yield* planTurn(t)
      else if (lower.includes('todo')) yield* todoTurn(t)
      else if (lower.includes('edit')) yield* editTurn(t)
      else if (lower.includes('task')) yield* taskTurn(t)
      else yield* bashTurn(t)
      if (interrupted) {
        yield result('error_during_execution', { errors: ['Interrupted'] })
        return
      }
      cost += 0.0123
      yield result()
      yield msg({ type: 'prompt_suggestion', suggestion: 'Check /data too' })
    }

    async function* run(): AsyncGenerator<SDKMessage> {
      yield msg({ type: 'system', subtype: 'init', cwd: options.cwd ?? '/', model, permissionMode: mode, claude_code_version: 'fake', tools: [], mcp_servers: [], slash_commands: COMMANDS.map((c) => c.name), terminal_slash_commands: ['exit'], apiKeySource: 'none', output_style: 'default', skills: ['deploy-check'], plugins: [] })
      for await (const user of prompt as AsyncIterable<SDKUserMessage>) {
        const content = user.message.content
        const text = typeof content === 'string' ? content : content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        yield* turnMessages(text)
      }
    }

    const gen = run()
    const query: AgentQuery = {
      [Symbol.asyncIterator]: () => gen,
      setPermissionMode: async (m) => {
        mode = m
      },
      setModel: async (m) => {
        model = m ?? 'claude-opus-5-5'
      },
      setMaxThinkingTokens: async (_max, display) => {
        showThinking = display !== 'omitted'
      },
      interrupt: async () => {
        interrupted = true
      },
      close: () => {
        void gen.return(undefined)
      },
      initializationResult: async () => INIT,
      supportedCommands: async () => COMMANDS,
      mcpServerStatus: async () => mcp,
      toggleMcpServer: async (name, enabled) => {
        const s = mcp.find((m) => m.name === name)
        if (!s) throw new Error(`Unknown MCP server: ${name}`)
        s.status = enabled ? 'connected' : 'disabled'
      },
      reconnectMcpServer: async (name) => {
        if (!mcp.some((m) => m.name === name)) throw new Error(`Unknown MCP server: ${name}`)
      },
      getContextUsage: async () =>
        ({
          model,
          totalTokens: 48_200 + turn * 1_500,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: ((48_200 + turn * 1_500) / 200_000) * 100,
          categories: [
            { name: 'System prompt', tokens: 3_100, color: 'promptBorder' },
            { name: 'System tools', tokens: 14_800, color: 'inactive' },
            { name: 'MCP tools', tokens: 6_200, color: 'cyan_FOR_SUBAGENTS_ONLY' },
            { name: 'Memory files', tokens: 1_900, color: 'claude' },
            { name: 'Messages', tokens: 22_200 + turn * 1_500, color: 'purple_FOR_SUBAGENTS_ONLY' },
          ],
          memoryFiles: [{ path: '~/.claude/CLAUDE.md', type: 'User', tokens: 1_900 }],
          mcpTools: [{ name: 'create_issue', serverName: 'github', tokens: 3_100 }],
          agents: [],
          isAutoCompactEnabled: true,
          gridRows: [],
        }) as unknown as Context,
      reloadSkills: async () => ({ skills: COMMANDS.filter((c) => c.name === 'deploy-check') }),
      stopTask: async (taskId) => {
        stopped.add(taskId)
      },
      rewindFiles: async () => ({ canRewind: true, filesChanged: ['/srv/sparkman/notes.md'], insertions: 1, deletions: 1 }),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () =>
        ({
          session: { total_cost_usd: cost },
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 34, resets_at: new Date(Date.UTC(2026, 9, 8, 18)).toISOString() },
            iguana_necktie: { utilization: 0, resets_at: null },
            seven_day: { utilization: 12, resets_at: new Date(Date.UTC(2026, 9, 13)).toISOString() },
          },
        }) as unknown as Usage,
    }
    return query
  }
}
