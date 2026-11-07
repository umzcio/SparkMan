import { randomBytes } from 'node:crypto'
import type { Engine, Launcher, LauncherInput, LauncherState, ModelCap } from '../../src/api/types.ts'
import type { FleetDb } from './db.ts'
import { shq } from './ssh.ts'

/**
 * Models started by the user's own scripts, the way they already run them by hand: SparkMan runs start.sh
 * detached on the head (so it outlives SSH and SparkMan restarts), runs stop.sh to end it, and watches the
 * port. Ranks, containers and engine flags all stay in the scripts, so multi-node rings need nothing here
 * beyond knowing which nodes they occupy.
 */
export interface LaunchHost {
  nodes(): { id: string; ip: string; status: string; drained: boolean }[]
  sh(id: string, command: string, opts?: { timeoutMs?: number; input?: string }): Promise<{ code: number; stdout: string }>
  activity(text: string, nodeId: string | null): void
  changed(topic: 'deployments' | 'nodes' | 'activity'): void
}

interface Stored extends LauncherInput {
  id: string
  state: LauncherState
  detail: string | null
  startedAt: number | null
  models: string[]
  engine: Engine
  contextLength: number
  /** consecutive probes a serving model didn't answer */
  misses: number
}

/** a start script that exits 0 (containers detached) gets this long to answer on its port */
export const LOAD_TIMEOUT_MS = 60 * 60_000
export const STOP_TIMEOUT_S = 15 * 60
const MISSES_DOWN = 3
const MAX_NODES = 8
const LOG_LINES = 400
const PROBE_MS = 2500

/** what a running launcher can't change */
const LOCKED = ['nodeIds', 'dir', 'startScript', 'stopScript', 'port', 'sudo'] as const
const CAPS: ModelCap[] = ['tools', 'thinking', 'images']
const DIR_RE = /^(~\/|\/)[A-Za-z0-9._/+-]*$/
const SCRIPT_RE = /^[A-Za-z0-9._+-]+\.sh$/

/** the run directory on the head, under the SSH user's home */
const RUN = '"$HOME"/.cache/sparkman/launch'

/** `~/x` → "$HOME"/'x' so the head's shell expands the home, everything else quoted */
const dirArg = (dir: string) => (dir === '~/' ? '"$HOME"' : dir.startsWith('~/') ? `"$HOME"/${shq(dir.slice(2))}` : shq(dir))

/** engine from /v1/models owned_by; whatever the scripts start otherwise */
export function engineOf(ownedBy: string | undefined): Engine {
  const o = (ownedBy ?? '').toLowerCase()
  if (o.includes('vllm')) return 'vLLM'
  if (o.includes('sglang')) return 'SGLang'
  if (o.includes('tensorfold')) return 'TensorFold'
  if (o.includes('llama')) return 'llama.cpp'
  return 'Script'
}

/** ANSI colours out, progress-bar redraws (\r) collapsed to their last frame */
export function cleanLog(text: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  return noAnsi.split('\n').map((l) => l.split('\r').filter(Boolean).pop() ?? '').join('\n')
}

