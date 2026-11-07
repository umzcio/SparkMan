import type {
  FirmwareUpdate, NodeModel, NodeUpdateStatus, Rollout, RolloutNode, RolloutStep, SparkToolEnvelope, StartRolloutInput, UpdateRing,
} from '../../src/api/types.ts'
import type { FleetDb } from './db.ts'
import { toEnvelope, type ToolOutput } from './tools.ts'

// ---------- parsing ----------

/** `Inst pkg [current] (new …)` lines plus the "kept back" block from apt-get's simulated upgrade. */
export function parseAptPending(aptOutput: string): string[] {
  const pending = new Set<string>()
  const lines = aptOutput.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const inst = /^Inst (\S+) \[([^\]]+)\] \(([^ )]+)/.exec(lines[i])
    if (inst) pending.add(`${inst[1]} ${inst[2]} → ${inst[3]}`)
    if (/have been kept back:/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
        for (const name of lines[j].trim().split(/\s+/)) pending.add(`${name} (held back)`)
      }
    }
  }
  return [...pending]
}

/** The running DGX OS version from /etc/dgx-release: the last OTA line, else the factory build. */
export function parseDgxRelease(text: string): string {
  const ota = [...text.matchAll(/^DGX_OTA_VERSION="?([^"\n]+)"?/gm)].at(-1)?.[1]
  return ota ?? /^DGX_SWBUILD_VERSION="?([^"\n]+)"?/m.exec(text)?.[1] ?? ''
}

/** `fwupdmgr get-updates --json` → one row per device with a newer release. */
export function parseFwupdUpdates(json: string): FirmwareUpdate[] {
  try {
    const v = JSON.parse(json) as { Devices?: { Name?: string; Version?: string; Releases?: { Version?: string }[] }[] }
    return (v.Devices ?? []).flatMap((d) => {
      const next = d.Releases?.[0]?.Version
      return d.Name && next ? [{ component: d.Name, current: d.Version ?? '?', available: next }] : []
    })
  } catch {
    return []
  }
}

// ---------- the manager ----------

/** What the update manager needs from the fleet service. */
export interface UpdateHost {
  nodes(): { id: string; model: NodeModel; dgxOs: string; ring: UpdateRing; status: string; maintenance?: boolean
    /** serving a model the user's launch scripts started; a rollout would reboot it out from under them */
    busy?: string }[]
  /** the launcher a node belongs to while it holds the node */
  launcherOn(nodeId: string): { id: string; name: string; nodeIds: string[]; state: string } | undefined
  launcherState(id: string): string | null
  stopLauncher(id: string): Promise<void>
  startLauncher(id: string): Promise<void>
  tool(id: string, script: string, args: string[], timeoutMs?: number): Promise<{ out: ToolOutput | null; rc: number; ms: number }>
  sh(id: string, command: string, timeoutMs?: number): Promise<{ code: number; stdout: string }>
  health(id: string): Promise<{ envelope: SparkToolEnvelope }>
  reboot(id: string): Promise<void>
  /** the DGX OS version the node reports now (the enrollment snapshot goes stale after an OTA) */
  setOs(id: string, version: string): void
  activity(kind: 'update', text: string, nodeId: string | null): void
  changed(topic: 'updates' | 'rollouts' | 'activity'): void
}

const CHECK_EVERY_MS = 6 * 3_600_000
/** a launcher's stop script gets 15 min; a model gets an hour to answer again (as when started by hand) */
const MODEL_STOP_MS = 20 * 60_000
const MODEL_START_MS = 60 * 60_000
const RING_ORDER: UpdateRing[] = ['canary', 'ring1', 'ring2']
/** noninteractive, keeping local config files where a package ships a new one */
const APT_FULL_UPGRADE =
  "sudo -n env DEBIAN_FRONTEND=noninteractive sh -c 'apt-get update -q && apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade' 2>&1"

function lastLines(out: string, n = 3): string {
  return out.trim().split('\n').slice(-n).join(' / ').slice(0, 400)
}

