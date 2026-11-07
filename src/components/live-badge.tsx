import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function LiveBadge({ live, onToggle }: { live: boolean; onToggle?: () => void }) {
  const dot = <span className={cn('size-2 rounded-full', live ? 'bg-brand motion-safe:animate-pulse' : 'bg-muted-foreground')} />
  if (!onToggle) {
    return (
      <Badge variant="outline" className="gap-1.5 border-brand/40 text-brand">
        {dot}Live
      </Badge>
    )
  }
  return (
    <Button variant="outline" size="sm" aria-pressed={live} onClick={onToggle} className={cn('gap-1.5', live && 'border-brand/40 text-brand')}>
      {dot}Live
    </Button>
  )
}