export function validateLauncher(input: Partial<LauncherInput>, known: (id: string) => boolean): LauncherInput {
  const name = String(input.name ?? '').trim()
  if (!name || name.length > 64) throw new Error('Name is required (64 characters at most)')
  const nodeIds = Array.isArray(input.nodeIds) ? [...new Set(input.nodeIds.map(String))] : []
  if (!nodeIds.length) throw new Error('Pick the head node')
  if (nodeIds.length > MAX_NODES) throw new Error(`At most ${MAX_NODES} nodes`)
  const unknown = nodeIds.find((id) => !known(id))
  if (unknown) throw new Error(`Unknown node ${unknown}`)
  const dir = String(input.dir ?? '').trim().replace(/(.)\/+$/, '$1')
  if (!DIR_RE.test(dir) || dir.split('/').includes('..')) throw new Error('Folder must be an absolute path or start with ~/ (letters, digits, . _ - + /)')
  const startScript = String(input.startScript ?? '').trim()
  if (!SCRIPT_RE.test(startScript)) throw new Error('Start script must be a file name ending in .sh, in that folder')
  const stop = input.stopScript == null ? '' : String(input.stopScript).trim()
  if (stop && !SCRIPT_RE.test(stop)) throw new Error('Stop script must be a file name ending in .sh, in that folder')
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535')
  const notes = String(input.notes ?? '').slice(0, 500)
  const maxOutput = input.maxOutput == null || String(input.maxOutput) === '' ? null : Number(input.maxOutput)
  if (maxOutput !== null && (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 10_000_000)) throw new Error('Max output must be a whole number of tokens')
  const contextWindow = input.contextWindow == null || String(input.contextWindow) === '' ? null : Number(input.contextWindow)
  if (contextWindow !== null && (!Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > 100_000_000)) throw new Error('Context window must be a whole number of tokens')
  const caps = CAPS.filter((c) => Array.isArray(input.caps) && input.caps.includes(c))
  return { name, nodeIds, dir, startScript, stopScript: stop || null, port, sudo: input.sudo === true, caps, maxOutput, contextWindow, notes }
}

export class LauncherManager {
  private host: LaunchHost
  private db: FleetDb
  private now: () => number
  private fetch: typeof fetch
  /** ids with a start or stop in flight, so refresh leaves them alone */
  private busy = new Set<string>()

