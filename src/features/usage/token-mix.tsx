import type { UsageReport } from '@/api/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCompact } from '@/lib/format'
import { stagger } from '@/lib/motion'

const PARTS = [
  { key: 'generated', label: 'Generated', color: 'var(--brand)', hint: 'completion tokens' },
  { key: 'cached', label: 'Cached', color: 'var(--chart-2)', hint: 'prompt tokens served from the prefix cache' },
  { key: 'prefill', label: 'Prefill', color: 'var(--chart-4)', hint: 'prompt tokens the GPU computed' },
] as const

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** Where the gateway's tokens went: generated, prompt served from cache, prompt computed — overall and per model. */
export function TokenMix({ report }: { report: UsageReport }) {
  const totals = { generated: report.tokensOut, cached: report.tokensCached, prefill: report.tokensIn - report.tokensCached }
  const all = totals.generated + totals.cached + totals.prefill
  return (
    <Card className="gap-0 py-0" data-testid="token-mix">
      <CardHeader className="border-b py-4">
        <CardTitle className="text-sm">Token mix</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 py-4">
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <span className="font-mono text-3xl font-semibold tabular-nums" data-testid="cache-hit-rate">
            {pct(totals.cached, report.tokensIn)}%
          </span>
          <span className="pb-1 text-sm text-muted-foreground">of prompt tokens came from the prefix cache — prefill the GPUs didn’t have to compute</span>
        </div>
        <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-muted" data-testid="token-mix-bar">
          {PARTS.map((p) => (
            <span key={p.key} data-part={p.key} title={`${p.label}: ${formatCompact(totals[p.key])}`} style={{ width: `${all ? (totals[p.key] / all) * 100 : 0}%`, background: p.color }} />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          {PARTS.map((p) => (
            <span key={p.key} className="inline-flex items-center gap-1.5" title={p.hint}>
              <span className="size-2 rounded-full" style={{ background: p.color }} aria-hidden />
              {p.label}
              <span className="font-mono tabular-nums text-foreground">{pct(totals[p.key], all)}%</span>
            </span>
          ))}
        </div>
      </CardContent>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Model</TableHead>
            <TableHead className="text-right">Cached</TableHead>
            <TableHead className="text-right">Prefill</TableHead>
            <TableHead className="text-right">Generated</TableHead>
            <TableHead className="pr-4 text-right">Cache hits</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {report.modelTotals.map((m, i) => (
            <TableRow key={m.model} data-testid="token-mix-row" className="enter-fade-up" style={stagger(i)}>
              <TableCell className="pl-4 font-mono">{m.model}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatCompact(m.cached)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatCompact(m.prefill)}</TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatCompact(m.generated)}</TableCell>
              <TableCell className="pr-4 text-right font-mono tabular-nums">{pct(m.cached, m.cached + m.prefill)}%</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow data-testid="token-mix-total">
            <TableCell className="pl-4">Total</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatCompact(totals.cached)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">{formatCompact(totals.prefill)}</TableCell>
            <TableCell className="text-right font-mono tabular-nums" data-testid="token-mix-total-generated">
              {formatCompact(totals.generated)}
            </TableCell>
            <TableCell className="pr-4 text-right font-mono tabular-nums">{pct(totals.cached, report.tokensIn)}%</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </Card>
  )
}
