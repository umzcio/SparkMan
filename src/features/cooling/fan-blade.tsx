import { useReducedMotion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

/** A 140 mm fan seen from the front. Spins at a speed proportional to RPM (not literally — 1500 rpm would blur). */
export function FanBlade({ rpm, maxRpm, stalled, className }: { rpm: number; maxRpm: number; stalled: boolean; className?: string }) {
  const reduce = useReducedMotion()
  const spinning = !reduce && rpm > 0
  // full speed ≈ one turn every 0.35 s; minimum spin ≈ one every 1.8 s
  const period = rpm > 0 ? Math.min(1.8, 0.35 * (maxRpm / rpm)) : 0
  // one endless 1 s turn; speed is its playbackRate, which changes without jumping the blade's angle
  const rotor = useRef<SVGGElement>(null)
  const spin = useRef<Animation | null>(null)
  useEffect(() => {
    const el = rotor.current
    if (!el || typeof el.animate !== 'function') return
    spin.current = el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1000, iterations: Infinity })
    return () => spin.current?.cancel()
  }, [])
  useEffect(() => {
    const a = spin.current
    if (!a) return
    if (!spinning) a.pause()
    else {
      a.updatePlaybackRate(1 / period)
      if (a.playState !== 'running') a.play()
    }
  }, [spinning, period])
  return (
    <svg viewBox="-50 -50 100 100" className={cn('text-foreground/70', stalled && 'text-level-error', className)} aria-hidden>
      <rect x={-48} y={-48} width={96} height={96} rx={10} className="fill-surface-2 stroke-border" strokeWidth={2} />
      {[[-38, -38], [38, -38], [-38, 38], [38, 38]].map(([x, y]) => (
        <circle key={`${x}${y}`} cx={x} cy={y} r={3} className="fill-background stroke-border" />
      ))}
      <circle r={44} className="fill-background/60 stroke-border" strokeWidth={1.5} />
      <g ref={rotor} style={{ transformOrigin: 'center', transformBox: 'fill-box' }}>
        <g>
          {/* keeps the rotating group's box square so it spins about the hub */}
          <circle r={44} fill="none" />
          {Array.from({ length: 7 }, (_, i) => (
            <path key={i} d="M0 -12 C 14 -20, 30 -26, 38 -14 C 30 -10, 16 -6, 6 -2 Z" transform={`rotate(${(360 / 7) * i})`} className="fill-current" opacity={0.85} />
          ))}
          <circle r={12} className="fill-surface-2 stroke-current" strokeWidth={1.5} />
        </g>
      </g>
    </svg>
  )
}
