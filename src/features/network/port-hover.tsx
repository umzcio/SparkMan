import { useNavigate } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import type { NetworkSwitch, SwitchPort } from '@/api/types'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { UsageBar } from '@/components/usage-bar'
import { cn } from '@/lib/utils'
import { formatBps, formatCount, formatLinkSpeed } from './format'

type PortState = 'up' | 'slow' | 'down' | 'empty'

// the rack view's LEDs
const LED: Record<PortState, string> = {
  up: 'bg-[#76b900] shadow-[0_0_6px_1px_#76b900]',
  slow: 'bg-[#f5a524] shadow-[0_0_6px_1px_#f5a524] motion-safe:animate-pulse',
  down: 'bg-[#f2545b]/80',
  empty: 'bg-muted-foreground/40',
}
const STATE_LABEL: Record<PortState, string> = { up: 'Up', slow: 'Below speed', down: 'Down', empty: 'Empty' }

function stateOf(p: SwitchPort): PortState {
  if (p.problem) return 'slow'
  if (p.up) return 'up'
  return p.peer?.nodeId ? 'down' : 'empty'
}

/**
 * Like the rack view's units: hover a port for its stats, click it to open the node on the other end. `side` keeps
 * the card off the neighbouring row (a bottom-row port opens it below).
 */
export function PortHover({ port, side = 'top', children }: { port: SwitchPort; side?: 'top' | 'bottom'; children: ReactElement }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const nodeId = port.peer?.nodeId ?? null
  const go = () => nodeId && void navigate({ to: '/nodes/$nodeId', params: { nodeId } })
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={80} closeDelay={60}>
      <HoverCardTrigger
        asChild
        tabIndex={0}
        role={nodeId ? 'link' : undefined}
        aria-label={`${port.name}${port.peer ? `, ${port.peer.label}` : ''}, ${port.up ? formatLinkSpeed(port.speedMbps) : 'down'}`}
        onClick={go}
        onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && go()}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{ cursor: nodeId ? 'pointer' : 'default' }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent side={side} sideOffset={8} className="w-72">
        <PortStats port={port} />
      </HoverCardContent>
    </HoverCard>
  )
}

function PortStats({ port: p }: { port: SwitchPort }) {
  const state = stateOf(p)
  /** share of the link's speed, for the gauges */
  const use = (bps: number | null) => (bps == null || !p.speedMbps ? null : (bps / (p.speedMbps * 1e6)) * 100)
  const counters: [string, string, boolean][] = [
    ['Errors', `${formatCount(p.rxErrors)} / ${formatCount(p.txErrors)}`, (p.rxErrors ?? 0) + (p.txErrors ?? 0) > 0],
    ['Drops', formatCount(p.drops), (p.drops ?? 0) > 0],
    p.pauseRx !== null || p.pauseTx !== null
      ? ['Pause', `${formatCount(p.pauseRx)} / ${formatCount(p.pauseTx)}`, false]
      : ['MTU', p.mtu != null ? String(p.mtu) : '—', false],
  ]
  return (
    <div className="space-y-3" data-testid="port-stats">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-sm font-medium">
            <span className={cn('size-2 shrink-0 rounded-full', LED[state])} aria-hidden />
            <span className="truncate">{p.peer?.label ?? `Port ${p.label}`}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            Port {p.label}
            {p.peer?.iface ? ` · ${p.peer.iface}` : p.peer ? '' : ' · nothing seen'}
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">{STATE_LABEL[state]}</span>
      </div>
      <div className="truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">
        {p.name}
        {p.up && ` · ${formatLinkSpeed(p.speedMbps)}`}
        {p.problem && <span className="ml-2 text-level-warn">{p.problem}</span>}
      </div>
      {p.up ? (
        <div className="grid grid-cols-2 gap-2">
          <UsageBar label="In" value={use(p.rxBps)} format={() => formatBps(p.rxBps)} />
          <UsageBar label="Out" value={use(p.txBps)} format={() => formatBps(p.txBps)} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No traffic while the link is down.</p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {counters.map(([label, value, bad]) => (
          <div key={label} className="leading-none">
            <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
            <div className={cn('mt-1 truncate font-mono text-sm', bad && 'text-level-warn')}>{value}</div>
          </div>
        ))}
      </div>
      <div className="flex justify-between gap-3 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{p.module ? [p.module.vendor, p.module.part].filter(Boolean).join(' ') : p.pauseRx !== null && p.mtu != null ? `MTU ${p.mtu}` : `via ${p.peer?.via === 'lldp' ? 'LLDP' : 'MAC table'}`}</span>
        {p.peer?.nodeId && <span className="shrink-0">click to open</span>}
      </div>
    </div>
  )
}

/** The console jack's card: whether its cable is plugged into SparkMan's host, and as which device. */
export function ConsoleHover({ console: c, children }: { console: NonNullable<NetworkSwitch['console']>; children: ReactElement }) {
  const [open, setOpen] = useState(false)
  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={80} closeDelay={60}>
      <HoverCardTrigger asChild tabIndex={0} aria-label={`Console, ${c.connected ? 'connected' : 'not connected'}`} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side="top" sideOffset={8} className="w-72">
        <div className="space-y-3" data-testid="console-stats">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-mono text-sm font-medium">
                <span className={cn('size-2 shrink-0 rounded-full', c.connected ? LED.up : LED.down)} aria-hidden />
                Console
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {c.jack === 'usb-c' ? 'USB-C' : 'RJ45'} · to {c.host}
              </div>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{c.connected ? 'Connected' : 'Unplugged'}</span>
          </div>
          <div className="truncate rounded-md bg-surface-2 px-2 py-1 font-mono text-xs">{c.tty ?? c.device.replace('/dev/serial/by-id/', '')}</div>
          <p className="text-xs text-muted-foreground">
            {c.connected ? `Out-of-band access from ${c.host} works even when the switch's network is down.` : `${c.host} no longer sees this console: check the cable.`}
          </p>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
