import type { BenchConfig, BenchStatus, DecodeBenchConfig, PrefillBenchConfig, QualityBenchConfig, ToolEvalBenchConfig } from '@/api/types'
import { DEFAULT_CONCURRENCY, DEFAULT_CONTEXT_SIZES, DEFAULT_QUALITY_CATEGORIES, MAX_TOKENS_RANGE, fittingContextSizes } from '@/lib/bench'
import { formatNumber } from '@/lib/format'

export interface BenchConfigs {
  decode: DecodeBenchConfig
  prefill: PrefillBenchConfig
  quality: QualityBenchConfig
  'tool-eval': ToolEvalBenchConfig
}

export const DEFAULT_CONFIGS: BenchConfigs = {
  decode: { kind: 'decode', concurrency: DEFAULT_CONCURRENCY, maxTokens: MAX_TOKENS_RANGE.default, promptType: 'structured' },
  prefill: { kind: 'prefill', contextSizes: DEFAULT_CONTEXT_SIZES },
  quality: { kind: 'quality', categories: DEFAULT_QUALITY_CATEGORIES },
  'tool-eval': { kind: 'tool-eval', suite: 'full' },
}

/** Why the config can't run against a model with this context length (null when it can). */
export function configProblem(config: BenchConfig, contextLength: number): string | null {
  switch (config.kind) {
    case 'decode':
      if (config.concurrency.length === 0) return 'Pick at least one concurrency level'
      if (!Number.isInteger(config.maxTokens) || config.maxTokens < MAX_TOKENS_RANGE.min || config.maxTokens > MAX_TOKENS_RANGE.max) {
        return `Max tokens must be ${MAX_TOKENS_RANGE.min}–${formatNumber(MAX_TOKENS_RANGE.max)}`
      }
      return null
    case 'prefill':
      return fittingContextSizes(config.contextSizes, contextLength).fit.length === 0 ? 'Pick at least one context size that fits the model' : null
    case 'quality':
      return config.categories.length === 0 ? 'Pick at least one category' : null
    case 'tool-eval':
      return null
  }
}

export const STATUS_CLASS: Record<BenchStatus, string> = {
  running: 'text-level-info',
  completed: 'text-brand',
  cancelled: 'text-muted-foreground',
  failed: 'text-level-error',
}
