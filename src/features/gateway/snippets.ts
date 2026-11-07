export type SnippetTool = 'claude-code' | 'codex' | 'opencode' | 'kimi-code' | 'cursor' | 'curl'

export interface Snippet {
  tool: SnippetTool
  label: string
  file: string
  code: string
  note?: string
}

export function buildSnippets(baseUrl: string, models: { primary: string; coder: string }): Snippet[] {
  const v1 = `${baseUrl}/v1`
  return [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      file: '~/.zshrc',
      note: 'The gateway exposes an Anthropic-compatible /v1/messages route, so Claude Code needs only environment variables.',
      code: [
        '# Route Claude Code through SparkMan',
        `export ANTHROPIC_BASE_URL="${baseUrl}"`,
        'export ANTHROPIC_AUTH_TOKEN="$SPARKMAN_API_KEY"',
        `export ANTHROPIC_MODEL="${models.primary}"`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL="${models.coder}"`,
      ].join('\n'),
    },
    {
      tool: 'codex',
      label: 'Codex CLI',
      file: '~/.codex/config.toml',
      code: [
        `model = "${models.primary}"`,
        'model_provider = "sparkman"',
        '',
        '[model_providers.sparkman]',
        'name = "SparkMan"',
        `base_url = "${v1}"`,
        'env_key = "SPARKMAN_API_KEY"',
        'wire_api = "chat"',
      ].join('\n'),
    },
    {
      tool: 'opencode',
      label: 'OpenCode',
      file: 'opencode.json',
      code: JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          provider: {
            sparkman: {
              npm: '@ai-sdk/openai-compatible',
              name: 'SparkMan',
              options: { baseURL: v1, apiKey: '{env:SPARKMAN_API_KEY}' },
              models: { [models.primary]: {}, [models.coder]: {} },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      tool: 'kimi-code',
      label: 'Kimi Code',
      file: '~/.kimi-code/config.toml',
      note: `Easiest: in Kimi Code run /provider → Add New Platform → Custom registry (api.json), paste ${v1}/registry/api.json and your SparkMan key as the Bearer token. It adds every model the gateway serves, with its context window, and re-syncs at each start. Or configure it by hand:`,
      code: [
        'default_model = "sparkman-primary"',
        '',
        '[providers.sparkman]',
        'type = "openai"',
        `base_url = "${v1}"`,
        'api_key_env = "SPARKMAN_API_KEY"',
        '',
        '[models."sparkman-primary"]',
        'provider = "sparkman"',
        `model = "${models.primary}"`,
        'max_context_size = 131072',
        'capabilities = ["tool_use"]',
        '',
        '[models."sparkman-coder"]',
        'provider = "sparkman"',
        `model = "${models.coder}"`,
        'max_context_size = 131072',
        'capabilities = ["tool_use"]',
      ].join('\n'),
    },
    {
      tool: 'cursor',
      label: 'Cursor',
      file: 'Settings → Models',
      note: 'Cursor needs an OpenAI-compatible base URL override; add each model name under “Add model”.',
      code: [`Override OpenAI Base URL:  ${v1}`, 'OpenAI API Key:            <your SparkMan key>', `Models:                    ${models.primary}, ${models.coder}`].join('\n'),
    },
    {
      tool: 'curl',
      label: 'curl',
      file: 'shell',
      code: [
        `curl ${v1}/chat/completions \\`,
        '  -H "Authorization: Bearer $SPARKMAN_API_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        `  -d '{"model":"${models.coder}","messages":[{"role":"user","content":"ping"}]}'`,
      ].join('\n'),
    },
  ]
}
