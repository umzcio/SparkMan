import type { CSSProperties } from 'react'

/** Inline style for `.enter-fade-up` stagger; capped so long lists don't keep animating. */
export const stagger = (index: number, cap = 10): CSSProperties => ({ '--i': Math.min(index, cap) }) as CSSProperties
