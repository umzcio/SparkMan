import { Link } from '@tanstack/react-router'
import { FlaskConical, Unplug } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useFleetDataSource, useSimulatorOn, type FleetArea } from '@/lib/data-source'
import type { NavPath } from '@/lib/nav'
import { cn } from '@/lib/utils'

export function PageHeader({
  crumbs, title, description, actions, fleetData = true,
}: {
  crumbs: { label: string; to?: NavPath }[]
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /**
   * false on pages that don't show fleet data (the host agents are always real); an area name on pages
   * whose data comes from that one area, so the badge goes away as soon as it's live.
   */
  fleetData?: boolean | FleetArea
}) {
  const source = useFleetDataSource(typeof fleetData === 'string' ? fleetData : undefined)
  const notLive = fleetData !== false && source !== 'live'
  const simulatorOn = useSimulatorOn()
  const simulated = notLive && simulatorOn
  const disconnected = notLive && !simulatorOn
  return (
    <header className="flex flex-col gap-4 border-b px-4 pt-4 pb-4 md:gap-5 md:px-6 md:pb-5">
      <div className="flex items-center justify-between gap-3">
      <Breadcrumb className="hidden md:block">
        <BreadcrumbList>
          {crumbs.map((c, i) => (
            <Fragment key={c.label}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {c.to && i < crumbs.length - 1 ? (
                  <BreadcrumbLink asChild>
                    <Link to={c.to}>{c.label}</Link>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
        {simulated && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="ml-auto cursor-default gap-1.5 border-level-warn/40 text-level-warn" data-testid="simulated-badge" tabIndex={0}>
                <FlaskConical className="size-3" />
                Simulated fleet data
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">Nodes, metrics, logs and deployments on this page come from SparkMan’s built-in simulator, not the real Sparks.</TooltipContent>
          </Tooltip>
        )}
        {disconnected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="ml-auto cursor-default gap-1.5 text-muted-foreground" data-testid="not-connected-badge" tabIndex={0}>
                <Unplug className="size-3" />
                Not connected yet
              </Badge>
            </TooltipTrigger>
            <TooltipContent className="max-w-64">This page’s backend isn’t built yet, so it shows nothing rather than simulated data.</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h1>
          {description && <div className="mt-1.5 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col gap-4 p-4 md:gap-6 md:p-6', className)}>{children}</div>
}
