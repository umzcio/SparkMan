import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ClientProvider, type SparkManClient } from '@/api/client'
import type { Fan } from '@/api/types'
import { FanCard } from './fan-card'

afterEach(cleanup)

beforeAll(() => {
  // radix measures the slider; jsdom has no ResizeObserver
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const FAN: Fan = { id: 'fan-2', name: 'Fan 2', nodeIds: ['spark-02'], duty: 40, rpm: 600, mode: 'auto', manualDuty: null, reason: { kind: 'temp', nodeId: 'spark-02', value: 60 }, stalled: false }

function renderCard(client: Partial<SparkManClient>, props: { disabled?: boolean } = {}) {
  const qc = new QueryClient()
  const wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <ClientProvider client={client as SparkManClient}>{children}</ClientProvider>
    </QueryClientProvider>
  )
  render(<FanCard fan={FAN} maxRpm={1500} {...props} />, { wrapper: wrap })
  return screen.getByRole('slider', { name: 'Fan 2 speed' })
}

describe('FanCard slider', () => {
  it('sends one override for a burst of key presses', async () => {
    const setFanOverride = vi.fn(() => Promise.resolve())
    const thumb = renderCard({ setFanOverride })
    for (let i = 0; i < 4; i++) fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    await waitFor(() => expect(setFanOverride).toHaveBeenCalledTimes(1))
    expect(setFanOverride).toHaveBeenCalledWith('fan-2', 60)
  })

  it('snaps back when the override fails', async () => {
    const setFanOverride = vi.fn(() => Promise.reject(new Error('Simulated API failure')))
    const thumb = renderCard({ setFanOverride })
    fireEvent.keyDown(thumb, { key: 'ArrowRight' })
    expect(thumb).toHaveAttribute('aria-valuenow', '45')
    await waitFor(() => expect(setFanOverride).toHaveBeenCalled())
    await waitFor(() => expect(thumb).toHaveAttribute('aria-valuenow', '40'))
  })

  it('locks while the Pico is not answering', () => {
    const thumb = renderCard({}, { disabled: true })
    expect(thumb).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('fan-auto')).toBeDisabled()
  })
})
