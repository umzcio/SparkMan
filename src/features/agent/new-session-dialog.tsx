import { useEffect, useState } from 'react'
import { EFFORTS, type CreateSessionBody, type Effort, type HostMode, type SessionOptions } from '@/agent/protocol'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useProvider } from './providers'

export function NewSessionDialog({
  open, onOpenChange, defaultCwd, creating, onCreate,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  defaultCwd: string
  creating: boolean
  onCreate: (body: CreateSessionBody) => void
}) {
  const [cwd, setCwd] = useState(defaultCwd)
  const provider = useProvider()
  const [mode, setMode] = useState<HostMode>(provider.defaultMode)
  const [effort, setEffort] = useState<Effort | 'auto'>('auto')
  const [budget, setBudget] = useState('')
  const [dirs, setDirs] = useState('')
  useEffect(() => {
    if (open) setCwd(defaultCwd)
  }, [open, defaultCwd])

  const options = (): SessionOptions | undefined => {
    const o: SessionOptions = {}
    if (effort !== 'auto') o.effort = effort
    const b = Number(budget)
    if (budget.trim() && b > 0) o.maxBudgetUsd = b
    const extra = dirs.split('\n').map((d) => d.trim()).filter(Boolean)
    if (extra.length) o.additionalDirectories = extra
    return Object.keys(o).length ? o : undefined
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* don't hand focus back to the trigger: the chat composer takes it */}
      <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            onCreate({ cwd: cwd.trim() || undefined, mode, options: options() })
          }}
        >
          <DialogHeader>
            <DialogTitle>New {provider.id === 'codex' ? 'Codex' : 'Claude Code'} session</DialogTitle>
            <DialogDescription>
              {provider.id === 'codex'
                ? 'Runs on this SparkMan host with its Codex login, config.toml and AGENTS.md files.'
                : 'Runs on this SparkMan host with its Claude Code login, settings and CLAUDE.md files.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-cwd">Working directory</Label>
            <Input id="agent-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono" spellCheck={false} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-mode">Permission mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as HostMode)}>
              <SelectTrigger id="agent-mode" className="w-full">
                <SelectValue>{provider.modes.find((m) => m.value === mode)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {provider.modes.filter((m) => m.value !== provider.optInMode).map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label} — <span className="text-muted-foreground">{m.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <details className="group rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer text-muted-foreground select-none group-open:mb-3">
              Advanced — {provider.features.budget ? 'effort, budget, extra directories' : 'reasoning effort'}
            </summary>
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-effort">Effort</Label>
                  <Select value={effort} onValueChange={(v) => setEffort(v as Effort | 'auto')}>
                    <SelectTrigger id="agent-effort" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">Model default</SelectItem>
                      {EFFORTS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {provider.features.budget && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="agent-budget">Budget (USD)</Label>
                    <Input id="agent-budget" type="number" min="0" step="0.5" inputMode="decimal" placeholder="no limit" value={budget} onChange={(e) => setBudget(e.target.value)} />
                  </div>
                )}
              </div>
              {provider.features.additionalDirectories && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="agent-dirs">Additional directories</Label>
                  <Textarea id="agent-dirs" rows={2} placeholder="/srv/models (one per line)" value={dirs} onChange={(e) => setDirs(e.target.value)} className="font-mono text-xs" spellCheck={false} />
                </div>
              )}
            </div>
          </details>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating}>
              Start session
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
