// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { generatedTokens, TokenCounters } from './engine-metrics.ts'

describe('generatedTokens', () => {
  it('reads each engine’s counter and sums label sets', () => {
    expect(generatedTokens('# TYPE vllm:generation_tokens_total counter\nvllm:generation_tokens_total{engine="0",model_name="q"} 9256.0\nvllm:generation_tokens_created{engine="0"} 1.79e+09\n')).toBe(9256)
    expect(generatedTokens('tensorfold:generation_tokens_total 27042\ntensorfold_health:completion_tokens_total 27042\n')).toBe(27042)
    // TensorFold's tokens of requests still streaming count too
    expect(generatedTokens('tensorfold:generation_tokens_running 1178\ntensorfold:generation_tokens_total 67738\n')).toBe(68916)
    expect(generatedTokens('sglang:generation_tokens_total{model_name="a"} 10\nsglang:generation_tokens_total{model_name="b"} 5\n')).toBe(15)
    expect(generatedTokens('process_cpu_seconds_total 3\n')).toBeNull()
  })
})

describe('TokenCounters', () => {
  it('rates over the last minute and starts over when the server restarts', () => {
    const c = new TokenCounters()
    c.record('a', 0, 1000)
    expect(c.rate('a')).toBeNull()
    c.record('a', 15_000, 1600)
    expect(c.rate('a')).toBe(40)
    for (let t = 30_000; t <= 90_000; t += 15_000) c.record('a', t, 1600 + (t - 15_000) / 1000)
    // 15 s → 90 s holds 1600 → 1675; the minute from 30 s on is 1615 → 1675
    expect(c.rate('a')).toBe(1)
    c.record('a', 105_000, 10)
    expect(c.rate('a')).toBeNull()
    c.record('a', 120_000, 10)
    expect(c.rate('a')).toBe(0)
    c.record('a', 135_000, null)
    expect(c.rate('a')).toBeNull()
  })
})
