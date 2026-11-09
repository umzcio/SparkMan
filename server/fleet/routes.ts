import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { BenchKind, CreateDeploymentInput, GatewayInfo, LauncherInput, StartBenchInput, GatewayRoute, LogQueryInput, SimEvent, StartRolloutInput, TimeRange, UpdateRing } from '../../src/api/types.ts'
import { gatewaySeries, usageReport } from '../gateway/stats.ts'
import type { GatewayDb } from '../gateway/store.ts'
import { FleetError, type FleetService } from './service.ts'
import { CoolingError, type CoolingManager } from './cooling.ts'

/** :id of the matched route (always present on the routes below). */
const nid = (c: Context) => c.req.param('id') ?? ''

const RANGES = new Set<TimeRange>(['15m', '1h', '6h', '24h', '7d'])
const HEARTBEAT_MS = 15_000

function fail(c: Context, e: unknown) {
  if (e instanceof FleetError) return c.json({ error: e.message }, e.kind === 'not-found' ? 404 : e.kind === 'conflict' ? 409 : 502)
  console.error('[fleet]', e)
  return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
}

const wrap = (fn: (c: Context) => unknown) => async (c: Context) => {
  try {
    const v = await fn(c)
    return v instanceof Response ? v : c.json(v ?? { ok: true })
  } catch (e) {
    return fail(c, e)
  }
}

