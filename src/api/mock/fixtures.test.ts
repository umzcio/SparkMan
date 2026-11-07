import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_SPECS, KEY_SPECS, MODEL_CATALOG, NODE_SPECS, RINGS } from './fixtures'

describe('fixtures', () => {
  it('defines 6 DGX Spark FE + 2 Dell Pro Max GB10 + 4 ASUS GX10 with unique ids and rack slots', () => {
    expect(NODE_SPECS).toHaveLength(12)
    expect(NODE_SPECS.filter((n) => n.model === 'DGX Spark FE')).toHaveLength(6)
    expect(NODE_SPECS.filter((n) => n.model === 'Dell Pro Max GB10')).toHaveLength(2)
    expect(new Set(NODE_SPECS.map((n) => `${n.rack.shelf}/${n.rack.slot}`)).size).toBe(12)
    expect(NODE_SPECS.filter((n) => n.model === 'ASUS GX10')).toHaveLength(4)
    expect(new Set(NODE_SPECS.map((n) => n.id)).size).toBe(12)
  })
  it('assigns every node to exactly one deployment replica', () => {
    const used = DEPLOYMENT_SPECS.flatMap((d) => d.replicas.flatMap((r) => r.nodeIds))
    expect(used.sort()).toEqual(NODE_SPECS.map((n) => n.id).sort())
  })
  it('has one 2-node group, one 4-node group and 6 single-node replicas', () => {
    const sizes = DEPLOYMENT_SPECS.flatMap((d) => d.replicas.map((r) => r.nodeIds.length)).sort()
    expect(sizes).toEqual([1, 1, 1, 1, 1, 1, 2, 4])
  })
  it('only multi-node-capable engines run multi-node replicas', () => {
    for (const d of DEPLOYMENT_SPECS) {
      if (d.replicas.some((r) => r.nodeIds.length > 1)) expect(['vLLM', 'SGLang']).toContain(d.engine)
    }
  })
  it('every deployment model exists in the catalog', () => {
    for (const d of DEPLOYMENT_SPECS) expect(MODEL_CATALOG.map((m) => m.id)).toContain(d.model)
  })
  it('rings cover all nodes once: canary 1, ring1 3, ring2 8', () => {
    expect(RINGS.canary).toHaveLength(1)
    expect(RINGS.ring1).toHaveLength(3)
    expect(RINGS.ring2).toHaveLength(8)
    expect([...RINGS.canary, ...RINGS.ring1, ...RINGS.ring2].sort()).toEqual(NODE_SPECS.map((n) => n.id).sort())
  })
  it('key traffic shares of active keys sum to 1', () => {
    const sum = KEY_SPECS.filter((k) => k.revokedAgoMs === null).reduce((s, k) => s + k.share, 0)
    expect(sum).toBeCloseTo(1, 5)
  })
})
