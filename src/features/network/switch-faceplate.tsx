import type { ReactElement, ReactNode } from 'react'
import type { NetworkSwitch, SwitchPort } from '@/api/types'
import { cn } from '@/lib/utils'
import { ConsoleHover, PortHover } from './port-hover'
import { PortPanel } from './port-panel'

/**
 * Drawn faceplates for the switches SparkMan knows, with the live port states laid over them. Positions are
 * measured off the vendors' front photos (SX3832: 1U, 24 copper in two blocks of six columns, 8 SFP+; CRS804-4DDQ:
 * a half-width unit, vent grid over four QSFP56-DD cages, two 10G RJ45, console, reset, status LEDs).
 */

interface Slot {
  /** matches SwitchPort.label ('1'…'32', a QSFP cage '1'…'4', 'e1') */
  label: string
  kind: 'rj45' | 'sfp' | 'qsfp'
  x: number
  y: number
  w: number
  h: number
  /** where its number is printed; omitted when the chassis prints it */
  labelY?: number
  /** a lower-row RJ45 jack is mounted upside down (latch at the bottom) */
  flip?: boolean
}

type LedRole = 'power' | 'sys' | 'fan' | 'power1' | 'power2' | 'fault' | 'user'

interface Layout {
  w: number
  h: number
  /** the chassis colour: what the jacks' metal and the print look like */
  finish: 'dark' | 'light'
  /** how wide it draws relative to the card (a half-width unit draws at half the scale's width) */
  className: string
  slots: Slot[]
  consoles: { jack: 'rj45' | 'usb-c'; x: number; y: number; w: number; h: number }[]
  leds: { role: LedRole; x: number; y: number }[]
  /** the static parts: body, ears, vents, print */
  chassis: (id: string) => ReactNode
}

const INK = { dark: '#8b9098', light: '#646b74' } as const
const METAL = { dark: '#aeb3ba', light: '#c3c8ce' } as const
const HOLE = '#17191c'

// ---------- TP-Link SX3832 (1U, dark) ----------

