import { describe, expect, it } from 'vitest'
import { buildSnippets } from './snippets'

const BASE = 'http://sparkman.local:4000'
const snippets = buildSnippets(BASE, { primary: 'qwen3-235b-a22b', coder: 'qwen3-coder-30b-a3b' })

describe('buildSnippets', () => {
  it('covers every supported tool', () => {
    expect(snippets.map((s) => s.tool)).toEqual(['claude-code', 'codex', 'opencode', 'kimi-code', 'cursor', 'curl'])
  })
  it('configures Kimi Code with an env-var key reference, never an inline key', () => {
    const kimi = snippets.find((s) => s.tool === 'kimi-code')!
    expect(kimi.code).toContain(`base_url = "${BASE}/v1"`)
    expect(kimi.code).toContain('api_key_env = "SPARKMAN_API_KEY"')
    expect(kimi.code).not.toContain('api_key = ')
  })
  it('points every snippet at the gateway and never embeds a secret', () => {
    for (const s of snippets) {
      expect(s.code).toContain(BASE)
      expect(s.code).not.toMatch(/sk-spark-[A-Za-z0-9]{8,}/)
    }
  })
  it('uses the Anthropic-style root for Claude Code and /v1 for OpenAI-compatible tools', () => {
    const claude = snippets.find((s) => s.tool === 'claude-code')!
    expect(claude.code).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
    expect(snippets.find((s) => s.tool === 'codex')!.code).toContain(`base_url = "${BASE}/v1"`)
    expect(snippets.find((s) => s.tool === 'opencode')!.code).toContain(`"baseURL": "${BASE}/v1"`)
  })
})
