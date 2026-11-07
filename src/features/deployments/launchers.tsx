import { Cable, Loader, MoreHorizontal, Pencil, Play, Plus, ScrollText, Square, Trash2 } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useDeleteLauncher, useLauncherLog, useLaunchers, useNodes, useSaveLauncher, useStartLauncher, useStopLauncher } from '@/api/hooks'
import type { Launcher, LauncherInput, LauncherState, ModelCap } from '@/api/types'
import { EmptyState, QueryState } from '@/components/query-state'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const STATE_CLASS: Record<LauncherState, string> = {
  idle: 'text-muted-foreground',
  starting: 'text-level-info',
  serving: 'text-brand',
  down: 'text-level-warn',
  stopping: 'text-level-info',
  failed: 'text-level-error',
}

const canEdit = (l: Launcher) => l.state === 'idle' || l.state === 'failed'
const subtitle = (l: Launcher) => (l.models.length ? `${l.models.join(', ')} · ${l.engine}` : l.notes || `:${l.port}`)

function NodesChain({ ids }: { ids: string[] }) {
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 rounded-md', ids.length > 1 && 'border border-brand/30 bg-brand/5 px-1 py-0.5')}>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <Cable className="size-3 text-brand" aria-label="ConnectX-7 link" />}
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{id}</span>
        </Fragment>
      ))}
    </span>
  )
}