function sx3832(): Layout {
  const W = 1000
  const H = 92
  const EAR = 26
  const slots: Slot[] = []
  // two blocks of six columns, odd ports on top
  for (let n = 1; n <= 24; n++) {
    const col = Math.floor((n - 1) / 2)
    const top = n % 2 === 1
    slots.push({ label: String(n), kind: 'rj45', x: 327 + col * 32 + (col >= 6 ? 10 : 0), y: top ? 21 : 51, w: 28, h: 22, labelY: top ? 16 : 82, flip: !top })
  }
  for (let n = 25; n <= 32; n++) {
    const col = Math.floor((n - 25) / 2)
    const top = n % 2 === 1
    slots.push({ label: String(n), kind: 'sfp', x: 729 + col * 40, y: top ? 21 : 51, w: 34, h: 21, labelY: top ? 16 : 82 })
  }
  return {
    w: W,
    h: H,
    finish: 'dark',
    className: 'w-full',
    slots,
    consoles: [
      { jack: 'usb-c', x: 218, y: 68, w: 19, h: 6 },
      { jack: 'rj45', x: 247, y: 44, w: 37, h: 31 },
    ],
    leds: [
      { role: 'power', x: 140, y: 46 },
      { role: 'sys', x: 140, y: 58 },
      { role: 'fan', x: 140, y: 70 },
    ],
    chassis: (id) => (
      <>
        <defs>
          <linearGradient id={`body-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b3e43" />
            <stop offset="1" stopColor="#25272b" />
          </linearGradient>
        </defs>
        {/* rack ears with their screw slots */}
        {[0, W - EAR].map((x) => (
          <g key={x}>
            <rect x={x} y={2} width={EAR} height={H - 4} rx={3} fill="#2c2e33" stroke="#0e0f11" />
            {[20, H - 20].map((y) => <rect key={y} x={x + 7} y={y - 4} width={12} height={8} rx={4} fill="#0e0f11" />)}
          </g>
        ))}
        <rect x={EAR} y={0} width={W - 2 * EAR} height={H} rx={3} fill={`url(#body-${id})`} stroke="#0e0f11" />
        <text x={44} y={52} fill="#d4d6da" fontSize={9} fontWeight={600} className="font-mono">SX3832</text>
        <text x={44} y={61} fill={INK.dark} fontSize={5}>24-Port 10GBASE-T L2+ Managed</text>
        <text x={44} y={67} fill={INK.dark} fontSize={5}>Switch with 8 10GE SFP+ Slots</text>
        {['PWR', 'SYS', 'FAN'].map((l, i) => <text key={l} x={146} y={48 + i * 12} fill={INK.dark} fontSize={5}>{l}</text>)}
        <text x={228} y={58} textAnchor="middle" fill={INK.dark} fontSize={4.5}>Console</text>
        <text x={228} y={63} textAnchor="middle" fill={INK.dark} fontSize={4.5}>(Type C)</text>
        <text x={265} y={40} textAnchor="middle" fill={INK.dark} fontSize={4.5}>Console (RJ45)</text>
        {/* the copper blocks' bezels */}
        <rect x={323} y={18} width={196} height={58} rx={2} fill="none" stroke="#4a4e55" />
        <rect x={525} y={18} width={196} height={58} rx={2} fill="none" stroke="#4a4e55" />
        <text x={900} y={36} fill={INK.dark} fontSize={4.5}>Port 1-24 · Port 25-32</text>
        <text x={900} y={44} fill={INK.dark} fontSize={4.5}>Link / Activity</text>
      </>
    ),
  }
}

// ---------- MikroTik CRS804-4DDQ (half-width, white) ----------

function crs804(): Layout {
  const W = 500
  const H = 100
  const cages = [26, 84, 144, 204]
  return {
    w: W,
    h: H,
    finish: 'light',
    // half the width of a 1U unit, so both switches draw at one scale
    className: 'w-1/2 min-w-[26rem]',
    slots: [
      ...cages.map((x, i) => ({ label: String(i + 1), kind: 'qsfp' as const, x, y: 54, w: 40, h: 25 })),
      { label: 'e1', kind: 'rj45', x: 270, y: 56, w: 33, h: 21 },
      { label: 'e2', kind: 'rj45', x: 306, y: 56, w: 33, h: 21 },
    ],
    consoles: [{ jack: 'rj45', x: 364, y: 56, w: 33, h: 21 }],
    leds: [
      { role: 'user', x: 445, y: 56 },
      { role: 'fault', x: 445, y: 62 },
      { role: 'power2', x: 445, y: 68 },
      { role: 'power1', x: 445, y: 74 },
    ],
    chassis: (id) => (
      <>
        <defs>
          {/* the front's vent grid */}
          <pattern id={`vent-${id}`} width={5} height={5} patternUnits="userSpaceOnUse">
            <rect x={0.8} y={0.8} width={3.4} height={3.4} rx={0.4} fill="#6d737b" />
          </pattern>
          <linearGradient id={`body-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f1f2f4" />
            <stop offset="1" stopColor="#dfe1e4" />
          </linearGradient>
        </defs>
        <rect x={0.5} y={0.5} width={W - 1} height={H - 1} rx={3} fill={`url(#body-${id})`} stroke="#b9bdc3" />
        <rect x={8} y={7} width={W - 16} height={35} fill={`url(#vent-${id})`} />
        <text x={488} y={50} textAnchor="end" fill="#3f454d" fontSize={8.5} fontWeight={700} className="font-mono">CRS804-4DDQ</text>
        {/* the cages' link LEDs, where the unit has them */}
        {[16, 74, 197].map((x) => (
          <g key={x}>
            {[57, 62, 67, 72].map((y) => <circle key={y} cx={x + 2} cy={y} r={1.3} fill="#b4b9bf" stroke="#9aa0a7" strokeWidth={0.4} />)}
          </g>
        ))}
        {cages.map((x, i) => <text key={x} x={x + 20} y={51} textAnchor="middle" fill={INK.light} fontSize={5.5}>{i + 1}</text>)}
        <text x={266} y={55} textAnchor="end" fill={INK.light} fontSize={5.5}>1</text>
        <text x={343} y={55} fill={INK.light} fontSize={5.5}>2</text>
        {/* the brackets the unit prints under its port groups */}
        <path d="M26 81 V84 H244 V81" fill="none" stroke="#9aa0a7" strokeWidth={0.6} />
        <text x={135} y={91} textAnchor="middle" fill={INK.light} fontSize={5}>400G QSFP56-DD</text>
        <path d="M270 81 V84 H339 V81" fill="none" stroke="#9aa0a7" strokeWidth={0.6} />
        <text x={304.5} y={91} textAnchor="middle" fill={INK.light} fontSize={5}>10G / MGMT / BOOT</text>
        <text x={380.5} y={86} textAnchor="middle" fill={INK.light} fontSize={5}>CONSOLE</text>
        <circle cx={424} cy={66} r={3} fill="#3f454d" />
        <text x={424} y={78} textAnchor="middle" fill={INK.light} fontSize={5}>RESET</text>
        {['USER', 'FAULT', 'POWER 2', 'POWER 1'].map((l, i) => <text key={l} x={450} y={57.8 + i * 6} fill={INK.light} fontSize={4.6}>{l}</text>)}
      </>
    ),
  }
}

function layoutFor(model: string): Layout | null {
  if (/SX3832/i.test(model)) return sx3832()
  if (/CRS804/i.test(model)) return crs804()
  return null
}

type Tone = 'up' | 'slow' | 'lost' | 'empty'

function tone(p: SwitchPort | undefined): Tone {
  if (!p) return 'empty'
  if (p.problem) return 'slow'
  if (p.up) return 'up'
  return p.peer?.nodeId ? 'lost' : 'empty'
}

/** the jack's opening, tinted by state, and its frame's outline */
const OPENING: Record<Tone, string> = { up: 'fill-brand/70', slow: 'fill-level-warn/75', lost: 'fill-level-error/45', empty: '' }
const OUTLINE: Record<Tone, string> = { up: 'stroke-brand', slow: 'stroke-level-warn', lost: 'stroke-level-error', empty: '' }

export function SwitchFaceplate({ sw }: { sw: NetworkSwitch }) {
  const layout = layoutFor(sw.model)
  if (!layout) return <PortPanel sw={sw} />
  const byLabel = new Map(sw.ports.map((p) => [p.label, p]))
  const lanes = (cage: string) => sw.ports.filter((p) => p.kind === 'qsfp' && p.label.split('·')[0] === cage)
  return (
    <svg viewBox={`0 0 ${layout.w} ${layout.h}`} className={cn('select-none', layout.className)} role="group" aria-label={`${sw.name} front panel`} data-testid={`faceplate-${sw.id}`}>
      {layout.chassis(sw.id)}
      {layout.leds.map((l) => <Led key={l.role} x={l.x} y={l.y} on={ledOn(sw, l.role)} fault={l.role === 'fault'} />)}
      {layout.consoles.map((c) => {
        const used = sw.console?.jack === c.jack ? sw.console : null
        const jack = <Jack slot={{ label: 'console', kind: 'rj45', x: c.x, y: c.y, w: c.w, h: c.h }} finish={layout.finish} state={used ? (used.connected ? 'up' : 'lost') : 'empty'} usbC={c.jack === 'usb-c'} />
        return used ? (
          <ConsoleHover key={c.jack} console={used}>
            <g className="outline-none [&:hover_.frame]:stroke-white" data-testid="faceplate-console" data-connected={used.connected}>
              {jack}
            </g>
          </ConsoleHover>
        ) : (
          <g key={c.jack}>{jack}</g>
        )
      })}
      {layout.slots.map((s) => {
        const port = byLabel.get(s.label)
        const slot: ReactElement = (
          <g key={s.label} className="outline-none [&:hover_.frame]:stroke-white [&:focus-visible_.frame]:stroke-ring" data-testid="faceplate-port" data-up={port?.up ?? false}>
            <Jack slot={s} finish={layout.finish} state={tone(port)} module={!!port?.module || (s.kind === 'qsfp' && !!port?.up)} />
            {s.labelY !== undefined && (
              <text x={s.x + s.w / 2} y={s.labelY} textAnchor="middle" fill={INK[layout.finish]} fontSize={5.5} className="pointer-events-none">
                {s.label}
              </text>
            )}
            {s.kind === 'qsfp' && <LaneStrip slot={s} lanes={lanes(s.label)} />}
          </g>
        )
        // a lower-row port opens its card below, so the upper row stays hoverable
        return port ? (
          <PortHover key={s.label} port={port} side={s.flip || (s.kind === 'sfp' && s.y > layout.h / 2) ? 'bottom' : 'top'}>
            {slot}
          </PortHover>
        ) : (
          slot
        )
      })}
    </svg>
  )
}

function ledOn(sw: NetworkSwitch, role: LedRole): boolean {
  if (!sw.reachable) return false
  const psu = (n: number) => sw.health.find((h) => h.label === `PSU ${n} state`)
  if (role === 'power1') return psu(1)?.status !== 'bad'
  if (role === 'power2') return psu(2)?.status !== 'bad'
  if (role === 'fault') return sw.health.some((h) => h.status === 'bad')
  if (role === 'user') return false
  return true
}

function Led({ x, y, on, fault }: { x: number; y: number; on: boolean; fault?: boolean }) {
  return <circle cx={x} cy={y} r={1.9} className={on ? (fault ? 'fill-level-error' : 'fill-brand') : 'fill-[#6b7078]'} style={on ? { filter: `drop-shadow(0 0 2px ${fault ? '#f2545b' : '#76b900'})` } : undefined} />
}

/**
 * A port: the metal frame, the opening (tinted by the link's state), an RJ45's latch notch or a cage's module.
 * The frame (class `frame`) takes the hover outline.
 */
function Jack({ slot: s, finish, state, module, usbC }: { slot: Slot; finish: 'dark' | 'light'; state: Tone; module?: boolean; usbC?: boolean }) {
  const lit = state !== 'empty'
  if (usbC) {
    return <rect className={cn('frame', OUTLINE[state], OPENING[state])} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.h / 2} fill={lit ? undefined : HOLE} stroke={lit ? undefined : METAL[finish]} strokeWidth={1} />
  }
  const inset = s.kind === 'rj45' ? 2.2 : 2
  const ox = s.x + inset
  const oy = s.y + inset
  const ow = s.w - inset * 2
  const oh = s.h - inset * 2
  return (
    <g>
      <rect className={cn('frame', OUTLINE[state])} x={s.x} y={s.y} width={s.w} height={s.h} rx={1.5} fill={METAL[finish]} stroke={lit ? undefined : '#00000040'} strokeWidth={lit ? 1.6 : 0.6} />
      <rect className={OPENING[state]} x={ox} y={oy} width={ow} height={oh} rx={1} fill={lit ? undefined : HOLE} />
      {s.kind === 'rj45' ? (
        // the latch notch, on the side the clip goes
        <rect x={s.x + s.w / 2 - s.w * 0.17} y={s.flip ? s.y + s.h - inset - 5 : oy} width={s.w * 0.34} height={5} fill={HOLE} opacity={lit ? 0.85 : 1} />
      ) : (
        module && (
          // a plugged module's body and pull tab
          <g className="pointer-events-none">
            <rect x={ox + 2} y={oy + oh * 0.22} width={ow - 4} height={oh * 0.56} rx={1} fill="#d9dcdf" opacity={0.9} />
            <rect x={ox + ow / 2 - 4} y={oy + oh * 0.36} width={8} height={oh * 0.28} rx={0.8} fill="#4b5058" />
          </g>
        )
      )}
    </g>
  )
}

/** A QSFP-DD cage's 8 lanes, when it is broken out: lit while that lane's link is up. */
function LaneStrip({ slot: s, lanes }: { slot: Slot; lanes: SwitchPort[] }) {
  if (lanes.length <= 1) return null
  const up = new Set(lanes.filter((p) => p.up).map((p) => p.lane ?? 1))
  const w = (s.w - 8) / 8
  return (
    <g className="pointer-events-none">
      {Array.from({ length: 8 }, (_, i) => (
        <rect key={i} x={s.x + 4 + i * w} y={s.y + s.h - 3.5} width={w - 1} height={2} className={up.has(i + 1) ? 'fill-brand' : 'fill-white/40'} />
      ))}
    </g>
  )
}
