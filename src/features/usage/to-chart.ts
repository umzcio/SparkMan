import type { UsageReport } from '@/api/types'
import type { MetricLike, Series } from '@/components/metric-chart'

export function toUsageChart(report: UsageReport, groupBy: 'model' | 'key'): { data: MetricLike[]; series: Series[] } {
  const groups = groupBy === 'model' ? report.models.map((m) => ({ id: m, label: m })) : report.keys.map((k) => ({ id: k.id, label: k.name }))
  const series = groups.map((g, i) => ({ key: `s${i}`, label: g.label, color: `var(--cat-${(i % 7) + 1})` }))
  const data = report.points.map((p) => {
    const source = groupBy === 'model' ? p.byModel : p.byKey
    const row: MetricLike = { t: p.t }
    groups.forEach((g, i) => {
      row[`s${i}`] = source[g.id] ?? 0
    })
    return row
  })
  return { data, series }
}
