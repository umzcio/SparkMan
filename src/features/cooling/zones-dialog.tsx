import { useState } from 'react'
import { useSetFanZones } from '@/api/hooks'
import type { Fan, FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Faceplate } from '@/components/faceplate'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

const NONE = 'none'

/** One row per top-shelf box; pick the fan in front of it. */
export function ZonesDialog({ open, onOpenChange, fans, nodes }: { open: boolean; onOpenChange: (o: boolean) => void; fans: Fan[]; nodes: FleetNode[] }) {
  const save = useSetFanZones()
  const shelf = nodes.filter((n) => n.rack.shelf === 1).sort((a, b) => a.rack.slot - b.rack.slot)
  const current = () => Object.fromEntries(shelf.map((n) => [n.id, fans.find((f) => f.nodeIds.includes(n.id))?.id ?? null]))
  const [pick, setPick] = useState<Record<string, string | null>>(current)
  // start from the live zones each time the dialog opens
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setPick(current())
  }
  const submit = () => {
    const zones = Object.fromEntries(fans.map((f) => [f.id, shelf.filter((n) => pick[n.id] === f.id).map((n) => n.id)]))
    save.mutate(zones, { onSuccess: () => onOpenChange(false) })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="zones-dialog">
        <DialogHeader>
          <DialogTitle>Fan zones</DialogTitle>
          <DialogDescription>Each fan follows the hottest box in its zone. Boxes with no fan aren’t cooled by the front fans.</DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-lg border">
          {shelf.map((n) => (
            <div key={n.id} className="flex items-center gap-3 px-3 py-2">
              <Faceplate model={n.model} className="h-9 w-auto" />
              <span className="flex-1 font-mono text-sm">{n.id}</span>
              {/* one tab stop per box; arrow keys move between fans */}
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-label={`Fan for ${n.id}`}
                value={pick[n.id] ?? NONE}
                onValueChange={(v) => v && setPick((p) => ({ ...p, [n.id]: v === NONE ? null : v }))}
              >
                {fans.map((f) => (
                  <ToggleGroupItem key={f.id} value={f.id} aria-label={`${n.id} on ${f.name}`} className="min-w-8 px-2 text-xs data-[state=on]:border-brand data-[state=on]:bg-brand/15 data-[state=on]:text-brand">
                    {f.name.replace('Fan ', '')}
                  </ToggleGroupItem>
                ))}
                <ToggleGroupItem value={NONE} aria-label={`${n.id} on no fan`} className="px-2 text-xs data-[state=on]:border-brand data-[state=on]:bg-brand/15 data-[state=on]:text-brand">
                  None
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending} data-testid="zone-save">Save zones</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
