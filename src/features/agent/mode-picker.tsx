import { useState } from 'react'
import type { HostMode } from '@/agent/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProvider } from './providers'

export function ModePicker({ mode, disabled, allowBypass, onChange }: { mode: HostMode; disabled?: boolean; allowBypass: boolean; onChange: (mode: HostMode) => void }) {
  const { modes, optInMode, optInConfirm } = useProvider()
  const [confirmOptIn, setConfirmOptIn] = useState(false)
  return (
    <>
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === optInMode) setConfirmOptIn(true)
          else onChange(v as HostMode)
        }}
      >
        <SelectTrigger size="sm" className="w-40" aria-label="Permission mode">
          <SelectValue>{modes.find((m) => m.value === mode)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {modes.filter((m) => allowBypass || m.value !== optInMode || mode === optInMode).map((m) => (
            <SelectItem key={m.value} value={m.value}>
              <span className="flex flex-col">
                <span>{m.label}</span>
                <span className="text-xs text-muted-foreground">{m.hint}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Dialog open={confirmOptIn} onOpenChange={setConfirmOptIn}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{optInConfirm.title}</DialogTitle>
            <DialogDescription>{optInConfirm.body}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOptIn(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOptIn(false)
                onChange(optInMode)
              }}
            >
              {optInConfirm.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
