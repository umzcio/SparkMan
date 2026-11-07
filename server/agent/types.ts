import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** The slice of the SDK's Query object the server uses (the real Query satisfies it; the fake implements it). */
export type AgentQuery = AsyncIterable<SDKMessage> &
  Pick<
    Query,
    | 'setPermissionMode'
    | 'interrupt'
    | 'close'
    | 'setModel'
    | 'setMaxThinkingTokens'
    | 'initializationResult'
    | 'supportedCommands'
    | 'mcpServerStatus'
    | 'toggleMcpServer'
    | 'reconnectMcpServer'
    | 'getContextUsage'
    | 'reloadSkills'
    | 'stopTask'
    | 'rewindFiles'
    | 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
  >

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentQuery
