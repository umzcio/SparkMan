import { describe, expect, it } from 'vitest'
import type { Deployment, FleetNode } from '@/api/types'
import { benchTargets, resolveTarget, slowCopy, targetLabel, targetProblem, targetRunNode } from './targets'

const node = (id: string, status: FleetNode['status'] = 'online') => ({ id, status }) as FleetNode
const dep = (id: string, replicas: string[][], status: Deployment['status'] = 'serving') =>
  ({ id, model: id, status, replicas: replicas.map((nodeIds, i) => ({ id: `${id}-r${i}`, nodeIds })) }) as unknown as Deployment

describe('bench targets', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d', 'offline'), node('e')]
  const targets = benchTargets(nodes, [dep('tp', [['a', 'b']]), dep('multi', [['c'], ['d'], ['e']]), dep('gone', [['e']], 'stopped')])

  it('lists one target per copy (groups by their head) plus a gateway per multi-copy model', () => {
    expect(targets.map((t) => [t.key, targetLabel(t)])).toEqual([
      ['a', 'a + 1'],
      ['c', 'c'],
      ['d', 'd'],
      ['e', 'e'],
      ['gateway:multi', 'Gateway · 3 copies'],
    ])
    expect(targets.map(targetRunNode)).toEqual(['a', 'c', 'd', 'e', 'gateway'])
  })

  it('resolves a worker to its group and a gateway key to the gateway', () => {
    expect(resolveTarget(targets, 'b')?.key).toBe('a')
    expect(resolveTarget(targets, 'gateway:multi')?.scope).toBe('gateway')
    expect(resolveTarget(targets, 'zzz')).toBeUndefined()
  })

  it('blocks down copies and gateway quality runs', () => {
    const gw = resolveTarget(targets, 'gateway:multi')!
    expect(targetProblem(gw, 'decode')).toBe('d is offline')
    expect(targetProblem(resolveTarget(targets, 'a')!, 'quality')).toBeNull()
  })

  it('flags the copy well below the others', () => {
    const copies = [{ nodeIds: ['x'], v: 30 }, { nodeIds: ['y'], v: 31 }, { nodeIds: ['z'], v: 21 }]
    expect(slowCopy(copies, (c) => c.v)).toMatchObject({ copy: { nodeIds: ['z'] }, slowerPct: 31 })
    expect(slowCopy(copies.slice(0, 2), (c) => c.v)).toBeNull()
  })
})