/** Deployments → Launchers: the user's own start/stop scripts, one node or a whole ring. */
export function LaunchersCard() {
  const launchers = useLaunchers()
  const start = useStartLauncher()
  const stop = useStopLauncher()
  const remove = useDeleteLauncher()
  const [editing, setEditing] = useState<Launcher | 'new' | null>(null)
  const [logOf, setLogOf] = useState<Launcher | null>(null)
  const [stopping, setStopping] = useState<Launcher | null>(null)
  const [deleting, setDeleting] = useState<Launcher | null>(null)

  return (
    <section aria-labelledby="launchers-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="launchers-heading" className="text-sm font-medium">
            Launchers
          </h2>
          <p className="text-sm text-muted-foreground">Your own start and stop scripts. SparkMan runs them on the head and manages the model once it answers.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus />
          Add launcher
        </Button>
      </div>
      <QueryState
        query={launchers}
        isEmpty={(list) => list.length === 0}
        empty={<EmptyState title="No launchers" description="Point SparkMan at a folder with your start.sh (and stop.sh) to start multi-node rings or anything the catalog can't." />}
      >
        {(list) => (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Launcher</TableHead>
                  <TableHead>Nodes</TableHead>
                  <TableHead>Scripts</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((l) => (
                  <TableRow key={l.id} data-testid="launcher-row">
                    <TableCell>
                      <div className="font-medium">{l.name}</div>
                      {/* one line, cut to the column; the whole text on hover */}
                      <div className="max-w-xs truncate font-mono text-xs text-muted-foreground" title={subtitle(l)}>
                        {subtitle(l)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <NodesChain ids={l.nodeIds} />
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all">
                      {l.sudo && <span className="mr-1 font-sans text-level-warn">root</span>}
                  {l.dir}/{l.startScript}
                      {l.stopScript && <div className="text-muted-foreground">{l.stopScript}</div>}
                    </TableCell>
                    <TableCell>
                      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium capitalize', STATE_CLASS[l.state])}>
                        {(l.state === 'starting' || l.state === 'stopping') && <Loader className="size-3.5 motion-safe:animate-spin" />}
                        {l.state}
                      </span>
                      {l.detail && <div className="text-xs text-muted-foreground">{l.detail}</div>}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {canEdit(l) ? (
                          <Button size="sm" variant="outline" disabled={start.isPending} onClick={() => start.mutate(l.id)}>
                            <Play />
                            Start
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" disabled={l.state === 'stopping'} onClick={() => setStopping(l)}>
                            <Square />
                            Stop
                          </Button>
                        )}
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="size-8" aria-label={`${l.name} actions`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setLogOf(l)}>
                              <ScrollText />
                              Show log
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={l.state === 'stopping'} onSelect={() => setEditing(l)}>
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            {l.state === 'failed' && (
                              <DropdownMenuItem onSelect={() => setStopping(l)}>
                                <Square />
                                Clean up (run stop)
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" disabled={!canEdit(l)} onSelect={() => setDeleting(l)}>
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </QueryState>
      <LauncherSheet editing={editing} onClose={() => setEditing(null)} />
      <LauncherLogSheet launcher={logOf} onClose={() => setLogOf(null)} />
      <Dialog open={stopping !== null} onOpenChange={(o) => !o && setStopping(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop {stopping?.name}?</DialogTitle>
            <DialogDescription>
              {stopping?.stopScript ? `SparkMan runs ${stopping.stopScript} on ${stopping.nodeIds[0]}, then ends whatever ${stopping.startScript} left running.` : `SparkMan ends ${stopping?.startScript} and everything it started on ${stopping?.nodeIds[0]}.`}{' '}
              Agents requesting its models get 404 from the gateway.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopping(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (stopping) stop.mutate(stopping.id)
                setStopping(null)
              }}
            >
              Stop
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>SparkMan forgets this launcher. Your scripts on {deleting?.nodeIds[0]} stay where they are.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleting) remove.mutate(deleting.id)
                setDeleting(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

const CAP_LABELS: [ModelCap, string][] = [
  ['tools', 'Call tools'],
  ['thinking', 'Think (reasoning)'],
  ['images', 'Read images'],
]

const EMPTY: LauncherInput = { name: '', nodeIds: [], dir: '~/', startScript: 'start.sh', stopScript: 'stop.sh', port: 8888, sudo: false, caps: ['tools'], maxOutput: null, contextWindow: null, notes: '' }

function LauncherSheet({ editing, onClose }: { editing: Launcher | 'new' | null; onClose: () => void }) {
  return (
    <Sheet open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[460px]">
        {editing !== null && <LauncherForm key={editing === 'new' ? 'new' : editing.id} editing={editing} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  )
}

function LauncherForm({ editing, onClose }: { editing: Launcher | 'new'; onClose: () => void }) {
  const nodes = useNodes()
  const save = useSaveLauncher()
  const init = editing === 'new' ? EMPTY : editing
  const [form, setForm] = useState<LauncherInput>({ name: init.name, nodeIds: init.nodeIds, dir: init.dir, startScript: init.startScript, stopScript: init.stopScript, port: init.port, sudo: init.sudo, caps: init.caps, maxOutput: init.maxOutput, contextWindow: init.contextWindow ?? null, notes: init.notes })
  const [port, setPort] = useState(String(init.port))
  const [maxOut, setMaxOut] = useState(init.maxOutput === null ? '' : String(init.maxOutput))
  const [ctxWin, setCtxWin] = useState(init.contextWindow == null ? '' : String(init.contextWindow))

  const head = form.nodeIds[0]
  // a running launcher keeps how it starts; only what describes the model can change
  const locked = editing !== 'new' && !canEdit(editing)
  const set = (p: Partial<LauncherInput>) => setForm((f) => ({ ...f, ...p }))
  const ids = (nodes.data ?? []).map((n) => n.id)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    save.mutate({ id: editing === 'new' ? null : editing.id, input: { ...form, port: Number(port), maxOutput: maxOut ? Number(maxOut) : null, contextWindow: ctxWin ? Number(ctxWin) : null, stopScript: form.stopScript?.trim() || null } }, { onSuccess: onClose })
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col">
      <SheetHeader>
        <SheetTitle>{editing === 'new' ? 'Add launcher' : `Edit ${editing.name}`}</SheetTitle>
        <SheetDescription>SparkMan runs the start script on the head over SSH, detached, and the model counts as serving once the port answers /v1/models.</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-5 px-4">
        {locked && <p className="text-sm text-muted-foreground">It’s running, so its nodes, folder, scripts, port and root setting are fixed until you stop it.</p>}
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-name">Name</Label>
          <Input id="ln-name" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="GLM ring (TensorFold)" required />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-head">Head node</Label>
          <Select disabled={locked} value={head ?? ''} onValueChange={(v) => set({ nodeIds: [v, ...form.nodeIds.filter((x) => x !== v)] })}>
            <SelectTrigger id="ln-head" className="w-full">
              <SelectValue placeholder="Where the scripts run" />
            </SelectTrigger>
            <SelectContent>
              {ids.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <fieldset className="flex flex-col gap-2" disabled={!head || locked}>
          <legend className="mb-1 text-sm font-medium">Other nodes it uses</legend>
          <p className="mb-1 text-xs text-muted-foreground">Ranks your script starts elsewhere. They show as busy and rollouts skip them while it runs.</p>
          <div className="grid grid-cols-2 gap-2">
            {ids.filter((id) => id !== head).map((id) => (
              <div key={id} className="flex items-center gap-2">
                <Checkbox
                  id={`ln-node-${id}`}
                  checked={form.nodeIds.includes(id)}
                  onCheckedChange={(c) => set({ nodeIds: c === true ? [...form.nodeIds, id] : form.nodeIds.filter((x) => x !== id) })}
                />
                <Label htmlFor={`ln-node-${id}`} className="font-mono font-normal">
                  {id}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-dir">Folder on the head</Label>
          <Input id="ln-dir" disabled={locked} className="font-mono" value={form.dir} onChange={(e) => set({ dir: e.target.value })} placeholder="~/swap" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ln-start">Start script</Label>
            <Input id="ln-start" disabled={locked} className="font-mono" value={form.startScript} onChange={(e) => set({ startScript: e.target.value })} required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="ln-stop">Stop script</Label>
            <Input id="ln-stop" disabled={locked} className="font-mono" value={form.stopScript ?? ''} onChange={(e) => set({ stopScript: e.target.value })} placeholder="optional" />
          </div>
        </div>
        <div className="flex items-start gap-2">
          <Checkbox id="ln-sudo" disabled={locked} checked={form.sudo} onCheckedChange={(c) => set({ sudo: c === true })} className="mt-0.5" />
          <div className="flex flex-col gap-1">
            <Label htmlFor="ln-sudo" className="font-normal">
              Run as root
            </Label>
            <p className="text-xs text-muted-foreground">Runs both scripts with sudo on the head, for scripts written to run as root (like llama-swap's). The SSH user needs passwordless sudo there.</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-port">Port</Label>
          <Input id="ln-port" disabled={locked} className="w-32 font-mono" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} required />
          <p className="text-xs text-muted-foreground">Where the model answers OpenAI /v1/models on the head.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-maxout">Max output tokens</Label>
          <Input id="ln-maxout" className="w-32 font-mono" inputMode="numeric" value={maxOut} onChange={(e) => setMaxOut(e.target.value.replace(/\D/g, ''))} placeholder="optional" />
          <p className="text-xs text-muted-foreground">The reply cap your start script sets (like --max-tokens). Engines don’t report it.</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-ctx">Context window</Label>
          <Input id="ln-ctx" className="w-32 font-mono" inputMode="numeric" value={ctxWin} onChange={(e) => setCtxWin(e.target.value.replace(/\D/g, ''))} placeholder="optional" />
          <p className="text-xs text-muted-foreground">Read from the engine when it reports one. Set it for engines that don’t, like TensorFold’s Zig engine (its --context).</p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Model can</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CAP_LABELS.map(([cap, label]) => (
              <div key={cap} className="flex items-center gap-2">
                <Checkbox
                  id={`ln-cap-${cap}`}
                  checked={form.caps.includes(cap)}
                  onCheckedChange={(c) => set({ caps: c === true ? [...form.caps, cap] : form.caps.filter((x) => x !== cap) })}
                />
                <Label htmlFor={`ln-cap-${cap}`} className="font-normal">
                  {label}
                </Label>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Engines don’t report these; the gateway’s model registry passes them on to clients like Kimi Code.</p>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ln-notes">Notes</Label>
          <Textarea id="ln-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} />
        </div>
      </div>
      <SheetFooter className="mt-auto">
        <Button type="submit" disabled={save.isPending || !head}>
          {editing === 'new' ? 'Add launcher' : 'Save'}
        </Button>
      </SheetFooter>
    </form>
  )
}

function LauncherLogSheet({ launcher, onClose }: { launcher: Launcher | null; onClose: () => void }) {
  const log = useLauncherLog(launcher?.id ?? null)
  const pre = useRef<HTMLPreElement>(null)
  // follow the tail unless the reader scrolled up
  useEffect(() => {
    const el = pre.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [log.data])
  return (
    <Sheet open={launcher !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-[760px]">
        <SheetHeader>
          <SheetTitle>{launcher?.name} log</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {launcher?.nodeIds[0]}: ~/.cache/sparkman/launch/{launcher?.id}.log
          </SheetDescription>
        </SheetHeader>
        <pre ref={pre} data-testid="launcher-log" className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-lg border bg-surface-2 p-3 font-mono text-xs break-all whitespace-pre-wrap">
          {log.isError ? (log.error instanceof Error ? log.error.message : 'Could not read the log') : log.data || (log.isLoading ? 'Loading…' : 'Nothing yet. The log starts when the launcher does.')}
        </pre>
      </SheetContent>
    </Sheet>
  )
}
