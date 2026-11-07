import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import type { Deployment, FleetNode, NodeStatus } from '@/api/types'
import { NodeStatusDot, STATUS_LABEL } from '@/components/node-status-dot'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { UsageBar } from '@/components/usage-bar'
import { formatDuration, formatTemp, formatWatts } from '@/lib/format'
import { stagger } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { Faceplate } from '@/components/faceplate'

const SLOTS_PER_SHELF = 7

const LED: Record<NodeStatus, string> = {
  online: 'bg-[#76b900] shadow-[0_0_6px_1px_#76b900]',
  degraded: 'bg-[#f5a524] shadow-[0_0_6px_1px_#f5a524] motion-safe:animate-pulse',
  offline: 'bg-[#f2545b]/80',
  rebooting: 'bg-[#5b7cfa] shadow-[0_0_6px_1px_#5b7cfa] motion-safe:animate-pulse',
}

const MODEL_SHORT: Record<FleetNode['model'], string> = { 'DGX Spark FE': 'DGX Spark', 'Dell Pro Max GB10': 'Dell Pro Max GB10', 'ASUS GX10': 'ASUS Ascent GX10' }

function QuickStats({ node, deployment, now }: { node: FleetNode; deployment?: Deployment; now: number }) {
  const live = node.live
  return (
    <div className="space-y-3" data-testid="rack-quick-stats">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-mono text-sm font-medium">
            <NodeStatusDot status={node.status} />
            {node.id}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {MODEL_SHORT[node.model]} · shelf {node.rack.shelf}, slot {node.rack.slot}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{STATUS_LABEL[node.status]}</span>
      </div>
      <div className="truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">
        {deployment ? `${deployment.model} · ${deployment.engine}` : live ? 'idle — no deployment' : 'unreachable'}
        {(node.maintenance || node.drained) && <span className="ml-2 text-level-warn">{node.maintenance ? 'maintenance' : 'drained'}</span>}
      </div>
      {live ? (
        <div className="grid grid-cols-4 gap-2">
          <UsageBar label="GPU" value={live.gpuUtil} />
          <UsageBar label="Mem" value={(live.memUsedGB / node.memoryGB) * 100} />
          <UsageBar label="Temp" value={live.gpuTempC} format={formatTemp} />
          <UsageBar label="Power" value={live.gpuPowerW == null ? null : (live.gpuPowerW / 140) * 100} format={() => formatWatts(live.gpuPowerW)} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No live metrics while the node is {node.status}.</p>
      )}
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{node.ip}</span>
        <span>{node.status === 'offline' ? 'down' : `up ${formatDuration(now - node.bootedAt)}`}</span>
      </div>
      {live?.throttling && <p className="text-xs text-level-warn">Thermal throttling</p>}
    </div>
  )
}

function RackUnit({ node, deployment, index, now }: { node: FleetNode; deployment?: Deployment; index: number; now: number }) {
  const [open, setOpen] = useState(false)
  const reachable = node.live !== null
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={80} closeDelay={60}>
      <HoverCardTrigger asChild>
        <Link
          to="/nodes/$nodeId"
          params={{ nodeId: node.id }}
          data-testid="rack-unit"
          aria-label={`${node.id}, ${MODEL_SHORT[node.model]}, ${STATUS_LABEL[node.status]}`}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          style={stagger(index)}
          className="enter-fade-up group flex flex-col items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#76b900]"
        >
          <span
            className={cn(
              'relative block w-full transition-[transform,filter] duration-200 ease-(--ease-out-strong) group-hover:-translate-y-1 group-active:scale-[0.98]',
              !reachable && 'brightness-50 saturate-0',
            )}
          >
            <Faceplate model={node.model} className="block h-auto w-full drop-shadow-[0_6px_8px_rgba(0,0,0,0.6)]" />
            <span className={cn('absolute top-[3%] right-[9%] size-1.5 rounded-full', LED[node.status])} />
            {(node.maintenance || node.drained) && <span className="absolute inset-x-0 bottom-[42%] bg-[#f5a524]/90 py-0.5 text-center text-[9px] font-semibold tracking-wider text-black uppercase">{node.maintenance ? 'maint' : 'drained'}</span>}
          </span>
          {/* GPU activity strip */}
          <span className="h-1 w-4/5 overflow-hidden rounded-full bg-white/10">
            <span className="block h-full origin-left rounded-full bg-[#76b900] transition-transform duration-500 ease-(--ease-out-strong)" style={{ transform: `scaleX(${(node.live?.gpuUtil ?? 0) / 100})` }} />
          </span>
          <span className="max-w-full truncate font-mono text-[8px] text-zinc-400 group-hover:text-zinc-100 md:text-[10px]" data-testid="rack-unit-label">{node.id}</span>
        </Link>
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-72">
        <QuickStats node={node} deployment={deployment} now={now} />
      </HoverCardContent>
    </HoverCard>
  )
}

