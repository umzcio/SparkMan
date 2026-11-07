import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useKeys, useRevokeKey } from '@/api/hooks'
import type { ApiKey } from '@/api/types'
import { PageBody, PageHeader } from '@/components/page-header'
import { QueryState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatNumber, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CreateKeyDialog } from './create-key-dialog'
import { stagger } from '@/lib/motion'
import { StatusLine } from '@/components/status-line'
import { useKeysStatus } from '@/features/status/page-status'

export function KeysPage() {
  const status = useKeysStatus()
  const keys = useKeys()
  const revoke = useRevokeKey()
  const [createOpen, setCreateOpen] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const now = Date.now()

  return (
    <>
      <PageHeader fleetData="keys"
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'API Keys' }]}
        title="API Keys"
        description={<StatusLine items={status} />}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Create key
          </Button>
        }
      />
      <PageBody>
        <QueryState query={keys}>
          {(list) => (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="text-right">Rate limit</TableHead>
                    <TableHead className="text-right">Requests 24h</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((k, i) => {
                    const revoked = k.revokedAt !== null
                    return (
                      <TableRow key={k.id} data-testid="key-row" style={stagger(i)} className={cn('enter-fade-up transition-opacity duration-300', revoked && 'opacity-60')}>
                        <TableCell className="font-medium">{k.name}</TableCell>
                        <TableCell className="font-mono text-xs">{k.prefix}••••••••</TableCell>
                        <TableCell className="text-muted-foreground">{formatRelative(k.createdAt, now)}</TableCell>
                        <TableCell className="text-muted-foreground">{k.lastUsedAt ? formatRelative(k.lastUsedAt, now) : 'never'}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{k.rateLimitRpm}/min</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{formatNumber(k.requests24h)}</TableCell>
                        <TableCell className="text-right">
                          {revoked ? (
                            <Badge variant="outline" className="text-muted-foreground">
                              Revoked
                            </Badge>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                              Revoke
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </QueryState>
      </PageBody>
      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
      <Dialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>Agents using this key will get 401 immediately. This can’t be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (revoking) revoke.mutate(revoking.id)
                setRevoking(null)
              }}
            >
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
