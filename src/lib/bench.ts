import type { BenchKind, DecodePromptType, QualityCategory, ToolEvalBenchConfig, ToolEvalCategory } from '@/api/types'

/** Shared bench vocabulary: option lists, suite sizes and labels used by the UI and the simulator alike. */

export const BENCH_KINDS: { id: BenchKind; label: string; blurb: string }[] = [
  { id: 'decode', label: 'Decode', blurb: 'Generation speed (tokens/s) at rising concurrency' },
  { id: 'prefill', label: 'Prefill', blurb: 'Prompt processing speed and time to first token across context sizes' },
  { id: 'quality', label: 'Quality', blurb: 'Fixed, seeded quality suite to compare models, quantizations and engines' },
  { id: 'tool-eval', label: 'Tool Eval', blurb: 'Tool-calling quality across deterministic scenarios (selection, parameters, multi-step, safety)' },
]

export const BENCH_KIND_LABEL: Record<BenchKind, string> = { decode: 'Decode', prefill: 'Prefill', quality: 'Quality', 'tool-eval': 'Tool Eval' }

export const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 6, 8, 16, 32] as const
export const DEFAULT_CONCURRENCY = [1, 2, 3, 4, 6, 8]
export const MAX_TOKENS_RANGE = { min: 64, max: 2048, step: 64, default: 500 } as const

export const PROMPT_TYPES: { id: DecodePromptType; label: string }[] = [
  { id: 'structured', label: 'Structured' },
  { id: 'prose', label: 'Prose' },
  { id: 'code', label: 'Code' },
  { id: 'json', label: 'JSON' },
]

export const CONTEXT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144] as const
export const DEFAULT_CONTEXT_SIZES = [1024, 2048, 4096, 8192, 16384, 32768]

export interface QualityCategoryInfo {
  id: QualityCategory
  label: string
  items: number
  defaultOn: boolean
  /** uses the model's thinking mode */
  thinking: boolean
  maxTokens: number
}

/** Item counts follow sparkDash's quality suite. */
export const QUALITY_CATEGORIES: QualityCategoryInfo[] = [
  { id: 'qa', label: 'QA', items: 150, defaultOn: true, thinking: false, maxTokens: 64 },
  { id: 'reasoning', label: 'Reasoning', items: 40, defaultOn: true, thinking: true, maxTokens: 8192 },
  { id: 'arithmetic', label: 'Arithmetic chain', items: 40, defaultOn: true, thinking: true, maxTokens: 12288 },
  { id: 'state', label: 'State tracking', items: 40, defaultOn: true, thinking: true, maxTokens: 12288 },
  { id: 'gsm8k', label: 'GSM8K', items: 200, defaultOn: true, thinking: true, maxTokens: 8192 },
  { id: 'mmlu', label: 'MMLU', items: 285, defaultOn: true, thinking: false, maxTokens: 512 },
  { id: 'instruction', label: 'Instruction following', items: 40, defaultOn: false, thinking: false, maxTokens: 1024 },
  { id: 'long-recall', label: 'Long-context recall', items: 2, defaultOn: false, thinking: false, maxTokens: 512 },
]

export const QUALITY_LABEL = Object.fromEntries(QUALITY_CATEGORIES.map((c) => [c.id, c.label])) as Record<QualityCategory, string>
export const DEFAULT_QUALITY_CATEGORIES = QUALITY_CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id)

/** tool-eval-bench categories (69 scenarios in the full suite). */
export const TOOL_EVAL_CATEGORIES: { id: ToolEvalCategory; label: string; scenarios: number }[] = [
  { id: 'A', label: 'Tool selection', scenarios: 5 },
  { id: 'B', label: 'Parameter precision', scenarios: 5 },
  { id: 'C', label: 'Multi-step chains', scenarios: 5 },
  { id: 'D', label: 'Restraint and refusal', scenarios: 5 },
  { id: 'E', label: 'Error recovery', scenarios: 5 },
  { id: 'F', label: 'Localization', scenarios: 4 },
  { id: 'G', label: 'Structured reasoning', scenarios: 5 },
  { id: 'H', label: 'Instruction following', scenarios: 5 },
  { id: 'I', label: 'Context and state', scenarios: 5 },
  { id: 'J', label: 'Code patterns', scenarios: 4 },
  { id: 'K', label: 'Safety and boundaries', scenarios: 5 },
  { id: 'L', label: 'Toolset scaling', scenarios: 4 },
  { id: 'M', label: 'Autonomous planning', scenarios: 4 },
  { id: 'N', label: 'Creative composition', scenarios: 4 },
  { id: 'O', label: 'Structured output', scenarios: 4 },
]

export const TOOL_EVAL_LABEL = Object.fromEntries(TOOL_EVAL_CATEGORIES.map((c) => [c.id, c.label])) as Record<ToolEvalCategory, string>

export function toolEvalScenarioCount(category: ToolEvalCategory, suite: ToolEvalBenchConfig['suite']): number {
  const full = TOOL_EVAL_CATEGORIES.find((c) => c.id === category)?.scenarios ?? 0
  return suite === 'quick' ? Math.min(2, full) : full
}

/** "32k", "128k", "1k" */
export function formatContextSize(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens)
}

/** Sizes that fit the model's context window (with headroom for the reply). */
export function fittingContextSizes(sizes: readonly number[], contextLength: number): { fit: number[]; skipped: number[] } {
  const fit = sizes.filter((s) => s + 64 <= contextLength)
  return { fit, skipped: sizes.filter((s) => !fit.includes(s)) }
}
