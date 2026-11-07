/** Link speeds as switches print them: 10000 → "10G", 200000 → "200G", 2500 → "2.5G", 100 → "100M". */
export function formatLinkSpeed(mbps: number | null | undefined): string {
  if (!mbps) return '—'
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`
}

/** bits per second, SI: 8.4 Gb/s, 120 Mb/s */
export function formatBps(bps: number | null | undefined): string {
  if (bps == null) return '—'
  const units = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s']
  let v = bps
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

export const roleLabel = { fleet: '10G fleet LAN', fabric: 'QSFP fabric' } as const
