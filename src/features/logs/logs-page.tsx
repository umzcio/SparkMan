import { PageBody, PageHeader } from '@/components/page-header'
import { LogExplorer, type LogExplorerState } from './log-explorer'
import { StatusLine } from '@/components/status-line'
import { useLogsStatus } from '@/features/status/page-status'

export function LogsPage({ state, onChange }: { state: LogExplorerState; onChange: (patch: Partial<LogExplorerState>) => void }) {
  const status = useLogsStatus()
  return (
    <>
      <PageHeader fleetData="logs"
        crumbs={[{ label: 'Logs', to: '/logs' }, { label: 'Explorer' }]}
        title="Logs"
        description={<StatusLine items={status} />}
      />
      <PageBody>
        <LogExplorer state={state} onChange={onChange} />
      </PageBody>
    </>
  )
}
