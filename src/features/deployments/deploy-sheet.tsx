import { useState } from 'react'
import { useCatalog, useCreateDeployment, useNodes } from '@/api/hooks'
import type { Engine } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatGB } from '@/lib/format'
import { fitProblem } from './fit'

export function DeploySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const catalog = useCatalog()
  const nodes = useNodes()
  const create = useCreateDeployment()
  const [modelId, setModelId] = useState<string>()
  const [engine, setEngine] = useState<Engine>()
  const [picked, setPicked] = useState<string[]>([])

  const model = catalog.data?.find((m) => m.id === modelId)
  const free = (nodes.data ?? []).filter((n) => n.deploymentId === null && (n.status === 'online' || n.status === 'degraded'))
  const problem = fitProblem(model, engine, picked.length)

  const reset = () => {
    setModelId(undefined)
    setEngine(undefined)
    setPicked([])
  }

  const submit = () => {
    if (!model || !engine || problem) return
    create.mutate(
      { catalogId: model.id, engine, nodeIds: picked },
      {
        onSuccess: () => {
          reset()
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>Deploy model</SheetTitle>
          <SheetDescription>Pick a model, an engine and free nodes. Multi-node replicas use ConnectX-7 with vLLM or SGLang.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-5 px-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-model">Model</Label>
            <Select
              value={modelId ?? ''}
              onValueChange={(v) => {
                setModelId(v)
                setEngine(undefined)
              }}
            >
              <SelectTrigger id="deploy-model" className="w-full">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {catalog.data?.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.displayName} · {m.quant} · {formatGB(m.sizeGB)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="deploy-engine">Engine</Label>
            <Select value={engine ?? ''} onValueChange={(v) => setEngine(v as Engine)} disabled={!model}>
              <SelectTrigger id="deploy-engine" className="w-full">
                <SelectValue placeholder="Choose an engine" />
              </SelectTrigger>
              <SelectContent>
                {model?.engines.map((e) => (
                  <SelectItem key={e} value={e}>
                    {e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Nodes</legend>
            {free.length === 0 ? (
              <p className="text-sm text-muted-foreground">No free nodes. Stop a deployment to free its nodes.</p>
            ) : (
              free.map((n) => (
                <div key={n.id} className="flex items-center gap-2">
                  <Checkbox
                    id={`node-${n.id}`}
                    checked={picked.includes(n.id)}
                    onCheckedChange={(c) => setPicked((p) => (c === true ? [...p, n.id] : p.filter((x) => x !== n.id)))}
                  />
                  <Label htmlFor={`node-${n.id}`} className="font-mono font-normal">
                    {n.id}
                    <span className="ml-2 font-sans text-xs text-muted-foreground">{n.model}</span>
                  </Label>
                </div>
              ))
            )}
          </fieldset>
          {problem && (model || picked.length > 0) && (
            <p className="text-sm text-level-warn" data-testid="fit-problem">
              {problem}
            </p>
          )}
        </div>
        <SheetFooter>
          <Button onClick={submit} disabled={problem !== null || create.isPending}>
            Deploy
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