export class UpdateManager {
  private host: UpdateHost
  private db: FleetDb
  private now: () => number
  /** apply for real (apt-get full-upgrade, fwupd, reboot); otherwise every step is a dry run */
  readonly apply: boolean
  private checking = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private running: string | null = null
  /** poll interval while waiting on a launcher; tests shorten it */
  pollMs = 10_000
  /** how long a rebooting node gets before its status is trusted again; tests shorten it */
  rebootSettleMs = 60_000

  constructor(host: UpdateHost, db: FleetDb, opts: { apply: boolean; now?: () => number }) {
    this.host = host
    this.db = db
    this.apply = opts.apply
    this.now = opts.now ?? Date.now
    db.db.exec('CREATE TABLE IF NOT EXISTS rollouts (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)')
    // a rollout that was mid-flight when the server stopped can't be trusted to resume: fail it
    for (const r of this.rollouts().filter((r) => r.status === 'running')) {
      for (const n of r.nodes) if (n.step !== 'done' && n.step !== 'queued') Object.assign(n, { step: 'failed', note: 'SparkMan restarted mid-rollout' })
      r.status = 'failed'
      r.finishedAt = this.now()
      this.saveRollout(r)
    }
  }

  start(): void {
    // first checks staggered so 7 boxes don't hit the mirrors at once
    this.host.nodes().forEach((n, i) => setTimeout(() => void this.check(n.id), 30_000 + i * 20_000))
    this.timer = setInterval(() => {
      for (const n of this.host.nodes()) {
        const last = this.status(n.id)?.lastChecked ?? 0
        if (this.now() - last > CHECK_EVERY_MS) void this.check(n.id)
      }
    }, 10 * 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private status(id: string): NodeUpdateStatus | null {
    const v = this.db.get(`update:${id}`)
    return v ? (JSON.parse(v) as NodeUpdateStatus) : null
  }

  list(): NodeUpdateStatus[] {
    return this.host.nodes().map((n) => {
      const s = this.status(n.id)
      const base = { nodeId: n.id, model: n.model, ring: n.ring, currentOs: `DGX OS ${n.dgxOs}` }
      if (s) return { ...s, ...base, targetOs: s.aptPending.length || s.firmwarePending.length ? 'latest packages' : base.currentOs }
      return {
        ...base, targetOs: base.currentOs, aptPending: [], firmwarePending: [], rebootRequired: false, lastChecked: 0,
        envelope: { tool: 'spark_updatectl.py', ts: '', host: n.id, status: 'warn', rc: -1, duration_ms: 0, summary: { mode: 'check' }, warnings: ['Not checked yet'], artifacts: [] },
      }
    })
  }

  /** `spark_updatectl update check` (apt + fwupd dry run), fwupd's JSON and the reboot flag, for one node. */
  async check(id: string): Promise<void> {
    const node = this.host.nodes().find((n) => n.id === id)
    if (!node || node.status === 'offline' || node.status === 'rebooting' || this.checking.has(id)) return
    this.checking.add(id)
    try {
      const chk = await this.host.tool(id, 'spark_updatectl.py', ['update', 'check'], 10 * 60_000)
      const [fw, st, rel] = await Promise.all([
        this.host.sh(id, 'sudo -n fwupdmgr get-updates --json 2>/dev/null', 120_000),
        this.host.tool(id, 'spark_updatectl.py', ['status'], 60_000),
        this.host.sh(id, 'cat /etc/dgx-release', 30_000),
      ])
      const os = parseDgxRelease(rel.stdout) || node.dgxOs
      if (os !== node.dgxOs) this.host.setOs(id, os)
      const data = (chk.out?.data ?? {}) as { apt_output?: string }
      const aptPending = parseAptPending(data.apt_output ?? '')
      const firmwarePending = parseFwupdUpdates(fw.stdout)
      const pr = (st.out?.data as { pending_reboot?: { pending?: boolean } } | undefined)?.pending_reboot
      const status: NodeUpdateStatus = {
        nodeId: id, model: node.model, ring: node.ring, currentOs: `DGX OS ${os}`,
        targetOs: aptPending.length || firmwarePending.length ? 'latest packages' : `DGX OS ${os}`,
        aptPending, firmwarePending, rebootRequired: pr?.pending === true, lastChecked: this.now(),
        envelope: toEnvelope('spark_updatectl.py', id, chk.out, chk.rc, chk.ms, {
          mode: 'check', pending_packages: aptPending.length, firmware_updates: firmwarePending.length, reboot_required: pr?.pending === true,
        }, pr?.pending ? ['reboot required to activate installed updates'] : []),
      }
      this.db.set(`update:${id}`, JSON.stringify(status))
      this.host.changed('updates')
    } finally {
      this.checking.delete(id)
    }
  }

  // ---------- rollouts ----------

  rollouts(): Rollout[] {
    return (this.db.db.prepare('SELECT data FROM rollouts ORDER BY created DESC LIMIT 100').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Rollout)
  }

  private saveRollout(r: Rollout): void {
    this.db.db.prepare('INSERT OR REPLACE INTO rollouts (id, created, data) VALUES (?, ?, ?)').run(r.id, r.createdAt, JSON.stringify(r))
    this.host.changed('rollouts')
  }

  private get(id: string): Rollout {
    const r = this.rollouts().find((x) => x.id === id)
    if (!r) throw new Error('Rollout not found')
    return r
  }

  startRollout(input: StartRolloutInput): Rollout {
    if (this.rollouts().some((r) => r.status === 'running' || r.status === 'awaiting-approval')) throw new Error('Another rollout is already planned or running')
    const rings = RING_ORDER.filter((r) => input.rings.includes(r))
    if (!rings.length) throw new Error('Pick at least one ring')
    const all = this.host.nodes()
    const eligible = (id: string) => {
      const n = all.find((x) => x.id === id)
      // an offline node would only fail its precheck and stop the rollout
      return !!n && rings.includes(n.ring) && !n.maintenance && n.status !== 'offline' && n.status !== 'rebooting'
    }
    const nodes: RolloutNode[] = []
    for (const n of all.filter((x) => eligible(x.id))) {
      if (!n.busy) {
        nodes.push({ nodeId: n.id, ring: n.ring, step: 'queued' })
        continue
      }
      // a serving model whose nodes are all in the rollout can be stopped and started again around them
      const l = input.restartModels ? this.host.launcherOn(n.id) : undefined
      if (l && l.state === 'serving' && l.nodeIds.every(eligible)) nodes.push({ nodeId: n.id, ring: n.ring, step: 'queued', launcher: { id: l.id, name: l.name } })
    }
    if (!nodes.length) {
      throw new Error(input.restartModels
        ? 'No nodes to update in those rings (nodes offline or in maintenance, or running a model that is not serving or spans other rings, are skipped)'
        : 'No nodes to update in those rings (nodes offline, in maintenance or running a launcher are skipped)')
    }
    // a model's nodes go back to back within each ring, so it is down for as short a time as possible
    const key = new Map(nodes.map((n, i) => [n, RING_ORDER.indexOf(n.ring) * 1000 + (n.launcher ? nodes.findIndex((x) => x.launcher?.id === n.launcher!.id) : i)]))
    nodes.sort((a, b) => key.get(a)! - key.get(b)! || nodes.indexOf(a) - nodes.indexOf(b))
    const now = this.now()
    const r: Rollout = {
      id: `ro-${now.toString(36)}`,
      name: `${this.apply ? 'Update' : 'Dry run'} · ${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
      targetOs: 'latest packages',
      rings,
      window: input.window,
      status: input.requireApproval ? 'awaiting-approval' : 'running',
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      nodes,
      restartModels: input.restartModels === true,
    }
    this.saveRollout(r)
    this.host.activity('update', `Rollout planned: ${r.name} (${rings.join(' → ')})${input.requireApproval ? ', awaiting approval' : ''}`, null)
    if (r.status === 'running') void this.run(r.id)
    return r
  }

  approve(id: string): void {
    const r = this.get(id)
    if (r.status !== 'awaiting-approval') throw new Error('Rollout is not awaiting approval')
    r.status = 'running'
    this.saveRollout(r)
    this.host.activity('update', `Rollout approved: ${r.name}`, null)
    void this.run(r.id)
  }

  cancel(id: string): void {
    const r = this.get(id)
    if (r.status !== 'awaiting-approval') throw new Error('Only a rollout awaiting approval can be rejected')
    r.status = 'failed'
    r.finishedAt = this.now()
    this.saveRollout(r)
    this.host.activity('update', `Rollout rejected: ${r.name}`, null)
  }

  /** Milliseconds until the rollout's maintenance window opens (0 = now). */
  windowDelay(window: string, now = new Date(this.now())): number {
    const m = /^(Tonight|Sunday) (\d\d):(\d\d)/.exec(window)
    if (!m) return 0
    const start = new Date(now)
    start.setHours(Number(m[2]), Number(m[3]), 0, 0)
    if (m[1] === 'Sunday') start.setDate(start.getDate() + ((7 - start.getDay()) % 7))
    if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + (m[1] === 'Sunday' ? 7 : 1))
    return start.getTime() - now.getTime()
  }

  private async run(id: string): Promise<void> {
    if (this.running) return
    this.running = id
    try {
      const wait = this.windowDelay(this.get(id).window)
      if (wait > 0) await new Promise((res) => setTimeout(res, wait))
      let r = this.get(id)
      if (r.status !== 'running') return
      r.startedAt = this.now()
      this.saveRollout(r)
      const stopped = new Set<string>()
      for (const ring of r.rings) {
        for (const n of r.nodes.filter((x) => x.ring === ring)) {
          let ok = true
          if (n.launcher && !stopped.has(n.launcher.id)) {
            ok = await this.stopModel(r, n)
            if (ok) stopped.add(n.launcher.id)
          }
          ok &&= await this.runNode(r, n)
          // the model's last node is done: bring it back before moving on, so a broken update shows here
          const last = n.launcher && r.nodes.filter((x) => x.launcher?.id === n.launcher!.id).at(-1)?.nodeId === n.nodeId
          if (ok && last) ok = await this.startModel(r, n)
          r = this.get(id)
          if (!ok) {
            r.status = 'failed'
            r.finishedAt = this.now()
            this.saveRollout(r)
            this.host.activity('update', `Rollout failed on ${n.nodeId}; later rings were not touched`, n.nodeId)
            if (n.launcher && this.apply && this.host.launcherState(n.launcher.id) === 'idle') this.host.activity('update', `${n.launcher.name} was left stopped`, n.nodeId)
            return
          }
        }
      }
      r.status = 'completed'
      r.finishedAt = this.now()
      this.saveRollout(r)
      this.host.activity('update', `Rollout completed: ${r.name}`, null)
    } finally {
      this.running = null
    }
  }

  /** `note` says why a node failed (or what it left behind), so the history can show it */
  private setStep(r: Rollout, nodeId: string, step: RolloutStep, note?: string): void {
    const fresh = this.get(r.id)
    const n = fresh.nodes.find((x) => x.nodeId === nodeId)
    if (n) {
      n.step = step
      if (note) n.note = note
    }
    this.saveRollout(fresh)
  }

  /** Wait for a launcher to reach one of `states`; false on timeout. */
  private async waitLauncher(id: string, states: string[], ms: number): Promise<string | null> {
    const deadline = this.now() + ms
    for (;;) {
      const s = this.host.launcherState(id)
      if (s && states.includes(s)) return s
      if (this.now() >= deadline) return null
      await new Promise((res) => setTimeout(res, this.pollMs))
    }
  }

  private async stopModel(r: Rollout, n: RolloutNode): Promise<boolean> {
    const l = n.launcher!
    this.setStep(r, n.nodeId, 'stop-model')
    if (!this.apply) {
      this.host.activity('update', `Dry run: would stop ${l.name}`, n.nodeId)
      return true
    }
    this.host.activity('update', `Rollout stopping ${l.name}`, n.nodeId)
    try {
      await this.host.stopLauncher(l.id)
    } catch (e) {
      const why = `Couldn't stop ${l.name}: ${e instanceof Error ? e.message : String(e)}`
      this.setStep(r, n.nodeId, 'failed', why)
      this.host.activity('update', why, n.nodeId)
      return false
    }
    if (await this.waitLauncher(l.id, ['idle'], MODEL_STOP_MS)) return true
    this.setStep(r, n.nodeId, 'failed', `${l.name} didn't stop within ${MODEL_STOP_MS / 60_000} min`)
    this.host.activity('update', `${l.name} didn't stop within ${MODEL_STOP_MS / 60_000} min`, n.nodeId)
    return false
  }

  private async startModel(r: Rollout, n: RolloutNode): Promise<boolean> {
    const l = n.launcher!
    this.setStep(r, n.nodeId, 'start-model')
    if (!this.apply) {
      this.host.activity('update', `Dry run: would start ${l.name} again`, n.nodeId)
      this.setStep(r, n.nodeId, 'done')
      return true
    }
    this.host.activity('update', `Rollout starting ${l.name} again`, n.nodeId)
    let state: string | null = null
    try {
      await this.host.startLauncher(l.id)
      state = await this.waitLauncher(l.id, ['serving', 'failed', 'down', 'idle'], MODEL_START_MS)
    } catch (e) {
      this.host.activity('update', `Couldn't start ${l.name}: ${e instanceof Error ? e.message : String(e)}`, n.nodeId)
    }
    if (state === 'serving') {
      this.setStep(r, n.nodeId, 'done')
      this.host.activity('update', `${l.name} is serving again`, n.nodeId)
      return true
    }
    const why = `${l.name} didn't come back after the update (${state ?? 'timed out'}); check its log`
    this.setStep(r, n.nodeId, 'failed', why)
    this.host.activity('update', why, n.nodeId)
    return false
  }

  /** precheck → apply → reboot → postcheck on one node; false stops the rollout. */
  private async runNode(r: Rollout, n: RolloutNode): Promise<boolean> {
    const id = n.nodeId
    const fail = (why: string) => {
      this.setStep(r, id, 'failed', why)
      this.host.activity('update', `${id}: ${why}`, id)
      return false
    }
    this.setStep(r, id, 'precheck')
    const node = this.host.nodes().find((x) => x.id === id)
    if (!node || node.status === 'offline' || node.status === 'rebooting') return fail(`precheck failed: node is ${node?.status ?? 'gone'}`)
    const pre = await this.host.health(id)
    if (pre.envelope.status === 'error') return fail(`precheck failed: ${pre.envelope.warnings.join('; ')}`)

    this.setStep(r, id, 'apply')
    if (this.apply) {
      // spark_updatectl's own apply is plain `apt-get upgrade`, which never installs what's kept back:
      // the new kernel, the NVIDIA driver and the DGX OS meta package. full-upgrade does.
      const apt = await this.host.sh(id, APT_FULL_UPGRADE, 45 * 60_000)
      if (apt.code !== 0) return fail(`apt-get full-upgrade failed (exit ${apt.code}): ${lastLines(apt.stdout)}`)
    }
    // apt is done by now, so this is fwupd (plus the dry run's own apt check)
    const applied = await this.host.tool(id, 'spark_updatectl.py', ['update', this.apply ? 'now' : 'check'], 30 * 60_000)
    if (!applied.out) return fail(`apply printed no result (exit ${applied.rc})`)
    await this.check(id)
    const left = this.apply ? (this.status(id)?.aptPending ?? []) : []
    if (left.length) return fail(`${left.length} package${left.length === 1 ? '' : 's'} still pending after the upgrade: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', …' : ''}`)

    this.setStep(r, id, 'reboot')
    if (this.apply && this.status(id)?.rebootRequired) {
      await this.host.reboot(id)
      const deadline = this.now() + 20 * 60_000
      await new Promise((res) => setTimeout(res, this.rebootSettleMs))
      while (this.now() < deadline) {
        if (this.host.nodes().find((x) => x.id === id)?.status === 'online') break
        await new Promise((res) => setTimeout(res, this.pollMs))
      }
      if (this.host.nodes().find((x) => x.id === id)?.status !== 'online') return fail('did not come back within 20 min of the reboot')
      // the check before the reboot still says one is needed
      await this.check(id)
    } else {
      const plan = await this.host.tool(id, 'spark_updatectl.py', ['reboot', 'plan', '--reason', 'SparkMan rollout'], 60_000)
      if (!plan.out?.ok) return fail('reboot plan failed')
    }

    this.setStep(r, id, 'postcheck')
    const post = await this.host.health(id)
    if (post.envelope.status === 'error') return fail(`postcheck failed: ${post.envelope.warnings.join('; ')}`)
    this.setStep(r, id, 'done')
    this.host.activity('update', `${id}: ${this.apply ? 'updated' : 'dry run passed'}`, id)
    return true
  }
}
