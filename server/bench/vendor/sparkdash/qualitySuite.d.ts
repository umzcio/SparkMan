/** Types for the parts of sparkDash's quality suite SparkMan uses (the module itself is vendored JS). */
export type SuiteCategory = 'qa' | 'reason' | 'arith' | 'track' | 'gsm8k' | 'mmlu' | 'follow' | 'long'

export interface SuiteItem {
  id: string
  category: SuiteCategory
  prompt?: string
  maxTokens: number
  thinking: boolean
}

export const SUITE_VERSION: number
export const SCORING_VERSION: number
export const REQUEST_SEED: number
export function generateSuite(opts?: { categories?: SuiteCategory[]; longSizes?: number[]; longItems?: number }): SuiteItem[]
export function buildLongPrompt(item: SuiteItem): string
/** the sizes that fit the context with headroom (`run`) and those that do not (`skipped`) */
export function longSizesForContext(sizes: number[], contextLength: number): { run: number[]; skipped: number[] }
export function scoreItem(item: SuiteItem, reply: string): { ok: boolean; correct?: number; total?: number }
export function visibleAnswer(text: string): string
