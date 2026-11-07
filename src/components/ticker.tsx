import { animate, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const EASE_OUT_STRONG = [0.23, 1, 0.32, 1] as const

/**
 * Tweens a live number between refreshes so values glide instead of jumping every tick.
 * Null (no data) renders immediately; reduced motion renders immediately.
 */
export function Ticker({ value, format, className }: { value: number | null; format: (v: number | null) => string; className?: string }) {
  const reduce = useReducedMotion()
  const [display, setDisplay] = useState<number | null>(value)
  const current = useRef<number | null>(value)

  useEffect(() => {
    const from = current.current
    if (value === null || from === null || reduce || Number.isNaN(value) || Number.isNaN(from)) {
      current.current = value
      setDisplay(value)
      return
    }
    const controls = animate(from, value, {
      duration: 0.6,
      ease: EASE_OUT_STRONG,
      onUpdate: (v) => {
        current.current = v
        setDisplay(v)
      },
    })
    return () => controls.stop()
  }, [value, reduce])

  return <span className={cn('tabular-nums', className)}>{format(display)}</span>
}
