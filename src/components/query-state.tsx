import type { UseQueryResult } from '@tanstack/react-query'
import { CircleAlert, CircleSlash } from 'lucide-react'
import type { ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center" data-testid="empty-state">
      <CircleSlash className="size-5 text-muted-foreground" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function QueryState<T>({ query, children, skeleton, isEmpty, empty }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: ReactNode; isEmpty?: (data: T) => boolean; empty?: ReactNode }) {
  if (query.isPending) return <>{skeleton ?? <Skeleton className="h-32 w-full" />}</>
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertTitle>Couldn’t load data</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {query.error instanceof Error ? query.error.message : 'Unknown error'}
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>
  return <>{children(query.data)}</>
}
