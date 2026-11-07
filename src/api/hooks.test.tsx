import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ClientProvider, type SparkManClient } from './client'
import { useCatalog, useClientEvents, useKeys, useNodes, useRoutes } from './hooks'
import { MockClient } from './mock/mock-client'
import { Simulator } from './mock/simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()

function wrapperFor(client: SparkManClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ClientProvider client={client}>{children}</ClientProvider>
    </QueryClientProvider>
  )
}

describe('hooks', () => {
  it('refetches live queries on every tick', async () => {
    const sim = new Simulator({ now: () => START })
    const client = new MockClient(sim, { latencyMs: 0 })
    const spy = vi.spyOn(client, 'listNodes')
    const { result } = renderHook(() => {
      useClientEvents()
      return useNodes()
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.data).toHaveLength(12))
    act(() => sim.tick())
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
  })

  it('invalidates topic queries on change events', async () => {
    const sim = new Simulator({ now: () => START })
    const client = new MockClient(sim, { latencyMs: 0 })
    const { result } = renderHook(() => {
      useClientEvents()
      return useKeys()
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.data).toHaveLength(7))
    act(() => {
      sim.createKey({ name: 'hooks-test', rateLimitRpm: 60 })
    })
    await waitFor(() => expect(result.current.data).toHaveLength(8))
  })

  it('recovers errored queries when the simulated outage ends', async () => {
    const sim = new Simulator({ now: () => START })
    sim.setFailures({ apiErrors: true })
    const client = new MockClient(sim, { latencyMs: 0 })
    const { result } = renderHook(() => {
      useClientEvents()
      return useCatalog()
    }, { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.isError).toBe(true))
    act(() => sim.setFailures({ apiErrors: false }))
    await waitFor(() => expect(result.current.data?.length).toBeGreaterThan(5))
  })
  it('refreshes route health when a rollout reboots a node', async () => {
    let t = START
    const sim = new Simulator({ now: () => t })
    const client = new MockClient(sim, { latencyMs: 0 })
    const { result } = renderHook(() => {
      useClientEvents()
      return useRoutes()
    }, { wrapper: wrapperFor(client) })
    const mistral = () => result.current.data?.find((r) => r.deploymentId === 'dep-mistral24')?.healthy
    await waitFor(() => expect(mistral()).toBe(true))
    sim.startRollout({ targetOs: '7.5.0', rings: ['canary'], window: 'Now', requireApproval: false })
    for (const dt of [0, 4000, 4000]) {
      t += dt
      act(() => sim.tick()) // queued → precheck → apply → reboot (dell-02 goes down)
    }
    await waitFor(() => expect(mistral()).toBe(false))
  })
})
