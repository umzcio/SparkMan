import { useNodeProcesses } from '@/api/hooks'
import { EmptyState, QueryState } from '@/components/query-state'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

export function NodeProcessesTab({ nodeId }: { nodeId: string }) {
  const procs = useNodeProcesses(nodeId)
  return (
    <QueryState query={procs} isEmpty={(p) => p.length === 0} empty={<EmptyState title="No GPU processes" description="The node is idle or unreachable." />}>
      {(list) => (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>PID</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Process</TableHead>
                <TableHead>Engine</TableHead>
                <TableHead className="text-right">GPU memory</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {list.map((p) => (
                <TableRow key={p.pid}>
                  <TableCell>{p.pid}</TableCell>
                  <TableCell>{p.user}</TableCell>
                  <TableCell className="max-w-md truncate">{p.name}</TableCell>
                  <TableCell>{p.engine ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{(p.gpuMemMiB / 1024).toFixed(1)} GiB</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </QueryState>
  )
}
