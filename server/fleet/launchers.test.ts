// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { GatewayDb } from '../gateway/store.ts'
import { FleetDb } from './db.ts'
import { DeploymentManager, type DeployHost } from './deployments.ts'
import type { LauncherInput } from '../../src/api/types.ts'
import { cleanLog, engineOf, LOAD_TIMEOUT_MS, validateLauncher } from './launchers.ts'

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
const RING: LauncherInput = { name: 'GLM ring', nodeIds: ['spark-01', 'spark-02', 'spark-03'], dir: '~/swap', startScript: 'up-glm.sh', stopScript: 'down-glm.sh', port: 8888, sudo: false, caps: ['tools'], maxOutput: null, notes: '' }

/** a head whose start script is alive/exited as the test says, and a port that answers when `serving` */
function setup() {
  let t = 1_000_000
  const proc = { alive: false, pid: false, exit: '' }
  let serving = false
  const nodes = ['spark-01', 'spark-02', 'spark-03', 'spark-04'].map((id, i) => ({ id, ip: `10.0.0.1${i + 1}`, status: 'online', drained: false, memoryGB: 128, memUsedGB: 4 }))
  const sh = vi.fn(async (_id: string, command: string, opts?: { input?: string }) => {
    const script = opts?.input ?? command
    if (script.includes('setsid')) {
      Object.assign(proc, { alive: true, pid: true, exit: '' })
      return { code: 0, stdout: 'started\n' }
    }
    if (script.includes('kill -TERM')) {
      Object.assign(proc, { alive: false, pid: false, exit: '' })
      serving = false
      return { code: 0, stdout: '0\n' }
    }
    if (script.includes('kill -0')) return { code: 0, stdout: `${proc.alive ? 1 : 0} ${proc.pid ? 'p' : '-'} ${proc.exit}\n` }
    if (script.startsWith('tail')) return { code: 0, stdout: '\x1b[32mINFO\x1b[0m loading\r 50%\r100%\nready\n' }
    return { code: 0, stdout: '' }
  })
  const host: DeployHost = {
    nodes: () => nodes,
    groups: () => [{ id: 'ring', nodeIds: ['spark-01', 'spark-02', 'spark-03'] }],
    sh,
    activity: vi.fn(),
    changed: vi.fn(),
  }
  const fetchMock = vi.fn(async (url: string) => {
    if (serving && url === 'http://10.0.0.11:8888/v1/models') return json({ data: [{ id: 'GLM-5.3-Flash', owned_by: 'tensorfold' }] })
    if (serving && url === 'http://10.0.0.11:8888/health') return json({ ok: true, context_length: 1048576 })
    throw new Error('ECONNREFUSED')
  })
  const gw = new GatewayDb(':memory:')
  const m = new DeploymentManager(host, new FleetDb(':memory:'), gw, { fetch: fetchMock as unknown as typeof fetch, now: () => t })
  return { m, gw, sh, proc, nodes, fetchMock, serve: (on: boolean) => (serving = on), advance: (ms: number) => (t += ms) }
}

