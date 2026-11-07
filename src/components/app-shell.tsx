import { Outlet, useRouterState } from '@tanstack/react-router'
import type { CSSProperties } from 'react'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppRail } from './app-rail'
import { CommandMenu } from './command-menu'
import { MobileTopBar } from './mobile-nav'

export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <div className="relative min-h-svh bg-canvas">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(55%_45%_at_0%_0%,color-mix(in_oklch,var(--brand)_16%,transparent),transparent_70%),radial-gradient(45%_40%_at_100%_100%,color-mix(in_oklch,var(--brand)_9%,transparent),transparent_70%)]"
      />
      <SidebarProvider open={false} style={{ '--sidebar-width-icon': '4rem' } as CSSProperties}>
        <AppRail />
        {/* full-bleed on phones; a floating panel beside the rail from md up */}
        <SidebarInset className="relative min-h-svh bg-background md:my-3 md:mr-3 md:min-h-[calc(100svh-1.5rem)] md:overflow-hidden md:rounded-2xl md:border md:shadow-2xl md:shadow-black/40">
          <MobileTopBar />
          {/* keyed by path: a short fade-up on page change, not on filter/search changes */}
          <div key={pathname} className="enter-page flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </SidebarInset>
        <CommandMenu />
      </SidebarProvider>
    </div>
  )
}
