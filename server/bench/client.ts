/** One streamed OpenAI chat completion, timed: what every bench is built from. */

export interface BenchTarget {
  /** OpenAI-compatible base, ending in /v1 */
  baseUrl: string
  model: string
  apiKey?: string
}

export interface StreamResult {
  ok: boolean
  status: number
  error: string | null
  startedAt: number
  /** first generated token (content, reasoning or tool call), null if none */
  firstTokenAt: number | null
  endedAt: number
  text: string
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  finishReason: string | null
}

export async function streamChat(target: BenchTarget, body: Record<string, unknown>, signal: AbortSignal, now: () => number = Date.now): Promise<StreamResult> {
  const startedAt = now()
  const r: StreamResult = {
    ok: false, status: 0, error: null, startedAt, firstTokenAt: null, endedAt: startedAt, text: '', promptTokens: 0, cachedTokens: 0, completionTokens: 0, finishReason: null,
  }
  let res: Response
  try {
    res = await fetch(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
      body: JSON.stringify({ ...body, model: target.model, stream: true, stream_options: { include_usage: true } }),
      signal,
    })
  } catch (e) {
    r.error = e instanceof Error ? e.message : String(e)
    r.endedAt = now()
    return r
  }
  r.status = res.status
  if (!res.ok || !res.body) {
    r.error = `${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`
    r.endedAt = now()
    return r
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let reasoningChars = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let v: { choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[]; usage?: Record<string, unknown> | null }
        try {
          v = JSON.parse(data)
        } catch {
          continue
        }
        for (const c of v.choices ?? []) {
          const d = c.delta ?? {}
          const content = typeof d.content === 'string' ? d.content : ''
          const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : ''
          if ((content || reasoning || Array.isArray(d.tool_calls)) && r.firstTokenAt === null) r.firstTokenAt = now()
          r.text += content
          reasoningChars += reasoning.length
          if (c.finish_reason) r.finishReason = c.finish_reason
        }
        if (v.usage) {
          r.promptTokens = Number(v.usage.prompt_tokens) || 0
          r.completionTokens = Number(v.usage.completion_tokens) || 0
          const det = v.usage.prompt_tokens_details as Record<string, unknown> | null | undefined
          r.cachedTokens = Number(det?.cached_tokens) || 0
        }
      }
    }
    r.ok = true
  } catch (e) {
    r.error = signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e)
  }
  r.endedAt = now()
  // servers without include_usage: estimate from characters (~4 per token)
  if (r.ok && r.completionTokens === 0 && (r.text || reasoningChars)) r.completionTokens = Math.max(1, Math.round((r.text.length + reasoningChars) / 4))
  return r
}

/** sparkDash's thinking switches: every template key the common servers read. */
export function thinkingFlags(on: boolean): Record<string, unknown> {
  return { chat_template_kwargs: { enable_thinking: on, thinking: on, thinking_mode: on ? 'enabled' : 'disabled' } }
}

export const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