describe('launchers', () => {
  it('validates what runs on the head', () => {
    const known = (id: string) => id.startsWith('spark-')
    expect(validateLauncher({ ...RING, dir: '~/swap/' }, known)).toMatchObject({ dir: '~/swap', nodeIds: RING.nodeIds })
    expect(() => validateLauncher({ ...RING, dir: '~/../etc' }, known)).toThrow(/Folder/)
    expect(() => validateLauncher({ ...RING, dir: 'swap' }, known)).toThrow(/Folder/)
    expect(() => validateLauncher({ ...RING, dir: '~/a;rm -rf' }, known)).toThrow(/Folder/)
    expect(() => validateLauncher({ ...RING, startScript: '../x.sh' }, known)).toThrow(/Start script/)
    expect(() => validateLauncher({ ...RING, startScript: 'x.sh; reboot' }, known)).toThrow(/Start script/)
    expect(() => validateLauncher({ ...RING, nodeIds: ['nope'] }, known)).toThrow(/Unknown node/)
    expect(() => validateLauncher({ ...RING, port: 0 }, known)).toThrow(/Port/)
    expect(() => validateLauncher({ ...RING, maxOutput: 1.5 }, known)).toThrow(/Max output/)
    expect(validateLauncher({ ...RING, maxOutput: 32768 }, known).maxOutput).toBe(32768)
    expect(() => validateLauncher({ ...RING, contextWindow: 0 }, known)).toThrow(/Context window/)
    expect(validateLauncher({ ...RING, contextWindow: 1048576 }, known).contextWindow).toBe(1048576)
    expect(validateLauncher(RING, known).contextWindow).toBeNull()
    expect(validateLauncher({ ...RING, stopScript: '  ' }, known).stopScript).toBeNull()
  })

  it('starts a ring detached, holds every node, and serves through the gateway once the port answers', async () => {
    const { m, gw, sh, serve } = setup()
    const l = m.launchers.create(RING)
    await m.startLauncher(l.id)
    const start = sh.mock.calls.find((c) => c[2]?.input?.includes('setsid'))!
    expect(start[0]).toBe('spark-01')
    expect(start[2]!.input).toContain(`D="$HOME"/'swap'`)
    expect(m.launchers.list()[0].state).toBe('starting')
    expect(m.nodeDeployment('spark-03')).toEqual({ deploymentId: l.id, groupId: `${l.id}-r0` })
    expect(m.nodeDeployment('spark-04').deploymentId).toBeNull()

    serve(true)
    await m.refresh()
    // TensorFold reports its window on /health, not /v1/models
    expect(m.launchers.list()[0]).toMatchObject({ state: 'serving', models: ['GLM-5.3-Flash'], engine: 'TensorFold', contextLength: 1048576 })
    expect(m.list().find((d) => d.launcherId === l.id)?.contextLength).toBe(1048576)
    const route = gw.routes().models['GLM-5.3-Flash']
    expect(route).toEqual([{ deploymentId: l.id, engine: 'TensorFold', baseUrl: 'http://10.0.0.11:8888/v1', nodeIds: RING.nodeIds, upstreamModel: 'GLM-5.3-Flash', contextLength: 1048576, maxOutput: null, caps: ['tools'], label: 'GLM ring' }])
    // discovery finds the same server on :8888; it's reported once, as the launcher
    expect(m.list().filter((d) => d.model === 'GLM-5.3-Flash')).toHaveLength(1)
    expect(m.list()[0]).toMatchObject({ launcherId: l.id, displayName: 'GLM ring', status: 'serving' })
  })

  it('falls back to the window you set when the engine reports none', async () => {
    const { m, gw, fetchMock, serve } = setup()
    // TensorFold's Zig engine: no max_model_len, no context_length on /health
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'http://10.0.0.11:8888/v1/models') return json({ data: [{ id: 'qwen3.8-flash-next', owned_by: 'tensorfold' }] })
      if (url === 'http://10.0.0.11:8888/health') return json({ status: 'ok', model: 'qwen3.8-flash-next' })
      throw new Error('ECONNREFUSED')
    })
    const l = m.launchers.create({ ...RING, contextWindow: 1048576 })
    await m.startLauncher(l.id)
    serve(true)
    await m.refresh()
    expect(m.launchers.list()[0]).toMatchObject({ state: 'serving', engine: 'TensorFold', contextLength: 1048576 })
    expect(gw.routes().models['qwen3.8-flash-next'][0].contextLength).toBe(1048576)
  })

  it('runs both scripts through sudo when asked', async () => {
    const { m, sh, serve } = setup()
    const l = m.launchers.create({ ...RING, sudo: true })
    await m.startLauncher(l.id)
    const start = sh.mock.calls.find((c) => c[2]?.input?.includes('setsid'))![2]!.input!
    expect(start).toContain("sudo -n true 2>/dev/null || { echo")
    expect(start).toContain(`sudo -n -H bash "./$2"`)
    serve(true)
    await m.refresh()
    await m.stopDeployment(l.id)
    await vi.waitFor(() => expect(m.launchers.list()[0].state).toBe('idle'))
    expect(sh.mock.calls.find((c) => c[2]?.input?.includes('kill -TERM'))![2]!.input).toContain("sudo -n -H timeout 900 bash ./'down-glm.sh'")
  })

  it('shares a node with Ollama, and the node shows the launcher', async () => {
    const { m, fetchMock } = setup()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === 'http://10.0.0.14:11434/api/tags') return json({ models: [{ name: 'nomic-embed-text:latest' }] })
      throw new Error('ECONNREFUSED')
    })
    await m.refresh()
    const l = m.launchers.create({ ...RING, name: 'solo', nodeIds: ['spark-04'] })
    await m.startLauncher(l.id)
    expect(m.nodeDeployment('spark-04').deploymentId).toBe(l.id)
  })

  it("won't start on nodes another deployment holds, or edit while running", async () => {
    const { m } = setup()
    const a = m.launchers.create(RING)
    const b = m.launchers.create({ ...RING, name: 'other', nodeIds: ['spark-03', 'spark-04'] })
    await m.startLauncher(a.id)
    await expect(m.startLauncher(b.id)).rejects.toThrow(/spark-03 is serving/)
    expect(() => m.launchers.update(a.id, { ...RING, port: 9000 })).toThrow(/Stop GLM ring before changing/)
    // describing the model is fine while it runs
    expect(m.launchers.update(a.id, { ...RING, caps: ['tools', 'thinking'], maxOutput: 32768 })).toMatchObject({ caps: ['tools', 'thinking'], maxOutput: 32768, state: 'starting' })
    expect(() => m.launchers.remove(a.id)).toThrow(/Stop GLM ring/)
  })

  it('stops with the stop script, then frees the nodes', async () => {
    const { m, sh, serve } = setup()
    const l = m.launchers.create(RING)
    await m.startLauncher(l.id)
    serve(true)
    await m.refresh()
    await m.stopDeployment(l.id)
    await vi.waitFor(() => expect(m.launchers.list()[0].state).toBe('idle'))
    const stop = sh.mock.calls.find((c) => c[2]?.input?.includes('kill -TERM'))![2]!.input!
    expect(stop).toContain("timeout 900 bash ./'down-glm.sh'")
    expect(m.nodeDeployment('spark-02').deploymentId).toBeNull()
    await m.refresh()
    expect(m.list()).toHaveLength(0)
  })

  it('fails when the start script exits non-zero, and goes down after missed probes', async () => {
    const { m, proc, serve } = setup()
    const l = m.launchers.create(RING)
    await m.startLauncher(l.id)
    Object.assign(proc, { alive: false, exit: '3' })
    await m.refresh()
    expect(m.launchers.list()[0]).toMatchObject({ state: 'failed', detail: 'up-glm.sh exited 3' })

    const k = m.launchers.create({ ...RING, name: 'k', nodeIds: ['spark-04'] })
    Object.assign(proc, { alive: true, pid: true, exit: '' })
    await m.launchers.stop(l.id)
    await vi.waitFor(() => expect(m.launchers.list().find((x) => x.id === l.id)!.state).toBe('idle'))
    await m.startLauncher(l.id)
    serve(true)
    await m.refresh()
    serve(false)
    for (let i = 0; i < 3; i++) await m.refresh()
    expect(m.launchers.list().find((x) => x.id === l.id)).toMatchObject({ state: 'down', detail: 'Not answering on :8888' })
    expect(k.state).toBe('idle')
  })

  it('gives a script that exits 0 an hour to answer', async () => {
    const { m, proc, advance } = setup()
    const l = m.launchers.create(RING)
    await m.startLauncher(l.id)
    Object.assign(proc, { alive: false, exit: '0' })
    await m.refresh()
    expect(m.launchers.list()[0].state).toBe('starting')
    advance(LOAD_TIMEOUT_MS + 1)
    await m.refresh()
    expect(m.launchers.list()[0]).toMatchObject({ state: 'failed', detail: 'No answer on :8888 after 60 min' })
  })

  it('reads the log with colours and progress redraws cleaned up', async () => {
    const { m } = setup()
    const l = m.launchers.create(RING)
    expect(await m.launchers.log(l.id)).toBe('100%\nready\n')
    expect(cleanLog('a\r\rb')).toBe('b')
    expect(engineOf('vllm')).toBe('vLLM')
    expect(engineOf('someone')).toBe('Script')
  })
})
