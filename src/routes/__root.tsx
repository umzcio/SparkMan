import { Link, createRootRoute } from '@tanstack/react-router'
import { useClientEvents } from '@/api/hooks'
import { AppShell } from '@/components/app-shell'
import { PageBody, PageHeader } from '@/components/page-header'
import { BrandFigure } from '@/components/brand-mark'
import { EmptyState } from '@/components/query-state'
import { Button } from '@/components/ui/button'

function RootLayout() {
  useClientEvents()
  return <AppShell />
}

function NotFound() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'SparkMan', to: '/' }, { label: 'Not found' }]} title="Page not found" />
      <PageBody>
        <div className="flex flex-col items-center gap-2 py-6">
          <BrandFigure className="enter-pop h-56 w-auto" />
          <EmptyState
            title="This page doesn’t exist"
            description="SparkMan looked everywhere. The link may be out of date."
            action={
              <Button asChild variant="outline">
                <Link to="/">Back to overview</Link>
              </Button>
            }
          />
        </div>
      </PageBody>
    </>
  )
}

export const Route = createRootRoute({ component: RootLayout, notFoundComponent: NotFound })
