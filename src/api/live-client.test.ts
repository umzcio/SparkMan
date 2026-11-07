import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from './live-client'
import { MockClient } from './mock/mock-client'
import { Simulator } from './mock/simulator'
import { NullClient } from './null-client'

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

function client() {
  const mock = new MockClient(new Simulator(), { latencyMs: 0 })
  return { live: new LiveClient(mock, new Set(['nodes'])), mock }
}

describe('LiveClient', () => {
  it('reads nodes from the host', async () => {
    const fetchMock = vi.fn(async () => respond(200, [{ id: 'spark-01' }]))
    vi.stubGlobal('fetch', fetchMock)
    const { live } = client()
    expect(await live.listNodes()).toEqual([{ id: 'spark-01' }])
    expect(fetchMock).toHaveBeenCalledWith('/api/fleet/nodes', expect.objectContaining({ method: 'GET' }))
  })

  it('resolves getNode to null on 404 and rejects with the server message otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/gone') ? respond(404, { error: 'Node not found' }) : respond(409, { error: 'spark-01 is offline' }))))
    const { live } = client()
    expect(await live.getNode('gone')).toBeNull()
    await expect(live.rebootNode('spark-01')).rejects.toThrow('spark-01 is offline')
  })

  it('sends drain as JSON', async () => {
    const fetchMock = vi.fn(async () => respond(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await client().live.setNodeDrained('spark-01', true)
    expect(fetchMock).toHaveBeenCalledWith('/api/fleet/nodes/spark-01/drain', expect.objectContaining({ method: 'POST', body: '{"drained":true}' }))
  })

  it('delegates areas that are not live to the fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500, { error: 'should not be called' })))
    const { live, mock } = client()
    expect(await live.listCatalog()).toEqual(await mock.listCatalog())
    const blank = new LiveClient(new NullClient(), new Set(['nodes']))
    expect(await blank.listIncidents()).toEqual([])
    await expect(blank.createKey({ name: 'x', rateLimitRpm: 60 })).rejects.toThrow("isn't connected yet")
  })

  it('uses the fallback for a method whose area is not live, even if implemented', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(500, { error: 'should not be called' })))
    const off = new LiveClient(new NullClient(), new Set())
    expect(await off.listNodes()).toEqual([])
  })
})
