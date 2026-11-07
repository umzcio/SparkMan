type Part = string | number

/** FNV-1a 32-bit over the joined parts. */
export function hash(...parts: Part[]): number {
  const input = parts.join('|')
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mix(seed: number): number {
  let t = (seed + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** Deterministic pseudo-random number in [0, 1) for the given parts. */
export function noise(...parts: Part[]): number {
  return mix(hash(...parts))
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    return mix(a - 0x6d2b79f5)
  }
}

/** Cosine-interpolated value noise in [0, 1): continuous in t, knots every periodMs. */
export function smoothNoise(periodMs: number, t: number, ...parts: Part[]): number {
  const k = Math.floor(t / periodMs)
  const f = (t - k * periodMs) / periodMs
  const a = noise(...parts, k)
  const b = noise(...parts, k + 1)
  const w = (1 - Math.cos(f * Math.PI)) / 2
  return a + (b - a) * w
}

export function pick<T>(items: readonly T[], r: number): T {
  return items[Math.min(items.length - 1, Math.floor(r * items.length))]
}

export function pickWeighted<T>(items: readonly { value: T; weight: number }[], r: number): T {
  const total = items.reduce((s, i) => s + i.weight, 0)
  let acc = 0
  for (const item of items) {
    acc += item.weight / total
    if (r < acc) return item.value
  }
  return items[items.length - 1].value
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
