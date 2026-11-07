import { Link, useRouterState } from '@tanstack/react-router'
import { Menu, Search } from 'lucide-react'
import { useState } from 'react'
import { useIncidents } from '@/api/hooks'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { NAV_GROUPS } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { LiveBrandMark } from './brand-mark'
import { openCommandMenu } from './command-menu'

/** Phones get a top bar with the mark, a menu (the rail's pages, with labels) and search. */
export function MobileTopBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: incidents } = useIncidents()
  const ongoing = incidents?.filter((i) => i.status === 'ongoing').length ?? 0
  const [open, setOpen] = useState(false)
  const current = NAV_GROUPS.flatMap((g) => g.items).find((i) => (i.to === '/' ? pathname === '/' : pathname.startsWith(i.to)))

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-background/85 px-2 py-2 backdrop-blur md:hidden" data-testid="mobile-topbar">
      <Button variant="ghost" size="icon" className="relative" onClick={() => setOpen(true)} aria-label="Open menu">
        <Menu />
        {ongoing > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-level-error" aria-hidden />}
      </Button>
      <Link to="/" aria-label="SparkMan home" className="flex items-center gap-2">
        <LiveBrandMark className="h-7 w-9" />
        <span className="text-sm font-semibold">SparkMan</span>
      </Link>
      {current && <span className="truncate text-sm text-muted-foreground">· {current.label}</span>}
      <Button variant="ghost" size="icon" className="ml-auto" onClick={openCommandMenu} aria-label="Search">
        <Search />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0">
          <SheetHeader className="flex-row items-center gap-3 border-b">
            <LiveBrandMark className="h-8 w-10" />
            <div>
              <SheetTitle>SparkMan</SheetTitle>
              <SheetDescription className="text-xs">DGX Spark fleet console</SheetDescription>
            </div>
          </SheetHeader>
          <nav aria-label="Pages" className="flex-1 overflow-y-auto px-2 py-3">
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.label}</div>
                {group.items.map((item) => {
                  const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors duration-150',
                        active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                      )}
                    >
                      <item.icon className={cn('size-4', active && 'text-brand')} />
                      {item.label}
                      {item.to === '/alerts' && ongoing > 0 && (
                        <span className="ml-auto grid size-5 place-items-center rounded-full bg-level-error font-mono text-[11px] font-semibold text-background">{ongoing}</span>
                      )}
                    </Link>
                  )
                })}
              </div>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </header>
  )
}
