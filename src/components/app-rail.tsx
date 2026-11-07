import { Link, useRouterState } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { motion } from 'motion/react'
import { Fragment } from 'react'
import { useIncidents } from '@/api/hooks'
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarSeparator,
} from '@/components/ui/sidebar'
import { NAV_GROUPS } from '@/lib/nav'
import { LiveBrandMark } from './brand-mark'
import { openCommandMenu } from './command-menu'

export function AppRail() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: incidents } = useIncidents()
  const ongoing = incidents?.filter((i) => i.status === 'ongoing').length ?? 0

  return (
    <Sidebar collapsible="icon" className="border-r-0">
      <SidebarHeader className="items-center py-4">
        <Link to="/" aria-label="SparkMan home" className="group rounded-lg p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <LiveBrandMark className="h-9 w-11 drop-shadow-[0_0_10px_color-mix(in_oklch,var(--brand)_45%,transparent)] transition-transform duration-200 ease-(--ease-out-strong) group-active:scale-95" />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {NAV_GROUPS.map((group, gi) => (
          <Fragment key={group.label}>
            {gi > 0 && <SidebarSeparator className="mx-auto w-6!" />}
            <SidebarGroup>
              <SidebarMenu className="items-center gap-1.5">
                {group.items.map((item) => {
                  const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                  return (
                    <SidebarMenuItem key={item.to} className="relative">
                      {active && (
                        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                          <motion.span layoutId="rail-active" className="size-8 rounded-md bg-sidebar-accent" transition={{ type: 'spring', duration: 0.3, bounce: 0 }} />
                        </span>
                      )}
                      <SidebarMenuButton asChild isActive={active} tooltip={item.label} className="relative justify-center transition-colors duration-200 data-[active=true]:bg-transparent data-[active=true]:text-brand">
                        <Link to={item.to} aria-label={item.label}>
                          <item.icon />
                        </Link>
                      </SidebarMenuButton>
                      {item.to === '/alerts' && ongoing > 0 && (
                        <span className="pointer-events-none absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-level-error font-mono text-[10px] font-semibold text-background" data-testid="alert-count">
                          {ongoing}
                        </span>
                      )}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroup>
          </Fragment>
        ))}
      </SidebarContent>
      <SidebarFooter className="items-center pb-4">
        <SidebarMenu className="items-center">
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search (⌘K)" onClick={openCommandMenu} className="justify-center" aria-label="Open command menu">
              <Search />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
