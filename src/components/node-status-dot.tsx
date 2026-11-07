import type { NodeStatus } from '@/api/types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export const STATUS_LABEL: Record<NodeStatus, string> = { online: 'Online', degraded: 'Degraded', offline: 'Offline', rebooting: 'Rebooting' }
const DOT: Record<NodeStatus, string> = { online: 'bg-brand', degraded: 'bg-level-warn', offline: 'bg-level-error', rebooting: 'bg-level-info' }

export function NodeStatusDot({ status, className }: { status: NodeStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2.5 shrink-0', className)} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]}>
      {status === 'online' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-30 motion-reduce:hidden" />}
      <span className={cn('relative inline-flex size-2.5 rounded-full transition-colors duration-300', DOT[status])} />
    </span>
  )
}

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  return (
    <Badge variant="outline" className="gap-1.5 font-medium" data-testid="node-status">
      <NodeStatusDot status={status} />
      {STATUS_LABEL[status]}
    </Badge>
  )
}
