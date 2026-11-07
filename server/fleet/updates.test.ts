// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { NodeModel, UpdateRing } from '../../src/api/types.ts'
import { FleetDb } from './db.ts'
import { parseAptPending, parseFwupdUpdates, UpdateManager, type UpdateHost } from './updates.ts'

describe('parsing', () => {
  it('reads apt installs and held-back packages', () => {
    const apt = [
      'The following packages have been kept back:',
      '  linux-image-nvidia linux-headers-nvidia',
      'Inst dgx-dashboard [0.23.3] (0.29.2-2 NVIDIA Spark Updates Repository:noble-updates [arm64])',
      'Inst python3-pip [24.0] (24.0+esm3 Ubuntu:24.04/noble-apps-security [all])',
      '2 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.',
    ].join('\n')
    expect(parseAptPending(apt)).toEqual([
      'linux-image-nvidia (held back)', 'linux-headers-nvidia (held back)', 'dgx-dashboard 0.23.3 → 0.29.2-2', 'python3-pip 24.0 → 24.0+esm3',
    ])
  })
  it('reads fwupd devices with a newer release', () => {
    expect(parseFwupdUpdates('{"Devices":[{"Name":"UEFI","Version":"1.0","Releases":[{"Version":"1.2"}]},{"Name":"TPM","Version":"7"}]}')).toEqual([
      { component: 'UEFI', current: '1.0', available: '1.2' },
    ])
    expect(parseFwupdUpdates('{"Devices":[]}')).toEqual([])
    expect(parseFwupdUpdates('not json')).toEqual([])
  })
})

function fakeHost(opts: { failHealthOn?: string; launcher?: { nodeIds: string[]; state?: string; comesBack?: boolean }; needsReboot?: boolean } = {}) {
  const nodes: { id: string; model: NodeModel; dgxOs: string; ring: UpdateRing; status: string; maintenance?: boolean; busy?: string }[] = [
    { id: 'spark-01', model: 'DGX Spark FE', dgxOs: '7.2.3', ring: 'canary', status: 'online' },
    { id: 'spark-02', model: 'Dell Pro Max GB10', dgxOs: '7.2.3', ring: 'ring1', status: 'online' },
    { id: 'spark-03', model: 'ASUS GX10', dgxOs: '7.2.3', ring: 'ring2', status: 'online' },
  ]
  const calls: string[] = []
  let rebooted = false
  const applied = new Set<string>()
  // one launcher: stops at once, takes one poll to answer again after a start
  const l = opts.launcher && { id: 'ln-1', name: 'Qwen', nodeIds: opts.launcher.nodeIds, state: opts.launcher.state ?? 'serving' }
  if (l) for (const n of nodes) if (l.nodeIds.includes(n.id)) n.busy = l.name
  const host: UpdateHost = {
    nodes: () => nodes,
    tool: vi.fn(async (id: string, _script: string, args: string[]) => {
      calls.push(`${id} ${args.join(' ')}`)
      if (args[0] === 'status') return { out: { ok: true, data: { pending_reboot: { pending: opts.needsReboot === true && !rebooted } }, errors: [] }, rc: 0, ms: 1 }
      if (args[1] === 'now') applied.add(id)
      // a real apply clears what was pending
      return { out: { ok: true, data: { apt_output: applied.has(id) ? '' : 'Inst foo [1] (2 x)' }, errors: [] }, rc: 0, ms: 1 }
    }),
    sh: vi.fn(async () => ({ code: 0, stdout: '{"Devices":[]}' })),
    health: vi.fn(async (id: string) => ({
      envelope: { tool: 't', ts: '', host: id, status: id === opts.failHealthOn ? ('error' as const) : ('ok' as const), rc: 0, duration_ms: 0, summary: {}, warnings: id === opts.failHealthOn ? ['GPU visible: fail'] : [], artifacts: [] },
    })),
    reboot: vi.fn(async () => {
      rebooted = true
    }),
    setOs: vi.fn(),
    launcherOn: (nodeId) => (l && l.nodeIds.includes(nodeId) ? l : undefined),
    launcherState: () => {
      if (l?.state === 'starting') {
        l.state = opts.launcher?.comesBack === false ? 'failed' : 'serving'
        return 'starting'
      }
      return l?.state ?? null
    },
    stopLauncher: vi.fn(async () => {
      calls.push('stop Qwen')
      l!.state = 'idle'
    }),
    startLauncher: vi.fn(async () => {
      calls.push('start Qwen')
      l!.state = 'starting'
    }),
    activity: vi.fn(),
    changed: vi.fn(),
  }
  return { host, calls }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
}

