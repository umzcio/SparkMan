import { GitCompareArrows } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useBenchRuns } from '@/api/hooks'
import type { BenchRun } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { QUALITY_LABEL } from '@/lib/bench'
import { formatDateTime, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { compareQuality, formatPValue } from './compare'

const runLabel = (r: BenchRun) => `${r.nodeId} · ${r.model} · ${formatDateTime(r.startedAt)}${r.result.kind === 'quality' && r.result.overall !== null ? ` · ${r.result.overall.toFixed(1)}%` : ''}`

function Delta({ value }: { value: number }) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±'
  return <span className={cn('font-mono tabular-nums', value > 0 ? 'text-brand' : value < 0 ? 'text-level-error' : 'text-muted-foreground')}>{`${sign}${Math.abs(value).toFixed(1)}`}</span>
}

function Figure({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

/** Paired comparison of this quality run with any other finished quality run in the fleet. */
export function QualityCompare({ run }: { run: BenchRun }) {
  const all = useBenchRuns({ kind: 'quality' })
  const [otherId, setOtherId] = useState<string>('')
  const candidates = (all.data ?? []).filter((r) => r.id !== run.id && r.status !== 'running' && r.result.kind === 'quality' && r.result.categories.length > 0)
  const other = candidates.find((r) => r.id === otherId)
  const cmp = other && run.result.kind === 'quality' && other.result.kind === 'quality' ? compareQuality(run.result, other.result) : null

  return (
    <Card data-testid="quality-compare">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          Compare runs
        </CardTitle>
        <CardDescription>Items pair by id, so the exact McNemar test tells a real difference from run-to-run noise.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="compare-with">Compare with</Label>
          <Select value={otherId} onValueChange={setOtherId} disabled={candidates.length === 0}>
            <SelectTrigger id="compare-with" className="w-full max-w-md" data-testid="compare-with">
              <SelectValue placeholder={candidates.length === 0 ? 'No other quality runs yet' : 'Pick an earlier run'} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {runLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {cmp && other && (
          <div className="enter-fade flex flex-col gap-4" data-testid="compare-result">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Figure label="This run" value={formatPercent(cmp.scoreA, 1)} testId="compare-score-a" />
              <Figure label="Other run" value={formatPercent(cmp.scoreB, 1)} testId="compare-score-b" />
              <Figure label="Paired items" value={formatNumber(cmp.paired)} />
              <Figure label="Only this run right" value={cmp.onlyA} testId="compare-only-a" />
              <Figure label="Only other right" value={cmp.onlyB} testId="compare-only-b" />
              <Figure label="McNemar (exact)" value={formatPValue(cmp.pValue)} testId="compare-p" />
            </dl>
            <div data-testid="compare-verdict">
              {cmp.withinNoise ? (
                <Badge variant="outline" className="text-muted-foreground">
                  Difference within noise (p ≥ 0.05)
                </Badge>
              ) : (
                <Badge variant="outline" className={cmp.onlyA > cmp.onlyB ? 'text-brand' : 'text-level-warn'}>
                  Significant: {cmp.onlyA > cmp.onlyB ? 'this run' : 'the other run'} is better (p &lt; 0.05)
                </Badge>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">This run</TableHead>
                  <TableHead className="text-right">Other</TableHead>
                  <TableHead className="text-right">Δ other − this</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cmp.rows.map((r) => (
                  <TableRow key={r.category}>
                    <TableCell>{QUALITY_LABEL[r.category]}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatPercent(r.a, 1)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatPercent(r.b, 1)}</TableCell>
                    <TableCell className="text-right">
                      <Delta value={r.delta} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
