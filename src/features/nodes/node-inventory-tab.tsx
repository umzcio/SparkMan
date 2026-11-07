import { useNodeInventory } from '@/api/hooks'
import type { FleetNode } from '@/api/types'
import { QueryState } from '@/components/query-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'

function Kv({ rows }: { rows: [string, string][] }) {
  return (
    <Table>
      <TableBody>
        {rows.map(([k, v]) => (
          <TableRow key={k}>
            <TableCell className="w-48 text-muted-foreground">{k}</TableCell>
            <TableCell className="font-mono">{v}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function NodeInventoryTab({ node }: { node: FleetNode }) {
  const inv = useNodeInventory(node.id)
  return (
    <QueryState query={inv}>
      {(data) => (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">System</CardTitle>
            </CardHeader>
            <CardContent>
              <Kv
                rows={[
                  ['Model', node.model],
                  ['Serial', node.serial],
                  ['Asset tag', node.assetTag],
                  ['Hostname', node.hostname],
                  ['IP', node.ip],
                  ['CPU', '20-core Grace (10× Cortex-X925 + 10× Cortex-A725)'],
                  ['Memory', `${node.memoryGB} GB LPDDR5x unified`],
                  ['Storage', `${node.diskGB / 1000} TB NVMe`],
                  ['DGX OS', node.os.dgxOs],
                  ['Kernel', node.os.kernel],
                  ['Driver / CUDA', `${node.os.driver} / ${node.os.cuda}`],
                ]}
              />
            </CardContent>
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Firmware</CardTitle>
                <CardDescription className="font-mono text-xs">source: {data.envelope.tool} · rc={data.envelope.rc}</CardDescription>
              </CardHeader>
              <CardContent>
                <Kv rows={data.firmware.map((f) => [f.component, f.version])} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Key packages</CardTitle>
              </CardHeader>
              <CardContent>
                <Kv rows={data.packages.map((p) => [p.name, p.version])} />
              </CardContent>
            </Card>
            <details className="rounded-xl border bg-card p-4 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Raw envelope</summary>
              <pre className="mt-3 overflow-x-auto font-mono text-xs">{JSON.stringify(data.envelope, null, 2)}</pre>
            </details>
          </div>
        </div>
      )}
    </QueryState>
  )
}
