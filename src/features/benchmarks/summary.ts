import type { BenchRun } from '@/api/types'
import { BENCH_KIND_LABEL, PROMPT_TYPES, QUALITY_LABEL, TOOL_EVAL_LABEL, formatContextSize } from '@/lib/bench'
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format'

/** One-line headline for history rows and the copy summary. */
export function headline(run: BenchRun): string | null {
  const r = run.result
  switch (r.kind) {
    case 'decode': {
      if (r.levels.length === 0) return null
      const peak = r.levels.reduce((m, l) => (l.aggregateTokS > m.aggregateTokS ? l : m))
      return `peak ${formatNumber(peak.aggregateTokS)} tok/s @ ${peak.concurrency}×`
    }
    case 'prefill': {
      if (r.sizes.length === 0) return null
      const peak = r.sizes.reduce((m, s) => (s.prefillTokS > m.prefillTokS ? s : m))
      return `peak ${formatNumber(peak.prefillTokS)} tok/s @ ${formatContextSize(peak.contextTokens)}`
    }
    case 'quality':
      return r.overall === null ? null : `overall ${r.overall.toFixed(1)}%`
    case 'tool-eval':
      return r.score === null ? null : `score ${r.score.toFixed(1)}%`
  }
}

export function configSummary(run: BenchRun): string {
  const c = run.config
  switch (c.kind) {
    case 'decode':
      return `${c.concurrency.join('/')} streams · ${c.maxTokens} tok · ${PROMPT_TYPES.find((p) => p.id === c.promptType)?.label ?? c.promptType}`
    case 'prefill':
      return c.contextSizes.map(formatContextSize).join(' · ')
    case 'quality':
      return `${c.categories.length} categories`
    case 'tool-eval':
      return c.suite === 'quick' ? 'Quick suite' : 'Full suite'
  }
}

const row = (cells: (string | number)[], widths: number[]) => cells.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join('  ').trimEnd()

/** Plain-text summary for the clipboard (pastes cleanly into chat, issues and spreadsheets). */
export function benchSummaryText(run: BenchRun): string {
  const head = [
    `SparkMan ${BENCH_KIND_LABEL[run.kind]} bench — ${run.model} (${run.engine}, ${run.quant}) ${run.scope === 'gateway' ? `through the gateway (${run.nodeIds.join(', ')})` : run.nodeIds.length > 1 ? `on ${run.nodeId} (group: ${run.nodeIds.join(' + ')})` : `on ${run.nodeId}`}`,
    `${formatDateTime(run.startedAt)} · ${run.status}${run.finishedAt ? ` in ${formatDuration(run.finishedAt - run.startedAt)}` : ''} · ${configSummary(run)}`,
  ]
  const r = run.result
  const body: string[] = []
  switch (r.kind) {
    case 'decode': {
      const w = [11, 15, 16, 8]
      body.push(row(['Concurrency', 'Aggregate tok/s', 'Per-stream tok/s', 'TTFT p50'], w))
      for (const l of r.levels) body.push(row([l.concurrency, l.aggregateTokS.toFixed(1), l.perStreamTokS.toFixed(1), `${l.ttftP50Ms} ms`], w))
      break
    }
    case 'prefill': {
      const w = [7, 13, 8]
      body.push(row(['Context', 'Prefill tok/s', 'TTFT'], w))
      for (const s of r.sizes) body.push(row([formatContextSize(s.contextTokens), s.prefillTokS, formatDuration(s.ttftMs)], w))
      if (r.skipped.length) body.push(`Skipped (no room in the ${formatContextSize(run.contextLength)} context): ${r.skipped.map(formatContextSize).join(', ')}`)
      break
    }
    case 'quality': {
      const w = [21, 9, 6]
      body.push(row(['Category', 'Correct', 'Score'], w))
      for (const c of r.categories) body.push(row([QUALITY_LABEL[c.category], `${c.correct}/${c.items}`, `${c.percent.toFixed(1)}%`], w))
      if (r.overall !== null) body.push(`Overall (mean of categories): ${r.overall.toFixed(1)}%`)
      break
    }
    case 'tool-eval': {
      const w = [24, 4, 7, 4, 6]
      body.push(row(['Category', 'Pass', 'Partial', 'Fail', 'Score'], w))
      for (const c of r.categories) body.push(row([`${c.category} ${TOOL_EVAL_LABEL[c.category]}`, c.pass, c.partial, c.fail, `${c.percent.toFixed(1)}%`], w))
      if (r.score !== null) body.push(`Overall score: ${r.score.toFixed(1)}%`)
      break
    }
  }
  const tail = run.error ? [`Error: ${run.error}`] : []
  return [...head, '', ...body, ...tail].join('\n')
}
