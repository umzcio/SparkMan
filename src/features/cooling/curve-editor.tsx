import { RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useSetCoolingPolicy } from '@/api/hooks'
import type { CoolingPolicy, CurvePoint, FleetNode } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CURVE_TEMP_MAX, CURVE_TEMP_MIN, DEFAULT_POLICY, curveDuty, validatePolicy } from '@/lib/cooling'
import { fromPx, toPx, type Box } from './curve-geometry'

// wide screens get a long, low chart; phones a taller one so labels and points stay readable
const WIDE: Box = { w: 760, h: 260, pad: 44 }
const NARROW: Box = { w: 400, h: 260, pad: 44 }
const TEMP_TICKS = [30, 45, 60, 75, 90]
const DUTY_TICKS = [0, 25, 50, 75, 100]
const same = (a: CoolingPolicy, b: CoolingPolicy) => JSON.stringify(a) === JSON.stringify(b)

export function CurveEditor({ policy, nodes }: { policy: CoolingPolicy; nodes: FleetNode[] }) {
  const save = useSetCoolingPolicy()
  const [draft, setDraft] = useState(policy)
  const [dragging, setDragging] = useState<number | null>(null)
  const svg = useRef<SVGSVGElement>(null)
  // chart units per screen pixel: on a phone the chart shrinks, so labels and hit targets grow to stay usable
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const BOX = width > 0 && width < 520 ? NARROW : WIDE
  const unitsPerPx = width > 0 ? BOX.w / width : 1
  const label = Math.max(11, 10 * unitsPerPx)
  const hitR = Math.max(18, 14 * unitsPerPx)
  const dotR = Math.max(6.5, 5 * unitsPerPx)
  // a newly saved policy replaces the draft unless the draft holds unsaved edits
  const [saved, setSaved] = useState(policy)
  if (!same(saved, policy)) {
    setSaved(policy)
    if (same(draft, saved)) setDraft(policy)
  }
  const dirty = !same(draft, policy)
  const error = validatePolicy(draft)

  const move = (i: number, p: CurvePoint) => setDraft((d) => ({ ...d, curve: d.curve.map((q, j) => (j === i ? p : q)) }))

  // follow the pointer on the window so a drag survives leaving the chart
  const grab = (i: number) => (e: PointerEvent<SVGCircleElement>) => {
    e.preventDefault()
    setDragging(i)
    const follow = (ev: globalThis.PointerEvent) => {
      if (!svg.current) return
      const r = svg.current.getBoundingClientRect()
      move(i, fromPx(((ev.clientX - r.left) / r.width) * BOX.w, ((ev.clientY - r.top) / r.height) * BOX.h, BOX))
    }
    const release = () => {
      setDragging(null)
      window.removeEventListener('pointermove', follow)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
    window.addEventListener('pointermove', follow)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
  }
  const onKey = (i: number) => (e: KeyboardEvent) => {
    const p = draft.curve[i]
    const step = e.shiftKey ? 5 : 1
    const next = { ArrowUp: { ...p, duty: p.duty + step }, ArrowDown: { ...p, duty: p.duty - step }, ArrowRight: { ...p, tempC: p.tempC + step }, ArrowLeft: { ...p, tempC: p.tempC - step } }[e.key]
    if (!next) return
    e.preventDefault()
    move(i, { tempC: Math.min(CURVE_TEMP_MAX, Math.max(CURVE_TEMP_MIN, next.tempC)), duty: Math.min(100, Math.max(0, next.duty)) })
  }

  const path = draft.curve.map((p, i) => `${i ? 'L' : 'M'}${toPx(p, BOX).x},${toPx(p, BOX).y}`).join(' ')
  const ends = `M${BOX.pad},${toPx(draft.curve[0], BOX).y} L${toPx(draft.curve[0], BOX).x},${toPx(draft.curve[0], BOX).y} M${toPx(draft.curve.at(-1)!, BOX).x},${toPx(draft.curve.at(-1)!, BOX).y} L${BOX.w - BOX.pad},${toPx(draft.curve.at(-1)!, BOX).y}`
  const shelf = nodes.filter((n) => n.rack.shelf === 1 && n.live)

  return (
    <Card className="gap-3 py-4" data-testid="curve-editor">
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardTitle className="text-sm font-medium">Fan curve</CardTitle>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(structuredClone(DEFAULT_POLICY))} data-testid="curve-reset">
            <RotateCcw /> Default
          </Button>
          <Button size="sm" disabled={!dirty || error !== null || save.isPending} onClick={() => save.mutate(draft)} data-testid="curve-save">
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <svg
          ref={svg}
          viewBox={`0 0 ${BOX.w} ${BOX.h}`}
          className="w-full select-none"
          role="group"
          aria-label="Fan speed by GPU temperature"
        >
          {DUTY_TICKS.map((d) => {
            const y = toPx({ tempC: CURVE_TEMP_MIN, duty: d }, BOX).y
            return (
              <g key={d}>
                <line x1={BOX.pad} x2={BOX.w - BOX.pad} y1={y} y2={y} className="stroke-border" strokeDasharray="3 3" />
                <text x={BOX.pad - 6} y={y + 4} textAnchor="end" className="fill-muted-foreground" fontSize={label}>{d}%</text>
              </g>
            )
          })}
          {TEMP_TICKS.map((t) => (
            <text key={t} x={toPx({ tempC: t, duty: 0 }, BOX).x} y={BOX.h - 10} textAnchor="middle" className="fill-muted-foreground" fontSize={label}>{t} °C</text>
          ))}
          <path d={ends} className="stroke-brand/40" strokeWidth={2} strokeDasharray="4 4" fill="none" />
          <path d={path} className="stroke-brand" strokeWidth={2.5} fill="none" />
          {shelf.map((n) => {
            const { x, y } = toPx({ tempC: Math.min(CURVE_TEMP_MAX, Math.max(CURVE_TEMP_MIN, n.live!.gpuTempC)), duty: curveDuty(draft.curve, n.live!.gpuTempC) }, BOX)
            return (
              <g key={n.id} data-testid="curve-node-dot">
                <circle cx={x} cy={y} r={4} className="fill-foreground/70" />
                <title>{`${n.id} ${Math.round(n.live!.gpuTempC)} °C`}</title>
              </g>
            )
          })}
          {draft.curve.map((p, i) => {
            const { x, y } = toPx(p, BOX)
            return (
              <g key={i}>
                {/* big invisible hit target for touch */}
                <circle cx={x} cy={y} r={hitR} fill="transparent" onPointerDown={grab(i)} className="cursor-grab" style={{ touchAction: 'none' }} data-testid="curve-hit" />
                <circle
                  cx={x}
                  cy={y}
                  r={dragging === i ? dotR * 1.25 : dotR}
                  className="fill-background stroke-brand outline-none focus-visible:stroke-[4]"
                  strokeWidth={2.5}
                  tabIndex={0}
                  role="slider"
                  aria-label={`Curve point ${i + 1}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={p.duty}
                  aria-valuetext={`${p.tempC} °C, ${p.duty}%`}
                  onKeyDown={onKey(i)}
                  onPointerDown={grab(i)}
                  data-testid="curve-point"
                  data-index={i}
                />
              </g>
            )
          })}
        </svg>
        {error && (
          <p className="text-sm text-level-error" data-testid="curve-error">{error}</p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField id="lf-util" label="Load floor at" suffix="% GPU" value={draft.loadFloor.util} onChange={(v) => setDraft((d) => ({ ...d, loadFloor: { ...d.loadFloor, util: v } }))} />
          <NumberField id="lf-duty" label="…runs at least" suffix="%" value={draft.loadFloor.duty} onChange={(v) => setDraft((d) => ({ ...d, loadFloor: { ...d.loadFloor, duty: v } }))} />
          <NumberField id="min-duty" label="Never below" suffix="%" value={draft.minDuty} onChange={(v) => setDraft((d) => ({ ...d, minDuty: v }))} />
        </div>
      </CardContent>
    </Card>
  )
}

function NumberField({ id, label, suffix, value, onChange }: { id: string; label: string; suffix: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} type="number" inputMode="numeric" min={0} max={100} value={Number.isNaN(value) ? '' : value} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} className="h-8 w-20 font-mono" />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </div>
    </div>
  )
}
