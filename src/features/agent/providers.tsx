import { createContext, useContext, type ComponentType } from 'react'
import { agentApi, codexApi, type AgentApi } from '@/agent/agent-api'
import { AGENT_MODES, CODEX_MODES, type HostMode } from '@/agent/protocol'
import { ClaudeMark } from '@/components/claude-mark'
import { CodexMark } from '@/components/codex-mark'

/** Everything that differs between the host agents the chat UI drives. */
export interface AgentProvider {
  id: 'claude' | 'codex'
  name: string
  description: string
  /** `mono` inherits currentColor (on a coloured button) */
  Mark: ComponentType<{ className?: string; label?: string | null; mono?: boolean }>
  api: AgentApi
  modes: { value: HostMode; label: string; hint: string }[]
  /** the no-guardrails mode, only offered when the host opts in */
  optInMode: HostMode
  optInConfirm: { title: string; body: string; action: string }
  /** mode for new sessions */
  defaultMode: HostMode
  features: {
    /** dollar cost per turn (Codex on a ChatGPT plan reports tokens instead) */
    cost: boolean
    rewind: boolean
    fork: boolean
    plugins: boolean
    tasks: boolean
    /** "Always allow" on approvals for the rest of the session */
    approveForSession: boolean
    /** per-session budget and extra directories at start */
    budget: boolean
    additionalDirectories: boolean
  }
  /** shown when the server has no API for this agent */
  setupHint: string
}

export const CLAUDE: AgentProvider = {
  id: 'claude',
  name: 'Claude',
  description: 'Claude Code running on this SparkMan host — not the Spark nodes',
  Mark: ClaudeMark,
  api: agentApi,
  modes: AGENT_MODES,
  optInMode: 'bypassPermissions',
  optInConfirm: {
    title: 'Bypass all permission checks?',
    body: 'Claude Code will edit files and run any command on this host without asking. Only use this for work you would let it do unattended.',
    action: 'Enable bypass',
  },
  defaultMode: 'default',
  features: { cost: true, rewind: true, fork: true, plugins: false, tasks: true, approveForSession: false, budget: true, additionalDirectories: true },
  setupHint: 'On the SparkMan host run pnpm server (or pnpm start), then reload.',
}

export const CODEX: AgentProvider = {
  id: 'codex',
  name: 'Codex',
  description: 'OpenAI Codex CLI running on this SparkMan host — not the Spark nodes',
  Mark: CodexMark,
  api: codexApi,
  modes: CODEX_MODES,
  optInMode: 'full-access',
  optInConfirm: {
    title: 'Give Codex full access?',
    body: 'Codex will run without a sandbox and without asking — any command, anywhere on this host. Only use this for work you would let it do unattended.',
    action: 'Enable full access',
  },
  defaultMode: 'auto',
  features: { cost: false, rewind: false, fork: false, plugins: true, tasks: false, approveForSession: true, budget: false, additionalDirectories: false },
  setupHint: 'Install the Codex CLI on the SparkMan host (npm i -g @openai/codex), sign in with codex login, then restart the SparkMan server.',
}

const ProviderContext = createContext<AgentProvider>(CLAUDE)

export const ProviderProvider = ProviderContext.Provider

export const useProvider = () => useContext(ProviderContext)
