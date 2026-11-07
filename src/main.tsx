import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClientProvider, type SparkManClient } from '@/api/client'
import { LiveClient } from '@/api/live-client'
import { MockClient } from '@/api/mock/mock-client'
import { NullClient } from '@/api/null-client'
import { Simulator } from '@/api/mock/simulator'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LoginScreen, getSession } from '@/features/auth/login-screen'
import { DataSourceProvider, FLEET_AREAS, type DataSourceValue, type FleetArea } from '@/lib/data-source'
import { routeTree } from './routeTree.gen'
import './index.css'

const root = createRoot(document.getElementById('root')!)
const themed = (children: React.ReactNode) => (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="sparkman-theme" disableTransitionOnChange scriptProps={{ type: 'application/json' }}>
    {children}
  </ThemeProvider>
)

// Sign-in first: with no session the console (and every /api call) is off limits.
const session = await getSession()
if (session.authEnabled && !session.user) {
  root.render(<StrictMode>{themed(<LoginScreen onSignedIn={() => window.location.reload()} />)}</StrictMode>)
  await new Promise(() => {}) // the page reloads after sign-in
}
// A session that expires or is revoked mid-use sends the browser back to the sign-in screen.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (...args) => {
  const res = await nativeFetch(...args)
  const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
  if (res.status === 401 && session.authEnabled && url.includes('/api/') && !url.includes('/api/auth/')) window.location.reload()
  return res
}

// Phase 2: on a host with a live fleet, live areas come from the backend and the rest show nothing
// ("Not connected yet"); without one (dev, e2e) the whole console runs on the simulator.
const health = await LiveClient.probe()
const liveAreas = new Set((health?.live ?? []).filter((a): a is FleetArea => (FLEET_AREAS as string[]).includes(a)))
const simulatorOn = liveAreas.size === 0
let client: SparkManClient
if (simulatorOn) {
  const simulator = new Simulator()
  simulator.start(2000)
  client = new MockClient(simulator)
} else {
  client = new LiveClient(new NullClient(), liveAreas)
}
const dataSource: DataSourceValue = { live: liveAreas, simulator: simulatorOn }

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false, retry: 1 } },
})

const router = createRouter({ routeTree, defaultPreload: 'intent', scrollRestoration: true })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

root.render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="sparkman-theme" disableTransitionOnChange scriptProps={{ type: 'application/json' }}>
      <DataSourceProvider value={dataSource}>
      <ClientProvider client={client}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={200}>
            <RouterProvider router={router} />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </QueryClientProvider>
      </ClientProvider>
      </DataSourceProvider>
    </ThemeProvider>
  </StrictMode>,
)