describe('UpdateManager', () => {
  it('records a check per node', async () => {
    const { host } = fakeHost()
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    await m.check('spark-02')
    const s = m.list().find((u) => u.nodeId === 'spark-02')!
    expect(s.aptPending).toEqual(['foo 1 → 2'])
    expect(s.targetOs).toBe('latest packages')
    expect(m.list().find((u) => u.nodeId === 'spark-01')!.lastChecked).toBe(0)
  })

  it('runs a dry run ring by ring after approval, never applying or rebooting', async () => {
    const { host, calls } = fakeHost()
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    const r = m.startRollout({ targetOs: '', rings: ['ring2', 'canary', 'ring1'], window: 'Now', requireApproval: true })
    expect(r.status).toBe('awaiting-approval')
    expect(r.rings).toEqual(['canary', 'ring1', 'ring2'])
    expect(() => m.startRollout({ targetOs: '', rings: ['canary'], window: 'Now', requireApproval: false })).toThrow('already')
    m.approve(r.id)
    await settle()
    const done = m.rollouts()[0]
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => n.step)).toEqual(['done', 'done', 'done'])
    expect(calls.filter((c) => c.includes('update now'))).toEqual([])
    expect(host.reboot).not.toHaveBeenCalled()
    expect(calls.map((c) => c.split(' ')[0])).toEqual(expect.arrayContaining(['spark-01', 'spark-02', 'spark-03']))
  })

  it('stops at the first failing node and leaves later rings queued', async () => {
    const { host } = fakeHost({ failHealthOn: 'spark-02' })
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    m.startRollout({ targetOs: '', rings: ['canary', 'ring1', 'ring2'], window: 'Now', requireApproval: false })
    await settle()
    const r = m.rollouts()[0]
    expect(r.status).toBe('failed')
    expect(r.nodes.map((n) => n.step)).toEqual(['done', 'failed', 'queued'])
  })

  it('skips nodes in maintenance or held by a running launcher', () => {
    const { host } = fakeHost()
    const nodes = host.nodes()
    Object.assign(nodes[0], { busy: 'GLM ring' })
    Object.assign(nodes[1], { maintenance: true })
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    const r = m.startRollout({ targetOs: '', rings: ['canary', 'ring1', 'ring2'], window: 'Now', requireApproval: true })
    expect(r.nodes.map((n) => n.nodeId)).toEqual(['spark-03'])
    m.cancel(r.id)
    Object.assign(nodes[2], { busy: 'GLM ring' })
    expect(() => m.startRollout({ targetOs: '', rings: ['canary', 'ring1', 'ring2'], window: 'Now', requireApproval: true })).toThrow(/running a launcher/)
  })

  it('skips offline nodes instead of failing on them', () => {
    const { host } = fakeHost()
    Object.assign(host.nodes()[1], { status: 'offline' })
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: true })
    expect(m.startRollout({ targetOs: '', rings: ['canary', 'ring1'], window: 'Now', requireApproval: true }).nodes.map((n) => n.nodeId)).toEqual(['spark-01'])
  })

  it('rejects a rollout awaiting approval', () => {
    const { host } = fakeHost()
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    const r = m.startRollout({ targetOs: '', rings: ['canary'], window: 'Now', requireApproval: true })
    m.cancel(r.id)
    expect(m.rollouts()[0].status).toBe('failed')
    expect(() => m.cancel(r.id)).toThrow()
  })

  it('opens maintenance windows at the next 02:00 (tonight) or the next Sunday', () => {
    const { host } = fakeHost()
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
    const fri22 = new Date(2026, 9, 9, 22, 0, 0) // a Friday
    expect(m.windowDelay('Now', fri22)).toBe(0)
    expect(m.windowDelay('Tonight 02:00–04:00', fri22)).toBe(4 * 3_600_000)
    expect(m.windowDelay('Sunday 02:00–04:00', fri22)).toBe((24 + 4) * 3_600_000)
  })

  it('fails a rollout that was running when the server stopped', () => {
    const { host } = fakeHost()
    const db = new FleetDb(':memory:')
    const m = new UpdateManager(host, db, { apply: false })
    const r = m.startRollout({ targetOs: '', rings: ['canary'], window: 'Tonight 02:00–04:00', requireApproval: false })
    expect(r.status).toBe('running')
    const again = new UpdateManager(host, db, { apply: false })
    expect(again.rollouts()[0].status).toBe('failed')
  })

  it('reboots when an update asks for it, then checks again so the flag clears', async () => {
    const { host } = fakeHost({ needsReboot: true })
    const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: true })
    m.pollMs = 1
    m.rebootSettleMs = 1
    m.startRollout({ targetOs: '', rings: ['canary'], window: 'Now', requireApproval: false })
    await vi.waitFor(() => expect(m.rollouts()[0].status).toBe('completed'))
    expect(host.reboot).toHaveBeenCalledWith('spark-01')
    expect(m.list().find((u) => u.nodeId === 'spark-01')!.rebootRequired).toBe(false)
  })

  describe('with a model on some of the nodes', () => {
    const run = async (m: UpdateManager) => {
      m.pollMs = 1
      await vi.waitFor(() => expect(m.rollouts()[0].status).not.toBe('running'))
      return m.rollouts()[0]
    }
    const four = () => {
      const h = fakeHost({ launcher: { nodeIds: ['spark-04', 'spark-02'] } })
      ;(h.host.nodes() as { id: string; ring: UpdateRing }[]).push({ id: 'spark-04', model: 'DGX Spark FE', dgxOs: '7.2.3', ring: 'ring1', status: 'online' } as never)
      Object.assign(h.host.nodes()[3], { busy: 'Qwen' })
      return h
    }

    it('stops it before its first node, updates its nodes back to back, and starts it again after the last', async () => {
      const { host, calls } = four()
      const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: true })
      const r = m.startRollout({ targetOs: '', rings: ['canary', 'ring1', 'ring2'], window: 'Now', requireApproval: false, restartModels: true })
      expect(r.nodes.map((n) => [n.nodeId, n.launcher?.name])).toEqual([['spark-01', undefined], ['spark-02', 'Qwen'], ['spark-04', 'Qwen'], ['spark-03', undefined]])
      const done = await run(m)
      expect(done.status).toBe('completed')
      expect(calls.filter((c) => /Qwen|update now/.test(c))).toEqual([
        'spark-01 update now', 'stop Qwen', 'spark-02 update now', 'spark-04 update now', 'start Qwen', 'spark-03 update now',
      ])
      expect(done.nodes.every((n) => n.step === 'done')).toBe(true)
    })

    it('fails the rollout when the model does not come back, before later rings', async () => {
      const { host, calls } = fakeHost({ launcher: { nodeIds: ['spark-02'], comesBack: false } })
      const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: true })
      m.startRollout({ targetOs: '', rings: ['canary', 'ring1', 'ring2'], window: 'Now', requireApproval: false, restartModels: true })
      const r = await run(m)
      expect(r.status).toBe('failed')
      expect(r.nodes.map((n) => n.step)).toEqual(['done', 'failed', 'queued'])
      expect(calls).not.toContain('spark-03 update now')
      expect(host.activity).toHaveBeenCalledWith('update', expect.stringContaining("Qwen didn't come back"), 'spark-02')
    })

    it('only says what it would do in a dry run', async () => {
      const { host, calls } = fakeHost({ launcher: { nodeIds: ['spark-02'] } })
      const m = new UpdateManager(host, new FleetDb(':memory:'), { apply: false })
      m.startRollout({ targetOs: '', rings: ['ring1'], window: 'Now', requireApproval: false, restartModels: true })
      expect((await run(m)).status).toBe('completed')
      expect(calls.filter((c) => c.includes('Qwen'))).toEqual([])
      expect(host.activity).toHaveBeenCalledWith('update', 'Dry run: would stop Qwen', 'spark-02')
    })

    it('still skips a model that is not serving or reaches outside the rollout', () => {
      const starting = fakeHost({ launcher: { nodeIds: ['spark-02'], state: 'starting' } })
      const m1 = new UpdateManager(starting.host, new FleetDb(':memory:'), { apply: true })
      expect(m1.startRollout({ targetOs: '', rings: ['canary', 'ring1'], window: 'Now', requireApproval: true, restartModels: true }).nodes.map((n) => n.nodeId)).toEqual(['spark-01'])
      const spans = fakeHost({ launcher: { nodeIds: ['spark-02', 'spark-03'] } })
      const m2 = new UpdateManager(spans.host, new FleetDb(':memory:'), { apply: true })
      expect(m2.startRollout({ targetOs: '', rings: ['canary', 'ring1'], window: 'Now', requireApproval: true, restartModels: true }).nodes.map((n) => n.nodeId)).toEqual(['spark-01'])
    })
  })
})
