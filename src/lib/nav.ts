import type { ComponentType } from 'react'
import { ClaudeIcon } from '@/components/claude-mark'
import { CodexIcon } from '@/components/codex-mark'
import { Bell, Boxes, ChartColumn, Fan, House, KeyRound, Network, PackageCheck, Plug, ScrollText, Server, Settings, Timer, type LucideIcon } from 'lucide-react'

export type NavPath = '/' | '/nodes' | '/cooling' | '/network' | '/gateway' | '/deployments' | '/benchmarks' | '/usage' | '/keys' | '/logs' | '/alerts' | '/updates' | '/settings' | '/agent' | '/codex'

export interface NavItem {
  to: NavPath
  label: string
  icon: LucideIcon | ComponentType<{ className?: string }>
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  { label: 'Fleet', items: [{ to: '/', label: 'Overview', icon: House }, { to: '/nodes', label: 'Nodes', icon: Server }, { to: '/cooling', label: 'Cooling', icon: Fan }, { to: '/network', label: 'Network', icon: Network }] },
  {
    label: 'AI Gateway',
    items: [
      { to: '/gateway', label: 'Endpoint', icon: Plug },
      { to: '/deployments', label: 'Deployments', icon: Boxes },
      { to: '/benchmarks', label: 'Benchmarks', icon: Timer },
      { to: '/usage', label: 'Usage', icon: ChartColumn },
      { to: '/keys', label: 'API Keys', icon: KeyRound },
    ],
  },
  { label: 'Observe', items: [{ to: '/logs', label: 'Logs', icon: ScrollText }, { to: '/alerts', label: 'Alerts', icon: Bell }] },
  { label: 'Maintain', items: [{ to: '/updates', label: 'Updates', icon: PackageCheck }, { to: '/settings', label: 'Settings', icon: Settings }] },
  { label: 'Host', items: [{ to: '/agent', label: 'Claude', icon: ClaudeIcon }, { to: '/codex', label: 'Codex', icon: CodexIcon }] },
]