function Rail() {
  // square-holed rack rail
  return <div className="w-1.5 shrink-0 rounded-sm bg-[repeating-linear-gradient(to_bottom,#3f3f46_0_7px,#09090b_7px_11px)] md:w-2.5" aria-hidden />
}

/** Physical rack elevation: one row per shelf, units in their real slots. */
export function RackView({ nodes, deployments, now }: { nodes: FleetNode[]; deployments: Deployment[]; now: number }) {
  const shelves = [...new Set(nodes.map((n) => n.rack.shelf))].sort((a, b) => a - b)
  const counts = nodes.reduce<Partial<Record<NodeStatus, number>>>((acc, n) => ({ ...acc, [n.status]: (acc[n.status] ?? 0) + 1 }), {})
  let index = 0
  return (
    <div data-testid="rack-view">
      <div className="overflow-x-auto rounded-xl">
        {/* phones: the rack fills the width and the units shrink; wider screens: units at full size */}
        <div className="mx-auto flex w-full gap-1 rounded-xl border border-black/40 bg-zinc-950 p-1.5 shadow-inner md:w-fit md:min-w-[30rem] md:gap-2 md:p-2">
          <Rail />
          <div className="flex min-w-0 flex-1 flex-col gap-4 py-1.5 md:gap-5 md:py-2">
            {shelves.map((shelf) => {
              const bySlot = new Map(nodes.filter((n) => n.rack.shelf === shelf).map((n) => [n.rack.slot, n]))
              const slots = Math.max(SLOTS_PER_SHELF, ...bySlot.keys())
              return (
                <section key={shelf} aria-label={`Shelf ${shelf}`}>
                  <div className="grid justify-center gap-1 px-0.5 md:gap-2 md:px-2 lg:gap-3" style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 5.5rem))` }}>
                    {Array.from({ length: slots }, (_, i) => {
                      const node = bySlot.get(i + 1)
                      if (!node) return <div key={i} className="mb-6 aspect-[1/3] rounded-md border border-dashed border-white/10" aria-hidden />
                      return <RackUnit key={node.id} node={node} index={index++} now={now} deployment={deployments.find((d) => d.id === node.deploymentId)} />
                    })}
                  </div>
                  {/* the shelf tray */}
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-2.5 flex-1 rounded-[2px] bg-gradient-to-b from-zinc-600 via-zinc-800 to-zinc-900 shadow-[0_4px_8px_rgba(0,0,0,0.6)]" />
                    <span className="font-mono text-[10px] text-zinc-500">S{shelf}</span>
                  </div>
                </section>
              )
            })}
          </div>
          <Rail />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(['online', 'degraded', 'rebooting', 'offline'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <NodeStatusDot status={s} />
            {STATUS_LABEL[s]} <span className="font-mono tabular-nums">{counts[s] ?? 0}</span>
          </span>
        ))}
        <span className="ml-auto hidden md:inline">Hover a unit for quick stats · click to open</span>
        <span className="ml-auto md:hidden">Tap a unit to open it</span>
      </div>
    </div>
  )
}
