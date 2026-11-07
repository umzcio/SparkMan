import { describe, expect, it } from 'vitest'
import { MockClient } from './mock-client'
import { SimError, Simulator } from './simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()
const make = () => {
  const sim = new Simulator({ now: () => START })
  return { sim, client: new MockClient(sim, { latencyMs: 0 }) }
}

describe('MockClient', () => {
  it('serves simulator reads', async () => {
    const { client } = make()
    expect(await client.listNodes()).toHaveLength(12)
    expect(await client.getNode('missing')).toBeNull()
    expect((await client.listCatalog()).length).toBeGreaterThan(5)
    expect((await client.getFleetConfig()).hosts).toHaveLength(12)
  })
  it('round-trips mutations', async () => {
    const { client } = make()
    const { key } = await client.createKey({ name: 'e2e', rateLimitRpm: 60 })
    expect((await client.listKeys()).map((k) => k.id)).toContain(key.id)
  })
  it('rejects with SimError on invalid actions', async () => {
    const { client } = make()
    await expect(client.revokeKey('missing')).rejects.toBeInstanceOf(SimError)
  })
  it('simulated API failures reject reads but keep failure controls usable', async () => {
    const { client } = make()
    await client.setFailures({ apiErrors: true })
    await expect(client.listNodes()).rejects.toMatchObject({ code: 'unavailable' })
    expect((await client.getFailures()).apiErrors).toBe(true)
    await client.setFailures({ apiErrors: false })
    expect(await client.listNodes()).toHaveLength(12)
  })

  it('forwards simulator events to subscribers', () => {
    const { sim, client } = make()
    const seen: string[] = []
    const off = client.subscribe((e) => seen.push(e.type))
    sim.tick()
    off()
    sim.tick()
    expect(seen).toEqual(['tick'])
  })

  it('serves cooling through the client', async () => {
    const { client } = make()
    await client.setFanOverride('fan-1', 60)
    expect((await client.getCooling()).fans[0]).toMatchObject({ mode: 'manual', duty: 60 })
    await expect(client.setCoolingPolicy({ minDuty: 200 })).rejects.toThrow(/Minimum/)
  })
})
