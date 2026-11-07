import { Cable, Network, Play, Timer } from 'lucide-react'
import { useState } from 'react'
import { useBenchRuns, useDeployments, useNodes, useStartBench } from '@/api/hooks'
import type { BenchKind, StartBenchInput } from '@/api/types'
import { NodeStatusDot } from '@/components/node-status-dot'
import { PageBody, PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BENCH_KINDS, BENCH_KIND_LABEL, formatContextSize } from '@/lib/bench'
import { BenchConfigForm } from './bench-config'
import { DEFAULT_CONFIGS, configProblem, type BenchConfigs } from './config'
import { BenchHistory } from './bench-history'
import { BenchRunView } from './bench-run-view'
import { GATEWAY_KINDS, benchTargets, resolveTarget, targetLabel, targetNodes, targetProblem, targetRunNode, type BenchTarget } from './targets'
import { StatusLine } from '@/components/status-line'
import { useBenchmarksStatus } from '@/features/status/page-status'

function TargetSummary({ target }: { target: BenchTarget }) {
  const d = target.deployment
  return (
    <div className="flex flex-col gap-1.5 text-sm" data-testid="bench-target">
      <div className="font-medium">{d.displayName}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{d.engine}</Badge>
        <Badge variant="outline" className="font-mono">{d.quant}</Badge>
        <Badge variant="outline" className="font-mono">{formatContextSize(d.contextLength)} ctx</Badge>
        <Badge variant="outline" className="font-mono">:{d.port}</Badge>
      </div>
      {target.scope === 'replica' && target.nodes.length > 1 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Cable className="mt-0.5 size-3 shrink-0 text-brand" aria-hidden />
          <span>
            Tensor-parallel over {target.nodes.map((n) => n.id).join(' + ')}. Benches go through the head (<span className="font-mono">{target.nodes[0].id}</span>), which
            serves the API, and occupy every node in the group.
          </span>
        </p>
      )}
      {target.scope === 'gateway' && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p className="flex items-start gap-1.5">
            <Network className="mt-0.5 size-3 shrink-0 text-brand" aria-hidden />
            <span>
              Through the gateway to all {target.copies.length} copies. Decode spreads its streams round-robin across them; prefill sends each size to every copy. Every
              node is occupied for the run.
            </span>
          </p>
          <ul className="ml-4.5 flex flex-wrap gap-1">
            {target.copies.map((c) => (
              <li key={c[0].id}>
                <Badge variant="outline" className="gap-1 font-mono text-[11px]">
                  <NodeStatusDot status={c[0].status} className="size-2" />
                  {c.map((n) => n.id).join(' + ')}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function BenchmarksPage({ nodeId, kind: requestedKind, onNode, onKind }: { nodeId?: string; kind: BenchKind; onNode: (id: string) => void; onKind: (k: BenchKind) => void }) {
  const status = useBenchmarksStatus()
  const nodes = useNodes()
  const deployments = useDeployments()
  const targets = nodes.data && deployments.data ? benchTargets(nodes.data, deployments.data) : null
  const target = (targets && (resolveTarget(targets, nodeId) ?? targets.find((t) => targetProblem(t, 'decode') === null) ?? targets[0])) ?? null
  // the gateway can't score quality or tool use; fall back to decode there
  const kind: BenchKind = target?.scope === 'gateway' && !GATEWAY_KINDS.includes(requestedKind) ? 'decode' : requestedKind

  const runs = useBenchRuns({ nodeId: target ? targetRunNode(target) : undefined, model: target?.deployment.model }, target !== null)
  const start = useStartBench()
  const [configs, setConfigs] = useState<BenchConfigs>(DEFAULT_CONFIGS)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const all = runs.data ?? []
  const kindRuns = all.filter((r) => r.kind === kind)
  const selected = kindRuns.find((r) => r.id === selectedId) ?? kindRuns[0] ?? null
  const busy = all.find((r) => r.status === 'running')
  const config = configs[kind]
  const problem = target ? (targetProblem(target, kind) ?? configProblem(config, target.deployment.contextLength)) : 'Pick a node'

  const run = () => {
    if (!target || problem) return
    const input: StartBenchInput =
      target.scope === 'gateway' ? { scope: 'gateway', deploymentId: target.deployment.id, config } : { nodeId: target.nodes[0].id, deploymentId: target.deployment.id, config }
    start.mutate(input, { onSuccess: (r) => setSelectedId(r.id) })
  }

  return (
    <>
      <PageHeader fleetData="benchmarks"
        crumbs={[{ label: 'AI Gateway', to: '/gateway' }, { label: 'Benchmarks' }]}
        title="Benchmarks"
        description={<StatusLine items={status} />}
        actions={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Label htmlFor="bench-node" className="text-muted-foreground">
              Target
            </Label>
            <Select value={target?.key ?? ''} onValueChange={onNode} disabled={!targets || targets.length === 0}>
              <SelectTrigger id="bench-node" className="w-full min-w-0 sm:w-80" data-testid="bench-node">
                <SelectValue placeholder="Choose a node" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Nodes and groups</SelectLabel>
                  {targets
                    ?.filter((t) => t.scope === 'replica')
                    .map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        <NodeStatusDot status={targetNodes(t)[0].status} />
                        <span className="font-mono">{targetLabel(t)}</span>
                        <span className="text-muted-foreground">{t.deployment.model}</span>
                      </SelectItem>
                    ))}
                </SelectGroup>
                {targets?.some((t) => t.scope === 'gateway') && (
                  <SelectGroup>
                    <SelectLabel>Every copy, through the gateway</SelectLabel>
                    {targets
                      .filter((t) => t.scope === 'gateway')
                      .map((t) => (
                        <SelectItem key={t.key} value={t.key}>
                          <Network className="text-brand" />
                          <span className="font-mono">{t.deployment.model}</span>
                          <span className="text-muted-foreground">{targetLabel(t).replace('Gateway · ', '')}</span>
                        </SelectItem>
                      ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
        }
      />
      <PageBody>
        {!targets ? (
          <Skeleton className="h-96 w-full" />
        ) : !target ? (
          <EmptyState title="No models are being served" description="Deploy a model first; a bench always runs against a deployment on a node." />
        ) : (
          <Tabs value={kind} onValueChange={(v) => onKind(v as BenchKind)}>
            <TabsList aria-label="Bench type">
              {BENCH_KINDS.map((k) => (
                <TabsTrigger
                  key={k.id}
                  value={k.id}
                  className="px-3"
                  data-testid={`bench-tab-${k.id}`}
                  disabled={target.scope === 'gateway' && !GATEWAY_KINDS.includes(k.id)}
                  title={target.scope === 'gateway' && !GATEWAY_KINDS.includes(k.id) ? 'Same on every copy — bench one node instead' : undefined}
                >
                  {k.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={kind} className="mt-4">
              <div className="grid items-start gap-6 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)]">
                <div className="flex flex-col gap-6">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">{BENCH_KIND_LABEL[kind]} bench</CardTitle>
                      <CardDescription>{BENCH_KINDS.find((k) => k.id === kind)?.blurb}</CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-5">
                      <TargetSummary target={target} />
                      <BenchConfigForm kind={kind} configs={configs} onChange={setConfigs} contextLength={target.deployment.contextLength} />
                    </CardContent>
                    <CardFooter className="flex flex-col items-stretch gap-2">
                      <Button onClick={run} disabled={problem !== null || busy !== undefined || start.isPending} data-testid="bench-run-button">
                        <Play />
                        Run {BENCH_KIND_LABEL[kind].toLowerCase()} bench
                      </Button>
                      {busy ? (
                        <p className="text-xs text-muted-foreground" data-testid="bench-busy">
                          A {BENCH_KIND_LABEL[busy.kind].toLowerCase()} bench is running {busy.scope === 'gateway' ? 'through the gateway' : `on ${busy.nodeId}`}; one bench per node at a time.
                          {busy.kind !== kind && (
                            <Button variant="link" size="xs" className="h-auto px-1" onClick={() => onKind(busy.kind)}>
                              Show it
                            </Button>
                          )}
                        </p>
                      ) : (
                        problem && <p className="text-xs text-level-warn" data-testid="bench-problem">{problem}</p>
                      )}
                    </CardFooter>
                  </Card>
                  <BenchHistory runs={kindRuns} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
                </div>
                <div className="min-w-0">
                  {selected ? (
                    <BenchRunView key={selected.id} run={selected} />
                  ) : runs.isPending ? (
                    <Skeleton className="h-64 w-full" />
                  ) : (
                    <EmptyState title={`No ${BENCH_KIND_LABEL[kind].toLowerCase()} runs yet`} description={`Run one against ${target.deployment.model} ${target.scope === 'gateway' ? `across all ${target.copies.length} copies` : `on ${targetLabel(target)}`}. Results stream in step by step.`} />
                  )}
                </div>
              </div>
            </TabsContent>
          </Tabs>
        )}
        <footer className="border-t pt-4 text-xs text-muted-foreground">
          <Timer className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
          Bench methodology after{' '}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/MiaAI-Lab/sparkDash" target="_blank" rel="noreferrer">
            sparkDash
          </a>{' '}
          (Apache-2.0). Quality items sample{' '}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/openai/grade-school-math" target="_blank" rel="noreferrer">
            GSM8K
          </a>{' '}
          (OpenAI, MIT) and{' '}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/hendrycks/test" target="_blank" rel="noreferrer">
            MMLU
          </a>{' '}
          (Hendrycks et al., MIT); Tool Eval follows{' '}
          <a className="underline underline-offset-2 hover:text-foreground" href="https://github.com/SeraphimSerapis/tool-eval-bench" target="_blank" rel="noreferrer">
            tool-eval-bench
          </a>{' '}
          (MIT).
        </footer>
      </PageBody>
    </>
  )
}
