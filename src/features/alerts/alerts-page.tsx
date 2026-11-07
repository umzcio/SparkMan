import { useState } from 'react'
import { useAlertRules, useIncidents, useSetRuleEnabled } from '@/api/hooks'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { IncidentSheet } from './incident-sheet'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useAlertsStatus } from '@/features/status/page-status'

export function AlertsPage() {
  const status = useAlertsStatus()
  const incidents = useIncidents()
  const rules = useAlertRules()
  const setRule = useSetRuleEnabled()
  const [openId, setOpenId] = useState<string | null>(null)
  const now = Date.now()
  const open = incidents.data?.find((i) => i.id === openId) ?? null

  return (
    <>
      <PageHeader fleetData="alerts" crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Alerts' }]} title="Alerts" description={<StatusLine items={status} />} />
      <PageBody>
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Incidents</CardTitle>
          </CardHeader>
          <QueryState query={incidents}>
            {(list) => (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Severity</TableHead>
                    <TableHead>Incident</TableHead>
                    <TableHead>Node</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((i, idx) => (
                    <TableRow
                      key={i.id}
                      data-testid="incident-row"
                      style={stagger(idx)}
                      className="enter-fade-up cursor-pointer focus-visible:bg-muted/60 focus-visible:outline-none"
                      tabIndex={0}
                      role="button"
                      aria-label={`Open incident: ${i.title}`}
                      onClick={() => setOpenId(i.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setOpenId(i.id)
                        }
                      }}
                    >
                      <TableCell>
                        <Badge variant="outline" className={i.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                          {i.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{i.title}</TableCell>
                      <TableCell className="font-mono text-xs">{i.nodeId ?? 'gateway'}</TableCell>
                      <TableCell className="text-muted-foreground">{formatRelative(i.startedAt, now)}</TableCell>
                      <TableCell className="font-mono tabular-nums">{formatDuration((i.resolvedAt ?? now) - i.startedAt)}</TableCell>
                      <TableCell>
                        <span className={cn('text-sm font-medium', i.status === 'ongoing' ? 'text-level-warn' : 'text-muted-foreground')}>{i.status}</span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-4">
            <CardTitle className="text-sm">Rules</CardTitle>
            <CardDescription>Evaluated every 30 s against node telemetry, kernel logs and gateway metrics.</CardDescription>
          </CardHeader>
          <QueryState query={rules}>
            {(list) => (
              <Table>
                <TableBody>
                  {list.map((r) => (
                    <TableRow key={r.id} data-testid="rule-row">
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{r.condition}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={r.severity === 'critical' ? 'text-level-error' : 'text-level-warn'}>
                          {r.severity}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch checked={r.enabled} onCheckedChange={(enabled) => setRule.mutate({ id: r.id, enabled })} aria-label={`Enable ${r.name}`} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </QueryState>
        </Card>
      </PageBody>
      <IncidentSheet incident={open} onClose={() => setOpenId(null)} />
    </>
  )
}
