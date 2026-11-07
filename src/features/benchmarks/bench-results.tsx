import { Clock, Gauge, Hash, ListChecks, Target, Timer, TriangleAlert, Wrench } from 'lucide-react'
import type { ReactNode } from 'react'
import type { DecodeBenchResult, PrefillBenchResult, QualityBenchResult, ScenarioStatus, ToolEvalBenchResult } from '@/api/types'
import { StatTile } from '@/components/stat-tile'
import { Ticker } from '@/components/ticker'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { QUALITY_LABEL, TOOL_EVAL_LABEL, formatContextSize } from '@/lib/bench'
import { formatDuration, formatNumber, formatPercent, formatTokS } from '@/lib/format'
import { stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { BenchChart } from './bench-chart'
import { slowCopy } from './targets'

const tokS = (v: number | null) => formatTokS(v)
const pct = (v: number | null) => formatPercent(v, 1)
const NUM = 'text-right font-mono tabular-nums'

/** Per-copy table for gateway runs, with the slow copy (if any) called out. */
function CopyBreakdown<T extends { nodeIds: string[] }>({
  title, copies, metric, columns,
}: {
  title: string
  copies: T[]
  metric: (c: T) => number
  columns: { label: string; value: (c: T) => ReactNode }[]
}) {
  const slow = slowCopy(copies, metric)
  return (
    <Card className="gap-0 py-0" data-testid="copy-breakdown">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {slow ? (
          <span className="flex items-center gap-1.5 text-xs text-level-warn" data-testid="slow-copy">
            <TriangleAlert className="size-3.5" />
            <span className="font-mono">{slow.copy.nodeIds.join(' + ')}</span> is {slow.slowerPct}% slower than the others — check its load and thermals
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Copies are within 15% of each other</span>
        )}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Copy</TableHead>
            {columns.map((c) => (
              <TableHead key={c.label} className="text-right">
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {copies.map((c) => (
            <TableRow key={c.nodeIds.join('+')} className={cn(slow?.copy === c && 'bg-level-warn/5')}>
              <TableCell className={cn('font-mono', slow?.copy === c && 'text-level-warn')}>{c.nodeIds.join(' + ')}</TableCell>
              {columns.map((col) => (
                <TableCell key={col.label} className={NUM}>
                  {col.value(c)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{children}</div>
}

function Waiting() {
  return <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Waiting for the first step to finish…</p>
}

function ScoreBar({ percent, className }: { percent: number; className?: string }) {
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)} aria-hidden>
      <div className="h-full rounded-full bg-brand transition-[width] duration-200 ease-out" style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  )
}

export function DecodeResults({ result }: { result: DecodeBenchResult }) {
  if (result.levels.length === 0) return <Waiting />
  const peak = result.levels.reduce((m, l) => (l.aggregateTokS > m.aggregateTokS ? l : m))
  const first = result.levels[0]
  return (
    <>
      <Tiles>
        <StatTile className="enter-fade-up" style={stagger(0)} testId="tile-peak" label="Peak aggregate" icon={Gauge} tone="brand" value={<Ticker value={peak.aggregateTokS} format={tokS} />} hint={`at ${peak.concurrency} concurrent stream${peak.concurrency > 1 ? 's' : ''}`} />
        <StatTile className="enter-fade-up" style={stagger(1)} label="Per stream" icon={Timer} value={<Ticker value={first.perStreamTokS} format={tokS} />} hint={`at ${first.concurrency} stream${first.concurrency > 1 ? 's' : ''}`} />
        <StatTile className="enter-fade-up" style={stagger(2)} label="TTFT p50" icon={Clock} value={formatDuration(first.ttftP50Ms)} hint={`at ${first.concurrency} stream${first.concurrency > 1 ? 's' : ''}`} />
        <StatTile className="enter-fade-up" style={stagger(3)} label="Tokens generated" icon={Hash} value={formatNumber(result.levels.reduce((s, l) => s + l.completionTokens, 0))} hint={`${result.levels.length} level${result.levels.length > 1 ? 's' : ''}`} />
      </Tiles>
      <BenchChart
        title="Aggregate tok/s vs concurrency"
        testId="decode-chart"
        data={result.levels.map((l) => ({ concurrency: l.concurrency, aggregate: l.aggregateTokS, perStream: l.perStreamTokS }))}
        xKey="concurrency"
        xFormat={(v) => `${v}×`}
        bar={{ key: 'aggregate', label: 'Aggregate tok/s', color: 'var(--brand)', format: (v) => formatNumber(v) }}
        line={{ key: 'perStream', label: 'Per-stream tok/s', color: 'var(--chart-2)', format: (v) => v.toFixed(0) }}
      />
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Concurrency</TableHead>
              <TableHead className="text-right">Aggregate</TableHead>
              <TableHead className="text-right">Per stream</TableHead>
              <TableHead className="text-right">TTFT p50</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Wall time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.levels.map((l) => (
              <TableRow key={l.concurrency} data-testid="decode-row" className="enter-fade-up">
                <TableCell className="font-mono tabular-nums">{l.concurrency}×</TableCell>
                <TableCell className={cn(NUM, l === peak && 'text-brand')}>{formatTokS(l.aggregateTokS)}</TableCell>
                <TableCell className={NUM}>{formatTokS(l.perStreamTokS)}</TableCell>
                <TableCell className={NUM}>{formatDuration(l.ttftP50Ms)}</TableCell>
                <TableCell className={NUM}>{formatNumber(l.completionTokens)}</TableCell>
                <TableCell className={NUM}>{formatDuration(l.durationMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {peak.replicas && peak.replicas.length > 1 && (
        <CopyBreakdown
          title={`Per copy at ${peak.concurrency} streams`}
          copies={peak.replicas}
          metric={(c) => c.perStreamTokS}
          columns={[
            { label: 'Streams', value: (c) => c.streams },
            { label: 'Aggregate', value: (c) => formatTokS(c.aggregateTokS) },
            { label: 'Per stream', value: (c) => formatTokS(c.perStreamTokS) },
            { label: 'TTFT p50', value: (c) => formatDuration(c.ttftP50Ms) },
          ]}
        />
      )}
    </>
  )
}

export function PrefillResults({ result, contextLength }: { result: PrefillBenchResult; contextLength: number }) {
  const skipped = result.skipped.length > 0 && (
    <p className="text-xs text-muted-foreground" data-testid="prefill-skipped">
      Skipped (no room in the {formatContextSize(contextLength)} context): {result.skipped.map(formatContextSize).join(', ')}
    </p>
  )
  if (result.sizes.length === 0) return <><Waiting />{skipped}</>
  const peak = result.sizes.reduce((m, s) => (s.prefillTokS > m.prefillTokS ? s : m))
  const largest = result.sizes[result.sizes.length - 1]
  return (
    <>
      <Tiles>
        <StatTile className="enter-fade-up" style={stagger(0)} testId="tile-peak" label="Peak prefill" icon={Gauge} tone="brand" value={<Ticker value={peak.prefillTokS} format={tokS} />} hint={`at ${formatContextSize(peak.contextTokens)} context`} />
        <StatTile className="enter-fade-up" style={stagger(1)} label="Largest context" icon={Target} value={<Ticker value={largest.prefillTokS} format={tokS} />} hint={`${formatContextSize(largest.contextTokens)} tokens`} />
        <StatTile className="enter-fade-up" style={stagger(2)} label="TTFT" icon={Clock} value={formatDuration(largest.ttftMs)} hint={`for ${formatContextSize(largest.contextTokens)} tokens`} />
        <StatTile className="enter-fade-up" style={stagger(3)} label="Sizes" icon={Hash} value={`${result.sizes.length}`} hint={result.skipped.length ? `${result.skipped.length} skipped` : 'none skipped'} />
      </Tiles>
      <BenchChart
        title="Prefill tok/s and TTFT by context size"
        testId="prefill-chart"
        data={result.sizes.map((s) => ({ ctx: s.contextTokens, prefill: s.prefillTokS, ttft: s.ttftMs / 1000 }))}
        xKey="ctx"
        xFormat={formatContextSize}
        bar={{ key: 'prefill', label: 'Prefill tok/s', color: 'var(--brand)', format: (v) => formatNumber(v) }}
        line={{ key: 'ttft', label: 'TTFT (s)', color: 'var(--chart-4)', format: (v) => `${v < 10 ? v.toFixed(1) : v.toFixed(0)} s` }}
      />
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Context</TableHead>
              <TableHead className="text-right">Prefill</TableHead>
              <TableHead className="text-right">TTFT</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.sizes.map((s) => (
              <TableRow key={s.contextTokens} data-testid="prefill-row" className="enter-fade-up">
                <TableCell className="font-mono tabular-nums">{formatContextSize(s.contextTokens)}</TableCell>
                <TableCell className={cn(NUM, s === peak && 'text-brand')}>{formatTokS(s.prefillTokS)}</TableCell>
                <TableCell className={NUM}>{formatDuration(s.ttftMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {largest.replicas && largest.replicas.length > 1 && (
        <CopyBreakdown
          title={`Per copy at ${formatContextSize(largest.contextTokens)} context`}
          copies={largest.replicas}
          metric={(c) => c.prefillTokS}
          columns={[
            { label: 'Prefill', value: (c) => formatTokS(c.prefillTokS) },
            { label: 'TTFT', value: (c) => formatDuration(c.ttftMs) },
          ]}
        />
      )}
      {skipped}
    </>
  )
}

export function QualityResults({ result }: { result: QualityBenchResult }) {
  if (result.categories.length === 0) return <Waiting />
  const items = result.categories.reduce((s, c) => s + c.items, 0)
  const correct = result.categories.reduce((s, c) => s + c.correct, 0)
  const hitMax = result.categories.reduce((s, c) => s + c.hitMaxTokens, 0)
  return (
    <>
      <Tiles>
        <StatTile className="enter-fade-up" style={stagger(0)} testId="tile-overall" label="Overall" icon={Target} tone="brand" value={<Ticker value={result.overall} format={pct} />} hint="mean of category scores" />
        <StatTile className="enter-fade-up" style={stagger(1)} label="Correct" icon={ListChecks} value={`${formatNumber(correct)} / ${formatNumber(items)}`} hint="items" />
        <StatTile className="enter-fade-up" style={stagger(2)} label="Categories" icon={Hash} value={result.categories.length} />
        <StatTile className="enter-fade-up" style={stagger(3)} label="Hit max_tokens" icon={Clock} tone={hitMax > 0 ? 'warn' : 'default'} value={hitMax} hint="thinking replies cut off" />
      </Tiles>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Correct</TableHead>
              <TableHead className="w-[28%]">Score</TableHead>
              <TableHead className="text-right">Mean tokens</TableHead>
              <TableHead className="text-right">Hit max</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.categories.map((c) => (
              <TableRow key={c.category} data-testid="quality-row" className="enter-fade-up">
                <TableCell className="font-medium">{QUALITY_LABEL[c.category]}</TableCell>
                <TableCell className={NUM}>
                  {c.correct}/{c.items}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <ScoreBar percent={c.percent} />
                    <span className="w-14 text-right font-mono text-sm tabular-nums">{formatPercent(c.percent, 1)}</span>
                  </div>
                </TableCell>
                <TableCell className={NUM}>{formatNumber(c.meanCompletionTokens)}</TableCell>
                <TableCell className={cn(NUM, c.hitMaxTokens > 0 && 'text-level-warn')}>{c.hitMaxTokens}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  )
}

const SCENARIO_CLASS: Record<ScenarioStatus, string> = { pass: 'bg-brand', partial: 'bg-level-warn', fail: 'bg-level-error' }

export function ToolEvalResults({ result }: { result: ToolEvalBenchResult }) {
  if (result.categories.length === 0) return <Waiting />
  const count = (st: ScenarioStatus) => result.scenarios.filter((s) => s.status === st).length
  return (
    <>
      <Tiles>
        <StatTile className="enter-fade-up" style={stagger(0)} testId="tile-score" label="Score" icon={Wrench} tone="brand" value={<Ticker value={result.score} format={pct} />} hint="pass 2 · partial 1 · fail 0 points" />
        <StatTile className="enter-fade-up" style={stagger(1)} label="Pass" icon={ListChecks} value={count('pass')} hint={`of ${result.scenarios.length} scenarios`} />
        <StatTile className="enter-fade-up" style={stagger(2)} label="Partial" icon={Hash} tone="warn" value={count('partial')} />
        <StatTile className="enter-fade-up" style={stagger(3)} label="Fail" icon={Hash} tone={count('fail') > 0 ? 'error' : 'default'} value={count('fail')} />
      </Tiles>
      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Category</TableHead>
              <TableHead>Scenarios</TableHead>
              <TableHead className="text-right">Pass</TableHead>
              <TableHead className="text-right">Partial</TableHead>
              <TableHead className="text-right">Fail</TableHead>
              <TableHead className="text-right">Score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.categories.map((c) => (
              <TableRow key={c.category} data-testid="tool-eval-row" className="enter-fade-up">
                <TableCell>
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{c.category}</span>
                  {TOOL_EVAL_LABEL[c.category]}
                </TableCell>
                <TableCell>
                  <ul className="flex gap-1" aria-label={`${TOOL_EVAL_LABEL[c.category]} scenarios`}>
                    {result.scenarios
                      .filter((s) => s.category === c.category)
                      .map((s) => (
                        <li key={s.id} className={cn('size-3 rounded-[3px]', SCENARIO_CLASS[s.status])} title={`${s.id}: ${s.status}`} aria-label={`${s.id}: ${s.status}`} />
                      ))}
                  </ul>
                </TableCell>
                <TableCell className={NUM}>{c.pass}</TableCell>
                <TableCell className={NUM}>{c.partial}</TableCell>
                <TableCell className={NUM}>{c.fail}</TableCell>
                <TableCell className={NUM}>{formatPercent(c.percent, 1)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(['pass', 'partial', 'fail'] as const).map((st) => (
          <span key={st} className="flex items-center gap-1.5 capitalize">
            <span className={cn('size-2.5 rounded-[3px]', SCENARIO_CLASS[st])} />
            {st}
          </span>
        ))}
      </div>
    </>
  )
}
