import { useEffect, useRef, useState } from 'react'
import sparkmanHead from '@/assets/brand/sparkman-head.svg'
import sparkman from '@/assets/brand/sparkman.svg'
import { cn } from '@/lib/utils'

/** SparkMan's head: the app mark (rail, favicon). */
export function BrandMark({ className }: { className?: string }) {
  return <img src={sparkmanHead} alt="SparkMan" draggable={false} className={cn('object-contain select-none', className)} />
}

/** The full SparkMan, for empty and hero moments. */
export function BrandFigure({ className, alt = '' }: { className?: string; alt?: string }) {
  return <img src={sparkman} alt={alt} draggable={false} className={cn('object-contain select-none', className)} />
}

/** Deterministic PRNG so each hover's bolts are random but stable for that render. */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Jagged bolts leaping out from behind the head, all the way round (in a 64 × 56 box, head centred).
 * They start just inside the head's outline so the head hides their roots.
 */
function bolts(seed: number, count: number, reach: number): string[] {
  const rand = mulberry(seed)
  const offset = rand() * Math.PI * 2
  return Array.from({ length: count }, (_, i) => {
    const angle = offset + (i / count) * Math.PI * 2 + (rand() - 0.5) * ((Math.PI * 2) / count) * 0.6
    let x = 32 + Math.cos(angle) * 12
    let y = 28 + Math.sin(angle) * 9
    const pts = [`${x.toFixed(1)},${y.toFixed(1)}`]
    const segs = 3 + Math.floor(rand() * 2) + (reach > 1 ? 2 : 0)
    for (let s = 0; s < segs; s++) {
      const step = (3.2 + rand() * 3) * reach
      const jag = (rand() - 0.5) * 1.7
      x += Math.cos(angle + jag) * step
      y += Math.sin(angle + jag) * step
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    return `M${pts.join(' L')}`
  })
}

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function Bolts({ seed, count, reach, overcharge = false }: { seed: number; count: number; reach: number; overcharge?: boolean }) {
  return (
    <svg viewBox="0 0 64 56" className="pointer-events-none absolute -inset-x-2.5 -inset-y-2 -z-10 overflow-visible" aria-hidden>
      {bolts(seed, count, reach).map((d, i) => (
        <g key={i} className={overcharge ? 'spark-bolt spark-bolt-big' : 'spark-bolt'} style={{ animationDelay: `${i * (overcharge ? 18 : 45)}ms` }}>
          <path d={d} fill="none" stroke="var(--brand)" strokeWidth={overcharge ? 3.2 : 2.6} strokeLinecap="round" strokeLinejoin="round" opacity="0.45" />
          {/* bright core on dark; a deeper green on light so it still reads */}
          <path d={d} fill="none" className="stroke-[#3f8a00] dark:stroke-[#d4ff3a]" strokeWidth={overcharge ? 1.3 : 1} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ))}
      {overcharge && <circle cx="32" cy="28" r="14" fill="none" stroke="var(--brand)" strokeWidth="1.5" className="spark-ring" />}
    </svg>
  )
}

/**
 * The rail's mark: SparkMan's head crackles with green sparks while you hover (or focus) it,
 * and overcharges when you click. Nothing under reduced motion.
 */
export function LiveBrandMark({ className }: { className?: string }) {
  const [burst, setBurst] = useState<number | null>(null)
  const [overcharge, setOvercharge] = useState<number | null>(null)
  const [hovering, setHovering] = useState(false)
  const [prev, setPrev] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const last = useRef<number | null>(null)

  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const stop = () => {
    clear()
    setHovering(false)
  }
  // a burst now, then a fresh one every 0.3–0.5 s (each lives ~0.46 s, so they overlap) while the pointer stays
  const crackle = () => {
    if (prefersReducedMotion()) return
    clear()
    setHovering(true)
    const loop = () => {
      const next = Date.now() + Math.random()
      setPrev(last.current)
      last.current = next
      setBurst(next)
      timer.current = setTimeout(loop, 300 + Math.random() * 200)
    }
    loop()
  }
  useEffect(() => clear, [])

  return (
    <span
      className="relative isolate inline-flex"
      onPointerEnter={crackle}
      onPointerLeave={stop}
      onFocus={crackle}
      onBlur={stop}
      onPointerDown={() => !prefersReducedMotion() && setOvercharge(Date.now())}
    >
      {prev !== null && hovering && <Bolts key={prev} seed={prev} count={5 + Math.floor((prev % 1) * 3)} reach={1} />}
      {burst !== null && hovering && <Bolts key={burst} seed={burst} count={5 + Math.floor((burst % 1) * 3)} reach={1} />}
      {overcharge !== null && <Bolts key={`o${overcharge}`} seed={overcharge} count={12} reach={1.7} overcharge />}
      <BrandMark
        key={overcharge ?? 'head'}
        className={cn(className, overcharge !== null && 'motion-safe:animate-[overcharge_420ms_var(--ease-out-strong)_1]')}
      />
    </span>
  )
}
