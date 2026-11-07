import { CircleSlash, EllipsisVertical, PackageOpen, Power, Stethoscope, Wrench } from 'lucide-react'
import { useState } from 'react'
import { useCollectBundle, useRebootNode, useRunDiagnostics, useSetDrained, useSetMaintenance } from '@/api/hooks'
import type { FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

export function NodeActions({ node }: { node: FleetNode }) {
  const [confirm, setConfirm] = useState(false)
  const reboot = useRebootNode()
  const drain = useSetDrained()
  const maintenance = useSetMaintenance()
  const diag = useRunDiagnostics()
  const bundle = useCollectBundle()
  const reachable = node.status === 'online' || node.status === 'degraded'

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Actions">
            Actions <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={!reachable} onSelect={() => setConfirm(true)}>
            <Power />
            Reboot
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => maintenance.mutate({ id: node.id, on: !node.maintenance })}>
            <Wrench />
            {node.maintenance ? 'End maintenance' : 'Maintenance mode'}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={node.maintenance} onSelect={() => drain.mutate({ id: node.id, drained: !node.drained })}>
            <CircleSlash />
            {node.drained ? 'Undrain' : 'Drain'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!reachable} onSelect={() => diag.mutate(node.id)}>
            <Stethoscope />
            Run L1 diagnostics
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!reachable} onSelect={() => bundle.mutate(node.id)}>
            <PackageOpen />
            Collect L2 bundle
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reboot {node.id}?</DialogTitle>
            <DialogDescription>Models served from this node will be unavailable until it is back and reloaded (about 35 s in the simulator).</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false)
                reboot.mutate(node.id)
              }}
            >
              Reboot node
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