  constructor(host: LaunchHost, db: FleetDb, opts: { now?: () => number; fetch?: typeof fetch } = {}) {
    this.host = host
    this.db = db
    this.now = opts.now ?? Date.now
    this.fetch = opts.fetch ?? fetch
    db.db.exec('CREATE TABLE IF NOT EXISTS launchers (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  }

  private all(): Stored[] {
    return (this.db.db.prepare('SELECT data FROM launchers ORDER BY id').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Stored)
  }

  private get(id: string): Stored {
    const row = this.db.db.prepare('SELECT data FROM launchers WHERE id = ?').get(id) as { data: string } | undefined
    if (!row) throw new Error('Launcher not found')
    return JSON.parse(row.data) as Stored
  }

  private save(l: Stored): void {
    this.db.db.prepare('INSERT OR REPLACE INTO launchers (id, data) VALUES (?, ?)').run(l.id, JSON.stringify(l))
  }

  private set(id: string, patch: Partial<Stored>): Stored {
    const next = { ...this.get(id), ...patch }
    this.save(next)
    this.host.changed('deployments')
    return next
  }

  list(): Launcher[] {
    return this.all().map(({ misses: _m, ...l }) => l)
  }

  /** launchers holding their nodes: everything but idle */
  active(): Launcher[] {
    return this.list().filter((l) => l.state !== 'idle')
  }

  /** the active launcher a node belongs to */
  holding(nodeId: string): Launcher | undefined {
    return this.active().find((l) => l.nodeIds.includes(nodeId))
  }

  private known = (id: string) => this.host.nodes().some((n) => n.id === id)

  create(input: Partial<LauncherInput>): Launcher {
    const v = validateLauncher(input, this.known)
    if (this.all().some((l) => l.name === v.name)) throw new Error(`A launcher named ${v.name} exists`)
    const l: Stored = { ...v, id: `ln-${this.now().toString(36)}-${randomBytes(3).toString('hex')}`, state: 'idle', detail: null, startedAt: null, models: [], engine: 'Script', contextLength: 0, misses: 0 }
    this.save(l)
    this.host.activity(`Added launcher ${l.name} (${l.nodeIds.join(' + ')})`, l.nodeIds[0])
    this.host.changed('deployments')
    return this.list().find((x) => x.id === l.id)!
  }

  update(id: string, input: Partial<LauncherInput>): Launcher {
    const cur = this.get(id)
    const v = validateLauncher(input, this.known)
    if (this.all().some((l) => l.id !== id && l.name === v.name)) throw new Error(`A launcher named ${v.name} exists`)
    // while it runs, only what describes the model may change; how it starts and stops is fixed
    const running = cur.state !== 'idle' && cur.state !== 'failed'
    if (running && LOCKED.some((k) => JSON.stringify(v[k]) !== JSON.stringify(cur[k]))) throw new Error(`Stop ${cur.name} before changing its nodes, folder, scripts, port or root setting`)
    this.save({ ...cur, ...v })
    this.host.changed('deployments')
    return this.list().find((x) => x.id === id)!
  }

  remove(id: string): void {
    const cur = this.get(id)
    if (cur.state !== 'idle' && cur.state !== 'failed') throw new Error(`Stop ${cur.name} before deleting it`)
    this.db.db.prepare('DELETE FROM launchers WHERE id = ?').run(id)
    this.host.activity(`Removed launcher ${cur.name}`, cur.nodeIds[0])
    this.host.changed('deployments')
  }

  /**
   * Run start.sh detached on the head. `others` = nodes held by other deployments, which a start may not take.
   * Returns once the script is running; refresh() follows it to serving.
   */
  async start(id: string, others: Map<string, string>): Promise<Launcher> {
    const l = this.get(id)
    if (this.busy.has(id)) throw new Error(`${l.name} is already starting or stopping`)
    if (l.state !== 'idle' && l.state !== 'failed') throw new Error(`${l.name} is ${l.state}`)
    const nodes = this.host.nodes()
    for (const nid of l.nodeIds) {
      const n = nodes.find((x) => x.id === nid)
      if (!n) throw new Error(`Unknown node ${nid}`)
      if (n.status !== 'online' && n.status !== 'degraded') throw new Error(`${nid} is ${n.status}`)
      if (n.drained) throw new Error(`${nid} is drained`)
      const held = others.get(nid)
      if (held) throw new Error(`${nid} is serving ${held}; stop it first`)
      const other = this.holding(nid)
      if (other && other.id !== id) throw new Error(`${nid} is held by ${other.name}`)
    }
    const head = l.nodeIds[0]
    const script = `set -e
R=${RUN}; mkdir -p "$R"; D=${dirArg(l.dir)}
[ -d "$D" ] || { echo "no folder $D"; exit 3; }
[ -f "$D"/${shq(l.startScript)} ] || { echo "no ${l.startScript} in $D"; exit 3; }
${l.sudo ? `sudo -n true 2>/dev/null || { echo "$(id -un) can't sudo without a password on $(hostname -s)"; exit 3; }` : ''}
if [ -s "$R/${l.id}.pid" ] && kill -0 -- -"$(cat "$R/${l.id}.pid")" 2>/dev/null; then echo running; exit 0; fi
rm -f "$R/${l.id}.exit"
echo "=== $(date -u +%FT%TZ) SparkMan: start ${l.startScript} in $D" > "$R/${l.id}.log"
setsid bash -c 'cd "$1" && ${l.sudo ? 'sudo -n -H ' : ''}bash "./$2"; echo $? > "$3.exit"' _ "$D" ${shq(l.startScript)} "$R/${l.id}" >>"$R/${l.id}.log" 2>&1 </dev/null &
echo $! > "$R/${l.id}.pid"
echo started`
    this.busy.add(id)
    try {
      const r = await this.host.sh(head, 'bash -s', { input: script, timeoutMs: 30_000 })
      if (r.code !== 0) throw new Error(r.stdout.trim() || `start failed on ${head} (exit ${r.code})`)
    } finally {
      this.busy.delete(id)
    }
    this.host.activity(`Starting ${l.name} on ${l.nodeIds.join(' + ')}`, head)
    this.set(id, { state: 'starting', detail: null, startedAt: this.now(), models: [], misses: 0 })
    this.host.changed('nodes')
    return this.list().find((x) => x.id === id)!
  }

  /**
   * Run stop.sh (up to 15 min), then end whatever is left of the start script's process group.
   * Resolves when the stop has been handed off; refresh() and the stop itself finish the state.
   */
  async stop(id: string): Promise<void> {
    const l = this.get(id)
    if (this.busy.has(id)) throw new Error(`${l.name} is already starting or stopping`)
    if (l.state === 'idle') return
    this.busy.add(id)
    this.set(id, { state: 'stopping', detail: null })
    this.host.activity(`Stopping ${l.name}`, l.nodeIds[0])
    void this.runStop(l).finally(() => this.busy.delete(id))
  }

  private async runStop(l: Stored): Promise<void> {
    const script = `R=${RUN}; D=${dirArg(l.dir)}; rc=0
${l.stopScript ? `echo "=== $(date -u +%FT%TZ) SparkMan: stop ${l.stopScript}" >> "$R/${l.id}.log"
( cd "$D" && ${l.sudo ? 'sudo -n -H ' : ''}timeout ${STOP_TIMEOUT_S} bash ./${shq(l.stopScript)} ) >>"$R/${l.id}.log" 2>&1 </dev/null; rc=$?` : ''}
if [ -s "$R/${l.id}.pid" ]; then
  g=$(cat "$R/${l.id}.pid")
  kill -TERM -- -"$g" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -"$g" 2>/dev/null || break; sleep 1; done
  kill -KILL -- -"$g" 2>/dev/null
fi
rm -f "$R/${l.id}.pid" "$R/${l.id}.exit"
echo "=== $(date -u +%FT%TZ) SparkMan: stopped (stop script exit $rc)" >> "$R/${l.id}.log" 2>/dev/null
echo "$rc"`
    const head = l.nodeIds[0]
    let detail: string | null = null
    try {
      const r = await this.host.sh(head, 'bash -s', { input: script, timeoutMs: (STOP_TIMEOUT_S + 60) * 1000 })
      const rc = Number(r.stdout.trim().split('\n').pop())
      if (r.code !== 0) detail = `Stop couldn't run on ${head} (exit ${r.code})`
      else if (rc) detail = `${l.stopScript} exited ${rc}`
    } catch (e) {
      detail = `Stop failed on ${head}: ${e instanceof Error ? e.message : String(e)}`
    }
    this.set(l.id, { state: 'idle', detail, startedAt: null, models: [], misses: 0 })
    this.host.activity(detail ? `Stopped ${l.name}: ${detail}` : `Stopped ${l.name}`, head)
    this.host.changed('nodes')
  }

  /** the last lines of the launcher's output on the head */
  async log(id: string): Promise<string> {
    const l = this.get(id)
    const r = await this.host.sh(l.nodeIds[0], `tail -n ${LOG_LINES} "$HOME"/.cache/sparkman/launch/${l.id}.log 2>/dev/null`, { timeoutMs: 15_000 })
    return cleanLog(r.stdout)
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  }

  /** What the port serves, and its context window from wherever the engine reports it. */
  private async models(ip: string, port: number): Promise<{ ids: string[]; engine: Engine; contextLength: number } | null> {
    const base = `http://${ip}:${port}`
    const j = (await this.getJson(`${base}/v1/models`).catch(() => null)) as { data?: { id: string; owned_by?: string; max_model_len?: number }[] } | null
    if (!j || !Array.isArray(j.data)) return null
    const engine = engineOf(j.data[0]?.owned_by)
    // vLLM: max_model_len; TensorFold: /health; llama.cpp: /props; SGLang: /get_model_info
    let ctx = j.data[0]?.max_model_len ?? 0
    if (!ctx) {
      const probes: [string, (v: Record<string, unknown>) => unknown][] = [
        ['/health', (v) => v.context_length],
        ['/props', (v) => (v.default_generation_settings as Record<string, unknown> | undefined)?.n_ctx ?? v.n_ctx],
        ['/get_model_info', (v) => v.context_length ?? v.max_total_num_tokens],
      ]
      for (const [path, pick] of probes) {
        const v = (await this.getJson(`${base}${path}`).catch(() => null)) as Record<string, unknown> | null
        const n = v ? Number(pick(v)) : NaN
        if (Number.isFinite(n) && n > 0) {
          ctx = n
          break
        }
      }
    }
    return { ids: j.data.map((m) => m.id), engine, contextLength: ctx }
  }

  /** Follow every launcher: is the start script alive, did it exit, does the port answer. */
  async refresh(): Promise<void> {
    const nodes = this.host.nodes()
    await Promise.all(this.all().map(async (l) => {
      if (this.busy.has(l.id) || l.state === 'stopping') return
      const head = nodes.find((n) => n.id === l.nodeIds[0])
      if (!head || (head.status !== 'online' && head.status !== 'degraded')) return
      const r = await this.host.sh(head.id, `R=${RUN}; a=0; g=$(cat "$R/${l.id}.pid" 2>/dev/null); [ -n "$g" ] && kill -0 -- -"$g" 2>/dev/null && a=1; echo "$a $([ -n "$g" ] && echo p || echo -) $(cat "$R/${l.id}.exit" 2>/dev/null)"`, { timeoutMs: 15_000 }).catch(() => null)
      if (!r || r.code !== 0) return
      const [aliveS, pidS, exitS] = r.stdout.trim().split(/\s+/)
      const alive = aliveS === '1'
      const hasPid = pidS === 'p'
      const exit = exitS === undefined || exitS === '' ? null : Number(exitS)
      // idle means SparkMan didn't start it: only a live process group (SparkMan restarted mid-run) brings it back
      if (l.state === 'idle' && !alive) return
      const up = await this.models(head.ip, l.port)
      const patch: Partial<Stored> = {}
      if (up) {
        Object.assign(patch, { state: 'serving', detail: null, models: up.ids, engine: up.engine, contextLength: up.contextLength || l.contextWindow || 0, misses: 0 })
        if (l.state !== 'serving') this.host.activity(`${l.name} is serving ${up.ids.join(', ')}`, head.id)
      } else if (l.state === 'serving' || l.state === 'down') {
        const misses = l.misses + 1
        patch.misses = misses
        if (misses >= MISSES_DOWN && l.state !== 'down') {
          Object.assign(patch, { state: 'down', detail: alive ? `Not answering on :${l.port}` : exit ? `${l.startScript} exited ${exit}` : `Stopped answering on :${l.port}` })
          this.host.activity(`${l.name} went down: ${patch.detail}`, head.id)
        }
      } else if (!alive && exit !== null && exit !== 0) {
        Object.assign(patch, { state: 'failed', detail: `${l.startScript} exited ${exit}`, models: [] })
        if (l.state !== 'failed') this.host.activity(`${l.name} failed: ${l.startScript} exited ${exit}`, head.id)
      } else if (!alive && !hasPid && l.state !== 'failed') {
        // its run files are gone (head reinstalled, cache wiped): nothing left to follow
        Object.assign(patch, { state: 'idle', detail: 'Lost track of the start script on the head', startedAt: null, models: [] })
      } else if (l.state === 'starting' && l.startedAt && this.now() - l.startedAt > LOAD_TIMEOUT_MS) {
        Object.assign(patch, { state: 'failed', detail: `No answer on :${l.port} after ${LOAD_TIMEOUT_MS / 60_000} min` })
        this.host.activity(`${l.name} failed: ${patch.detail}`, head.id)
      } else if (l.state === 'idle' && alive) {
        Object.assign(patch, { state: 'starting', startedAt: l.startedAt ?? this.now() })
      }
      if (Object.keys(patch).length && Object.entries(patch).some(([k, v]) => JSON.stringify(v) !== JSON.stringify(l[k as keyof Stored]))) {
        this.save({ ...l, ...patch })
        if (patch.state && patch.state !== l.state) this.host.changed('nodes')
      }
    }))
  }
}
