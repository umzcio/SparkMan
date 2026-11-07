import { describe, expect, it } from 'vitest'
import type { SimEvent } from '../types'
import { DEPLOY_LOADING_MS, DEPLOY_PENDING_MS, REBOOT_MS, SimError, Simulator } from './simulator'

const START = new Date(2026, 9, 8, 15, 0, 0).getTime()

function setup() {
  let t = START
  const sim = new Simulator({ seed: 1729, now: () => t })
  const advance = (ms: number) => {
    const end = t + ms
    while (t < end) {
      t = Math.min(end, t + 2000)
      sim.tick()
    }
  }
  return { sim, advance }
}

const expectSimError = (fn: () => unknown, code: SimError['code']) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SimError)
    expect((e as SimError).code).toBe(code)
    return
  }
  throw new Error(`expected SimError(${code})`)
}

describe('Simulator', () => {
  it('starts with 12 nodes, spark-05 degraded, all reachable', () => {
    const { sim } = setup()
    const nodes = sim.getNodes()
    expect(nodes).toHaveLength(12)
    expect(nodes.find((n) => n.id === 'spark-05')!.status).toBe('degraded')
    expect(nodes.filter((n) => n.status === 'online')).toHaveLength(11)
    expect(nodes.every((n) => n.live !== null)).toBe(true)
    expect(sim.getFleetSummary()).toMatchObject({ online: 12, total: 12, memTotalGB: 1536, activeIncidents: 1 })
    expect(sim.getNode('nope')).toBeNull()
  })

  it('returns copies, not live references', () => {
    const { sim } = setup()
    sim.getKeys()[0].name = 'mutated'
    expect(sim.getKeys()[0].name).not.toBe('mutated')
  })

  it('reboot: rebooting → online, deployment degraded → loading → serving', () => {
    const { sim, advance } = setup()
    sim.rebootNode('spark-03')
    expect(sim.getNode('spark-03')!.status).toBe('rebooting')
    expect(sim.getNode('spark-03')!.live).toBeNull()
    expect(sim.getMetrics('spark-03', '15m').at(-1)!.gpuUtil).toBeNull()
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('degraded')
    expectSimError(() => sim.rebootNode('spark-03'), 'conflict')
    advance(REBOOT_MS)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('loading')
    advance(DEPLOY_LOADING_MS)
    expect(sim.getDeployments().find((d) => d.id === 'dep-gptoss120')!.status).toBe('serving')
    expectSimError(() => sim.rebootNode('nope'), 'not_found')
  })

  it('offline node yields null metrics and null live stats', () => {
    const { sim, advance } = setup()
    sim.setFailures({ nodeOffline: 'spark-03' })
    advance(4000)
    const node = sim.getNode('spark-03')!
    expect(node.status).toBe('offline')
    expect(node.live).toBeNull()
    expect(sim.getMetrics('spark-03', '15m').at(-1)!.gpuUtil).toBeNull()
    expect(sim.getIncidents().some((i) => i.status === 'ongoing' && i.title.includes('spark-03'))).toBe(true)
    expect(sim.getFleetSummary().online).toBe(11)
    sim.setFailures({ nodeOffline: null })
    advance(2000)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    expect(sim.getIncidents().filter((i) => i.title.includes('spark-03')).every((i) => i.status === 'resolved')).toBe(true)
  })

  it('deployments: conflicts, validation and lifecycle', () => {
    const { sim, advance } = setup()
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: ['dell-02'] }), 'conflict')
    sim.stopDeployment('dep-mistral24')
    expect(sim.getDeployments().some((d) => d.id === 'dep-mistral24')).toBe(false)
    expect(sim.getNode('dell-02')!.deploymentId).toBeNull()
    expectSimError(() => sim.createDeployment({ catalogId: 'deepseek-v3.1', engine: 'SGLang', nodeIds: ['dell-02'] }), 'invalid')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'NIM', nodeIds: ['dell-02'] }), 'invalid')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: [] }), 'invalid')
    const dep = sim.createDeployment({ catalogId: 'gpt-oss-20b', engine: 'vLLM', nodeIds: ['dell-02'] })
    expect(dep.status).toBe('pending')
    expect(sim.getNode('dell-02')!.deploymentId).toBe(dep.id)
    advance(DEPLOY_PENDING_MS)
    expect(sim.getDeployments().find((d) => d.id === dep.id)!.status).toBe('loading')
    advance(DEPLOY_LOADING_MS)
    expect(sim.getDeployments().find((d) => d.id === dep.id)!.status).toBe('serving')
    expect(sim.getGatewayInfo().models).toContain('gpt-oss-20b')
  })

  it('multi-node deployments require vLLM or SGLang', () => {
    const { sim } = setup()
    sim.stopDeployment('dep-qwen235')
    expectSimError(() => sim.createDeployment({ catalogId: 'gpt-oss-120b', engine: 'Ollama', nodeIds: ['spark-01', 'spark-02'] }), 'invalid')
    const dep = sim.createDeployment({ catalogId: 'qwen3-235b-a22b', engine: 'vLLM', nodeIds: ['spark-01', 'spark-02'] })
    expect(sim.getNode('spark-01')!.groupId).toBe(dep.replicas[0].id)
  })

  it('keys: create reveals secret once, revoke is one-way', () => {
    const { sim } = setup()
    const { key, secret } = sim.createKey({ name: 'playwright', rateLimitRpm: 60 })
    expect(secret).toMatch(/^sk-spark-[A-Za-z0-9]{32}$/)
    expect(key.prefix).toBe(secret.slice(0, 13))
    expect(JSON.stringify(sim.getKeys())).not.toContain(secret)
    expectSimError(() => sim.createKey({ name: '  ', rateLimitRpm: 60 }), 'invalid')
    expectSimError(() => sim.createKey({ name: 'playwright', rateLimitRpm: 60 }), 'conflict')
    sim.revokeKey(key.id)
    expect(sim.getKeys().find((k) => k.id === key.id)!.revokedAt).not.toBeNull()
    expectSimError(() => sim.revokeKey(key.id), 'conflict')
  })

  it('rejects a second active rollout; a canary rollout completes and updates the node', () => {
    const { sim, advance } = setup()
    const r = sim.startRollout({ targetOs: '7.5.0', rings: ['canary'], window: 'Now', requireApproval: true })
    expect(r.status).toBe('awaiting-approval')
    expectSimError(() => sim.startRollout({ targetOs: '7.5.0', rings: ['ring1'], window: 'Now', requireApproval: false }), 'conflict')
    sim.approveRollout(r.id)
    expectSimError(() => sim.approveRollout(r.id), 'conflict')
    advance(2000)
    expect(sim.getRollouts().find((x) => x.id === r.id)!.nodes[0].step).toBe('precheck')
    advance(18_000)
    const done = sim.getRollouts().find((x) => x.id === r.id)!
    expect(done.status).toBe('completed')
    expect(sim.getNode('dell-02')!.os.dgxOs).toBe('7.5.0')
    const upd = sim.getUpdates().find((u) => u.nodeId === 'dell-02')!
    expect(upd.aptPending).toEqual([])
    expect(upd.rebootRequired).toBe(false)
    expect(sim.getRollouts().length).toBe(3)
  })

  it('cancelRollout rejects an awaiting rollout so a new one can start; running ones conflict', () => {
    const { sim } = setup()
    const r = sim.startRollout({ targetOs: '7.5.0', rings: ['canary'], window: 'Now', requireApproval: true })
    const events: SimEvent[] = []
    sim.subscribe((e) => events.push(e))
    sim.cancelRollout(r.id)
    const rejected = sim.getRollouts().find((x) => x.id === r.id)!
    expect(rejected.status).toBe('failed')
    expect(rejected.finishedAt).toBe(START)
    expect(events).toContainEqual({ type: 'changed', topic: 'rollouts' })
    expect(sim.getActivity(1)[0].text).toBe(`Rollout ${r.name} rejected`)
    expectSimError(() => sim.cancelRollout(r.id), 'conflict')
    const next = sim.startRollout({ targetOs: '7.5.0', rings: ['canary'], window: 'Now', requireApproval: false })
    expect(next.status).toBe('running')
    expectSimError(() => sim.cancelRollout(next.id), 'conflict')
    expectSimError(() => sim.cancelRollout('nope'), 'not_found')
  })

  it('collectBundle returns an L2 diag envelope and rejects unknown or unreachable nodes', () => {
    const { sim } = setup()
    const env = sim.collectBundle('spark-02')
    expect(env.tool).toBe('spark_diagctl.py')
    expect(env.summary).toMatchObject({ level: 'L2' })
    expect(env.artifacts[0]).toMatch(/-L2\.tar\.zst$/)
    expect(sim.getActivity(1)[0]).toMatchObject({ kind: 'diag', nodeId: 'spark-02' })
    expectSimError(() => sim.collectBundle('nope'), 'not_found')
    sim.rebootNode('spark-02')
    expectSimError(() => sim.collectBundle('spark-02'), 'conflict')
  })

  it('emits tick and changed events', () => {
    const { sim, advance } = setup()
    const events: SimEvent[] = []
    const off = sim.subscribe((e) => events.push(e))
    sim.setRuleEnabled('rule-update', true)
    advance(2000)
    off()
    advance(2000)
    expect(events).toContainEqual({ type: 'changed', topic: 'rules' })
    expect(events.filter((e) => e.type === 'tick')).toHaveLength(1)
    expect(sim.getRules().find((r) => r.id === 'rule-update')!.enabled).toBe(true)
  })

  it('resolving the thermal incident clears the degraded state', () => {
    const { sim } = setup()
    sim.resolveIncident('inc-thermal-05')
    expect(sim.getNode('spark-05')!.status).toBe('online')
    expect(sim.getFleetSummary().activeIncidents).toBe(0)
    expectSimError(() => sim.resolveIncident('inc-thermal-05'), 'conflict')
  })

  it('queryLogs returns bounded newest-first lines, histogram and bands', () => {
    const { sim } = setup()
    const r = sim.queryLogs({ query: '', range: '24h', limit: 100 })
    expect(r.lines).toHaveLength(100)
    expect(r.histogram).toHaveLength(60)
    expect(r.total).toBeGreaterThan(100)
    expect(r.bands.some((b) => b.label.includes('thermal'))).toBe(true)
    const around = sim.queryLogs({ query: '', range: '1h', around: START - 30_000 })
    expect(around.to).toBe(START)
    expect(around.from).toBe(START - 90_000)
  })

  it('failure injection: gateway errors and xid storm', () => {
    const { sim, advance } = setup()
    sim.setFailures({ gatewayErrors: true, xidStorm: true })
    advance(30_000)
    expect(sim.getGatewaySeries('15m').at(-1)!.errorRate).toBeGreaterThan(0.04)
    const xid = sim.queryLogs({ query: 'host:gx10-03 level:error', range: '15m' })
    expect(xid.lines.some((l) => l.message.includes('NVRM: Xid'))).toBe(true)
    expect(sim.getFailures()).toEqual({ nodeOffline: null, gatewayErrors: true, xidStorm: true, apiErrors: false, picoDisconnected: false, fanStalled: null })
    sim.setFailures({ gatewayErrors: false, xidStorm: false })
    expect(sim.getIncidents().filter((i) => i.status === 'ongoing')).toHaveLength(1)
  })

  it('injected 5xx: resolving its incident clears the failure; re-inject and toggle off cleanly', () => {
    const { sim, advance } = setup()
    const events: SimEvent[] = []
    sim.subscribe((e) => events.push(e))
    sim.setFailures({ gatewayErrors: true })
    const first = sim.getIncidents().find((i) => i.status === 'ongoing' && i.ruleId === 'rule-5xx')!
    events.length = 0
    sim.resolveIncident(first.id)
    expect(sim.getFailures().gatewayErrors).toBe(false)
    expect(events).toContainEqual({ type: 'changed', topic: 'failures' })
    advance(2000)
    sim.setFailures({ gatewayErrors: true })
    expect(sim.getFailures().gatewayErrors).toBe(true)
    expect(() => sim.setFailures({ gatewayErrors: false })).not.toThrow()
    expect(sim.getFailures().gatewayErrors).toBe(false)
    const injected = sim.getIncidents().filter((i) => i.id.startsWith('inj-'))
    expect(injected).toHaveLength(2)
    expect(new Set(injected.map((i) => i.id)).size).toBe(2)
    expect(injected.every((i) => i.status === 'resolved')).toBe(true)
  })

  it('injected offline node: resolve from alerts, re-select the same node, toggle off', () => {
    const { sim, advance } = setup()
    sim.setFailures({ nodeOffline: 'spark-03' })
    advance(2000)
    const first = sim.getIncidents().find((i) => i.status === 'ongoing' && i.nodeId === 'spark-03')!
    sim.resolveIncident(first.id)
    expect(sim.getFailures().nodeOffline).toBeNull()
    advance(2000)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    sim.setFailures({ nodeOffline: 'spark-03' })
    advance(2000)
    expect(sim.getFailures().nodeOffline).toBe('spark-03')
    expect(sim.getNode('spark-03')!.status).toBe('offline')
    expect(() => sim.setFailures({ nodeOffline: null })).not.toThrow()
    advance(2000)
    expect(sim.getNode('spark-03')!.status).toBe('online')
    const injected = sim.getIncidents().filter((i) => i.id.startsWith('inj-'))
    expect(injected).toHaveLength(2)
    expect(new Set(injected.map((i) => i.id)).size).toBe(2)
    expect(injected.every((i) => i.status === 'resolved')).toBe(true)
  })

  it('setFailures with an unknown offline node changes nothing', () => {
    const { sim } = setup()
    sim.setFailures({ nodeOffline: 'spark-03' })
    const before = { failures: sim.getFailures(), incidents: sim.getIncidents() }
    expectSimError(() => sim.setFailures({ nodeOffline: 'nope' }), 'not_found')
    expect(sim.getFailures()).toEqual(before.failures)
    expect(sim.getIncidents()).toEqual(before.incidents)
  })

  it('health, inventory and processes use the Spark envelope', () => {
    const { sim } = setup()
    const h = sim.getHealth('spark-05')
    expect(h.envelope.tool).toBe('spark_diagctl.py')
    expect(h.envelope.status).toBe('warn')
    expect(h.checks.find((c) => c.name === 'GPU temperature')!.status).not.toBe('pass')
    expect(sim.getInventory('spark-01').envelope.tool).toBe('firmware_reporter.py')
    expect(sim.getProcesses('spark-01')[0].engine).toBe('vLLM')
    expect(sim.runDiagnostics('spark-02').tool).toBe('spark_diagctl.py')
    expect(sim.getUpdates()[0].envelope.tool).toBe('spark_updatectl.py')
  })

  it('throughput excludes replicas on unreachable nodes', () => {
    const { sim, advance } = setup()
    const before = sim.getFleetSummary().tokensPerSec
    sim.setFailures({ nodeOffline: 'dell-01' })
    advance(2000)
    const after = sim.getFleetSummary().tokensPerSec
    expect(after).toBeLessThan(before)
    expect(sim.getGatewaySeries('15m').at(-1)!.tokensPerSec).toBe(after)
    sim.setFailures({ nodeOffline: 'spark-03' })
    advance(2000)
    expect(sim.getUsage('15m').models).toContain('gpt-oss-120b')
  })

  describe('cooling', () => {
    it('starts with an hour of fan history and three auto fans', () => {
      const { sim } = setup()
      const c = sim.getCooling()
      expect(c.fans).toHaveLength(3)
      expect(c.fans.every((f) => f.mode === 'auto' && f.duty >= 20 && f.rpm > 0)).toBe(true)
      expect(sim.getCoolingSeries('1h').length).toBeGreaterThan(100)
    })

    it('slow fans let the zone run hotter than full fans', () => {
      const a = setup()
      a.sim.setFanOverride('fan-2', 20)
      a.advance(120_000)
      const b = setup()
      b.sim.setFanOverride('fan-2', 100)
      b.advance(120_000)
      const temp = (s: typeof a) => s.sim.getNode('spark-02')!.live!.gpuTempC
      expect(temp(a) - temp(b)).toBeGreaterThan(3)
      // shelf 2 is not fan-cooled
      expect(a.sim.getNode('spark-06')!.live!.gpuTempC).toBeCloseTo(b.sim.getNode('spark-06')!.live!.gpuTempC, 5)
    })

    it('runs a zone fan safe when one of its boxes goes offline', () => {
      const { sim, advance } = setup()
      sim.setFailures({ nodeOffline: 'spark-03' })
      advance(4000)
      expect(sim.getCooling().fans.find((f) => f.id === 'fan-2')).toMatchObject({ duty: 100, reason: { kind: 'no-data', nodeId: 'spark-03' } })
    })

    it('Pico disconnect opens an incident, fails safe after the watchdog, and resolving the incident reconnects', () => {
      const { sim, advance } = setup()
      sim.setFailures({ picoDisconnected: true })
      const inc = sim.getIncidents().find((i) => i.title === 'Cooling controller offline' && i.status === 'ongoing')!
      expect(inc).toMatchObject({ severity: 'critical', ruleId: 'rule-cooling-link', nodeId: null })
      advance(12_000)
      expect(sim.getCooling().controller).toMatchObject({ connected: false, failsafe: true })
      expect(sim.getCooling().fans.every((f) => f.duty === 100)).toBe(true)
      sim.resolveIncident(inc.id)
      expect(sim.getFailures().picoDisconnected).toBe(false)
      advance(2000)
      expect(sim.getCooling().controller).toMatchObject({ connected: true, failsafe: false })
    })

    it('a stalled fan opens an incident and clears with the failure', () => {
      const { sim, advance } = setup()
      sim.setFailures({ fanStalled: 'fan-3' })
      expect(sim.getIncidents().some((i) => i.title === 'Fan 3 stalled' && i.status === 'ongoing')).toBe(true)
      advance(10_000)
      expect(sim.getCooling().fans.find((f) => f.id === 'fan-3')).toMatchObject({ rpm: 0, stalled: true })
      sim.setFailures({ fanStalled: null })
      expect(sim.getIncidents().some((i) => i.title === 'Fan 3 stalled' && i.status === 'ongoing')).toBe(false)
      expectSimError(() => sim.setFailures({ fanStalled: 'fan-9' }), 'not_found')
    })

    it('validates overrides, policies and zones', () => {
      const { sim } = setup()
      expectSimError(() => sim.setFanOverride('fan-9', 50), 'not_found')
      expectSimError(() => sim.setFanOverride('fan-1', 120), 'invalid')
      expectSimError(() => sim.setCoolingPolicy({ curve: [{ tempC: 50, duty: 30 }, { tempC: 50, duty: 60 }] }), 'invalid')
      expect(sim.getCooling().policy.curve).toHaveLength(4) // unchanged
      expectSimError(() => sim.setFanZones({ 'fan-1': ['spark-05'], 'fan-2': [], 'fan-3': [] }), 'invalid')
      expectSimError(() => sim.setFanZones({ 'fan-1': ['spark-01'], 'fan-2': ['spark-01'], 'fan-3': [] }), 'invalid')
      expectSimError(() => sim.setFanZones({ 'fan-1': [], 'fan-2': [] }), 'invalid')
      sim.setFanZones({ 'fan-1': ['gx10-01', 'spark-01', 'spark-02'], 'fan-2': ['spark-03', 'spark-04'], 'fan-3': ['dell-01', 'dell-02'] })
      expect(sim.getCooling().fans[0].nodeIds).toEqual(['gx10-01', 'spark-01', 'spark-02'])
    })

    it('rejects overrides while the Pico is not answering', () => {
      const { sim } = setup()
      sim.setFailures({ picoDisconnected: true })
      expectSimError(() => sim.setFanOverride('fan-1', 50), 'unavailable')
      expectSimError(() => sim.setFanOverride('fan-1', null), 'unavailable')
    })

    it('applies zone edits at once, not on the next tick', () => {
      const { sim } = setup()
      sim.setFanZones({ 'fan-1': ['gx10-01', 'spark-01'], 'fan-2': ['spark-04'], 'fan-3': ['spark-02', 'spark-03', 'dell-01', 'dell-02'] })
      expect(sim.getCooling().fans[1].reason.nodeId).toBe('spark-04')
    })

    it('logs changes and emits cooling events', () => {
      const { sim } = setup()
      const events: SimEvent[] = []
      sim.subscribe((e) => events.push(e))
      sim.setFanOverride('fan-2', 40)
      expect(sim.getActivity(1)[0].text).toBe('Fan 2 pinned to 40%')
      sim.setFanOverride('fan-2', null)
      expect(sim.getActivity(1)[0].text).toBe('Fan 2 back to auto')
      sim.setCoolingPolicy({ minDuty: 25 })
      expect(sim.getActivity(1)[0].text).toBe('Fan curve updated')
      expect(events).toContainEqual({ type: 'changed', topic: 'cooling' })
    })
  })
})