/** The live fleet API under /api/fleet (behind the app's auth middleware). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountFleet(app: Hono<any>, fleet: FleetService, gateway?: GatewayDb): void {
  const base = '/api/fleet'
  app.get(`${base}/health`, (c) => c.json({ ok: true, live: fleet.liveAreas() }))
  app.get(`${base}/nodes`, wrap(() => fleet.listNodes()))
  app.get(`${base}/nodes/:id`, wrap((c) => {
    const n = fleet.getNode(nid(c))
    return n ?? c.json({ error: 'Node not found' }, 404)
  }))
  app.get(`${base}/nodes/:id/metrics`, wrap((c) => {
    const range = (c.req.query('range') ?? '1h') as TimeRange
    if (!RANGES.has(range)) return c.json({ error: 'Unknown range' }, 400)
    return fleet.getNodeMetrics(nid(c), range)
  }))
  app.get(`${base}/nodes/:id/processes`, wrap((c) => fleet.getNodeProcesses(nid(c))))
  app.get(`${base}/nodes/:id/inventory`, wrap((c) => fleet.getNodeInventory(nid(c))))
  app.get(`${base}/nodes/:id/health`, wrap((c) => fleet.getNodeHealth(nid(c))))
  app.post(`${base}/nodes/:id/reboot`, wrap(async (c) => {
    await fleet.rebootNode(nid(c))
    return { ok: true }
  }))
  app.post(`${base}/nodes/:id/maintenance`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { maintenance?: unknown }
    if (typeof body.maintenance !== 'boolean') return c.json({ error: 'maintenance must be true or false' }, 400)
    fleet.setNodeMaintenance(nid(c), body.maintenance)
    return c.json({ ok: true })
  }))
  app.post(`${base}/nodes/:id/drain`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { drained?: unknown }
    if (typeof body.drained !== 'boolean') return c.json({ error: 'drained must be true or false' }, 400)
    fleet.setNodeDrained(nid(c), body.drained)
    return { ok: true }
  }))
  app.post(`${base}/nodes/:id/diagnostics`, wrap((c) => fleet.runDiagnostics(nid(c))))
  app.post(`${base}/nodes/:id/bundle`, wrap((c) => fleet.collectBundle(nid(c))))
  app.get(`${base}/summary`, wrap(() => fleet.getFleetSummary()))
  app.get(`${base}/config`, wrap(() => fleet.getFleetConfig()))
  app.post(`${base}/logs/query`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<LogQueryInput>
    if (typeof body.query !== 'string' || !RANGES.has(body.range as TimeRange)) return c.json({ error: 'query and range are required' }, 400)
    if (body.around !== undefined && typeof body.around !== 'number') return c.json({ error: 'around must be a timestamp' }, 400)
    return fleet.queryLogs({ query: body.query.slice(0, 2000), range: body.range as TimeRange, around: body.around, limit: typeof body.limit === 'number' ? body.limit : undefined })
  }))
  app.get(`${base}/incidents`, wrap(() => fleet.alerts.list()))
  app.post(`${base}/incidents/:id/resolve`, wrap((c) => {
    try {
      fleet.alerts.resolveById(nid(c))
    } catch (e) {
      throw new FleetError('conflict', e instanceof Error ? e.message : String(e))
    }
    return { ok: true }
  }))
  app.get(`${base}/rules`, wrap(() => fleet.alerts.rules()))
  app.post(`${base}/rules/:id`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown }
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be true or false' }, 400)
    try {
      fleet.alerts.setEnabled(nid(c), body.enabled)
    } catch (e) {
      throw new FleetError('not-found', e instanceof Error ? e.message : String(e))
    }
    return { ok: true }
  }))
  const asConflict = (fn: () => unknown) => {
    try {
      return fn()
    } catch (e) {
      throw new FleetError('conflict', e instanceof Error ? e.message : String(e))
    }
  }
  // cooling: the front fans on the Pico
  const cooling = (c: Context, fn: (m: CoolingManager) => unknown) => {
    if (!fleet.cooling) return c.json({ error: 'Fan control is off on this host' }, 404)
    try {
      return fn(fleet.cooling)
    } catch (e) {
      if (e instanceof CoolingError) return c.json({ error: e.message }, e.kind === 'not-found' ? 404 : e.kind === 'invalid' ? 400 : 503)
      throw e
    }
  }
  app.get(`${base}/cooling`, wrap((c) => cooling(c, (m) => m.state())))
  app.get(`${base}/cooling/series`, wrap((c) => {
    const range = (c.req.query('range') ?? '1h') as TimeRange
    if (!RANGES.has(range)) return c.json({ error: 'Unknown range' }, 400)
    return cooling(c, (m) => m.series(range))
  }))
  app.post(`${base}/cooling/fans/:id/override`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { duty?: unknown }
    if (body.duty !== null && typeof body.duty !== 'number') return c.json({ error: 'duty must be a number or null' }, 400)
    return cooling(c, (m) => m.setOverride(nid(c), body.duty as number | null))
  }))
  app.post(`${base}/cooling/fans/:id/tach-test`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { seconds?: unknown }
    return cooling(c, (m) => m.tachTest(nid(c), typeof body.seconds === 'number' ? body.seconds : 30))
  }))
  app.put(`${base}/cooling/policy`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return c.json({ error: 'Expected a policy patch' }, 400)
    return cooling(c, (m) => m.setPolicy(body))
  }))
  app.put(`${base}/cooling/zones`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { zones?: unknown }
    if (!body.zones || typeof body.zones !== 'object') return c.json({ error: 'Expected { zones }' }, 400)
    return cooling(c, (m) => m.setZones(body.zones as Record<string, string[]>))
  }))
  // network: the switches, read-only
  app.get(`${base}/network`, wrap((c) => (fleet.network ? fleet.network.state() : c.json({ error: 'No switches in the site config' }, 404))))
  app.get(`${base}/updates`, wrap(() => fleet.updates.list()))
  app.post(`${base}/updates/:id/check`, wrap((c) => {
    void fleet.updates.check(nid(c))
    return { ok: true }
  }))
  app.get(`${base}/rollouts`, wrap(() => fleet.updates.rollouts()))
  app.post(`${base}/rollouts`, wrap(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<StartRolloutInput>
    const rings = Array.isArray(body.rings) ? body.rings.filter((r): r is UpdateRing => r === 'canary' || r === 'ring1' || r === 'ring2') : []
    if (typeof body.window !== 'string' || typeof body.requireApproval !== 'boolean') return c.json({ error: 'window and requireApproval are required' }, 400)
    return asConflict(() => fleet.updates.startRollout({ targetOs: String(body.targetOs ?? ''), rings, window: body.window!, requireApproval: body.requireApproval!, restartModels: body.restartModels === true }))
  }))
  app.post(`${base}/rollouts/:id/approve`, wrap((c) => {
    asConflict(() => fleet.updates.approve(nid(c)))
    return { ok: true }
  }))
  app.post(`${base}/rollouts/:id/cancel`, wrap((c) => {
    asConflict(() => fleet.updates.cancel(nid(c)))
    return { ok: true }
  }))
  if (gateway && fleet.deployments) {
    const deps = fleet.deployments
    const range = (c: Context): TimeRange | null => {
      const r = (c.req.query('range') ?? '1h') as TimeRange
      return RANGES.has(r) ? r : null
    }
    app.get(`${base}/deployments`, wrap(() => deps.list()))
    app.get(`${base}/catalog`, wrap(() => deps.catalog()))
    app.post(`${base}/deployments`, wrap(async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as Partial<CreateDeploymentInput>
      if (typeof body.catalogId !== 'string' || typeof body.engine !== 'string' || !Array.isArray(body.nodeIds)) return c.json({ error: 'catalogId, engine and nodeIds are required' }, 400)
      try {
        return await deps.create({ catalogId: body.catalogId, engine: body.engine, nodeIds: body.nodeIds.map(String) })
      } catch (e) {
        throw new FleetError('conflict', e instanceof Error ? e.message : String(e))
      }
    }))
    app.post(`${base}/deployments/:id/stop`, wrap(async (c) => {
      try {
        await deps.stopDeployment(nid(c))
      } catch (e) {
        throw new FleetError('conflict', e instanceof Error ? e.message : String(e))
      }
      return { ok: true }
    }))
    // launchers: the user's own start/stop scripts on a head node
    const conflict = async <T>(fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn()
      } catch (e) {
        throw new FleetError('conflict', e instanceof Error ? e.message : String(e))
      }
    }
    const launcherBody = async (c: Context) => (await c.req.json().catch(() => ({}))) as Partial<LauncherInput>
    app.get(`${base}/launchers`, wrap(() => deps.launchers.list()))
    app.post(`${base}/launchers`, wrap(async (c) => { const b = await launcherBody(c); return conflict(() => deps.launchers.create(b)) }))
    app.put(`${base}/launchers/:id`, wrap(async (c) => {
      const b = await launcherBody(c)
      const l = await conflict(() => deps.launchers.update(nid(c), b))
      // a running launcher's route carries its name, caps and limits
      void deps.refresh()
      return l
    }))
    app.delete(`${base}/launchers/:id`, wrap(async (c) => { await conflict(() => deps.launchers.remove(nid(c))); return { ok: true } }))
    app.post(`${base}/launchers/:id/start`, wrap((c) => conflict(() => deps.startLauncher(nid(c)))))
    app.post(`${base}/launchers/:id/stop`, wrap(async (c) => { await conflict(() => deps.stopDeployment(nid(c))); return { ok: true } }))
    app.get(`${base}/launchers/:id/log`, wrap(async (c) => ({ text: await conflict(() => deps.launchers.log(nid(c))) })))
    app.get(`${base}/gateway/info`, wrap((c): GatewayInfo => {
      const url = new URL(c.req.url)
      const models = Object.keys(gateway.routes().models).sort()
      const busiest = usageReport(gateway, '24h', Date.now()).modelTotals[0]?.model
      // through tailscale serve the Host is the tailnet name; on the box itself point at the gateway port
      const baseUrl = url.hostname.endsWith('.ts.net') ? `https://${url.host}/v1` : `http://127.0.0.1:${process.env.SPARKMAN_GATEWAY_PORT ?? 4200}/v1`
      return { baseUrl, defaultModel: busiest && models.includes(busiest) ? busiest : (models[0] ?? ''), models }
    }))
    app.get(`${base}/gateway/series`, wrap((c) => {
      const r = range(c)
      return r ? gatewaySeries(gateway, r, Date.now()) : c.json({ error: 'Unknown range' }, 400)
    }))
    app.get(`${base}/gateway/routes`, wrap((): GatewayRoute[] => {
      const table = gateway.routes()
      return Object.entries(table.models).map(([model, targets]) => ({
        model,
        deploymentId: targets[0]?.deploymentId ?? '',
        engine: targets[0]?.engine ?? 'vLLM',
        replicas: targets.length,
        nodeIds: targets.flatMap((t) => t.nodeIds),
        healthy: targets.length > 0,
      }))
    }))
    app.get(`${base}/usage`, wrap((c) => {
      const r = range(c)
      return r ? usageReport(gateway, r, Date.now(), (from, to) => deps.engineUsage.rows(from, to)) : c.json({ error: 'Unknown range' }, 400)
    }))
    app.get(`${base}/keys`, wrap(() => gateway.listKeys()))
    app.post(`${base}/keys`, wrap(async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; rateLimitRpm?: unknown }
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
      const rpm = typeof body.rateLimitRpm === 'number' && body.rateLimitRpm >= 1 && body.rateLimitRpm <= 100_000 ? Math.round(body.rateLimitRpm) : 0
      if (!name || !rpm) return c.json({ error: 'name and a rate limit (1–100000 rpm) are required' }, 400)
      const created = gateway.createKey(name, rpm)
      fleet.recordActivity('key', `API key "${name}" created`)
      return created
    }))
    app.post(`${base}/keys/:id/revoke`, wrap((c) => {
      if (!gateway.revokeKey(nid(c))) throw new FleetError('not-found', 'No active key with that id')
      fleet.recordActivity('key', 'API key revoked')
      return { ok: true }
    }))
  }
  if (fleet.benches) {
    const b = fleet.benches
    app.get(`${base}/benchmarks`, wrap((c) => b.list({ nodeId: c.req.query('nodeId') || undefined, model: c.req.query('model') || undefined, kind: (c.req.query('kind') || undefined) as BenchKind | undefined })))
    app.get(`${base}/benchmarks/:id`, wrap((c) => b.get(nid(c)) ?? c.json({ error: 'Bench run not found' }, 404)))
    app.post(`${base}/benchmarks`, wrap(async (c) => {
      const body = (await c.req.json().catch(() => null)) as StartBenchInput | null
      if (!body || typeof body.deploymentId !== 'string' || typeof body.config !== 'object' || body.config === null) return c.json({ error: 'deploymentId and config are required' }, 400)
      return asConflict(() => b.start(body))
    }))
    app.post(`${base}/benchmarks/:id/cancel`, wrap((c) => {
      asConflict(() => b.cancel(nid(c)))
      return { ok: true }
    }))
    app.post(`${base}/benchmarks/:id/delete`, wrap((c) => {
      asConflict(() => b.delete(nid(c)))
      return { ok: true }
    }))
  }
  app.get(`${base}/activity`, wrap((c) => fleet.listActivity(Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500))))

  app.get(`${base}/events`, (c) =>
    streamSSE(c, async (stream) => {
      const queue: SimEvent[] = []
      let wake: (() => void) | null = null
      const off = fleet.subscribe((e) => {
        queue.push(e)
        wake?.()
      })
      stream.onAbort(() => {
        off()
        wake?.()
      })
      try {
        while (!stream.aborted) {
          while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) })
          await new Promise<void>((resolve) => {
            wake = resolve
            setTimeout(resolve, HEARTBEAT_MS)
          })
          wake = null
          if (!queue.length && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '' })
        }
      } finally {
        off()
      }
    }),
  )
}
