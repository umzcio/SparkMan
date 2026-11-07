import { useNavigate } from '@tanstack/react-router'
import { Boxes, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { useDeployments, useNodes } from '@/api/hooks'
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { NAV_GROUPS } from '@/lib/nav'
import { NodeStatusDot } from './node-status-dot'

const OPEN_EVENT = 'sparkman:command-menu'

export function openCommandMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

export function CommandMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  const { data: nodes } = useNodes()
  const { data: deployments } = useDeployments()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  // keyboard-invoked dozens of times a day, so the dialog opens and closes without animation
  const run = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="Command menu" description="Jump to a page, node or deployment" className="data-[state=closed]:animate-none data-[state=open]:animate-none">
      <Command>
        <CommandInput placeholder="Search pages, nodes, models…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Pages">
            {NAV_GROUPS.flatMap((g) => g.items).map((item) => (
              <CommandItem key={item.to} value={`page ${item.label}`} onSelect={() => run(() => void navigate({ to: item.to }))}>
                <item.icon />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Nodes">
            {nodes?.map((n) => (
              <CommandItem key={n.id} value={`node ${n.id} ${n.model}`} onSelect={() => run(() => void navigate({ to: '/nodes/$nodeId', params: { nodeId: n.id } }))}>
                <NodeStatusDot status={n.status} />
                <span className="font-mono">{n.id}</span>
                <span className="ml-auto text-xs text-muted-foreground">{n.model}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Deployments">
            {deployments?.map((d) => (
              <CommandItem key={d.id} value={`deployment ${d.model} ${d.engine}`} onSelect={() => run(() => void navigate({ to: '/deployments' }))}>
                <Boxes />
                <span className="font-mono">{d.model}</span>
                <span className="ml-auto text-xs text-muted-foreground">{d.engine}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Actions">
            <CommandItem value="toggle theme dark light" onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
              {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
              Toggle theme
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  )
}
