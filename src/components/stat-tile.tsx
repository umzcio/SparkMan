import type { LucideIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const TONE = { default: '', brand: 'text-brand', warn: 'text-level-warn', error: 'text-level-error' } as const

export function StatTile({ label, value, hint, icon: Icon, tone = 'default', testId, className, style }: { label: string; value: ReactNode; hint?: ReactNode; icon?: LucideIcon; tone?: keyof typeof TONE; testId?: string; className?: string; style?: CSSProperties }) {
  return (
    <Card className={cn('gap-2 py-4', className)} style={style} data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between px-4">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">{label}</CardDescription>
        {Icon && <Icon className="size-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent className="px-4">
        <div className={cn('font-mono text-2xl font-semibold tabular-nums transition-colors duration-300', TONE[tone])} data-testid="stat-value">{value}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  )
}
