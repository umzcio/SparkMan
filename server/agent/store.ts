import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CreateSessionBody, EventEnvelope, HostMode, SessionSummary } from '../../src/agent/protocol.ts'
import type { HostSession, SessionHooks } from './host-session.ts'
import { AgentSession } from './session.ts'
import type { QueryFn } from './types.ts'

/** Builds a session for a summary (Codex stores pass one; the default builds a Claude Code session from `queryFn`). */
export type SessionFactory = (summary: SessionSummary, events: EventEnvelope[], hooks: SessionHooks, resumable: boolean) => HostSession

export interface StoreOptions {
  dir: string
  queryFn?: QueryFn
  factory?: SessionFactory
  defaultCwd: string
  defaultMode?: HostMode
  /** the mode a session saved in an opt-in mode falls back to when this host doesn't allow it */
  allowBypass?: boolean
  model?: string
  now?: () => number
}

export class ForkError extends Error {
  readonly status: 400 | 404 | 409
  constructor(status: 400 | 404 | 409, message: string) {
    super(message)
    this.status = status
  }
}

/** Session index + per-session JSONL event logs on disk; live sessions in memory. */
export class SessionStore {
  private readonly opts: StoreOptions
  private readonly index = new Map<string, SessionSummary>()
  private readonly live = new Map<string, HostSession>()

  constructor(opts: StoreOptions) {
    this.opts = opts
    mkdirSync(opts.dir, { recursive: true })
    const indexPath = this.indexPath()
    if (existsSync(indexPath)) {
      const saved = JSON.parse(readFileSync(indexPath, 'utf8')) as SessionSummary[]
      // nothing is running after a restart
      for (const s of saved) this.index.set(s.id, { ...s, showThinking: s.showThinking ?? true, options: s.options ?? {}, state: 'idle' })
    }
  }

  list(): SessionSummary[] {
    return [...this.index.values()].map((s) => ({ ...s })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  create(body: CreateSessionBody = {}): HostSession {
    const now = (this.opts.now ?? Date.now)()
    const summary: SessionSummary = {
      id: randomUUID(),
      title: 'New session',
      cwd: body.cwd?.trim() || this.opts.defaultCwd,
      model: null,
      mode: body.mode ?? this.opts.defaultMode ?? 'default',
      state: 'idle',
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      showThinking: true,
      options: body.options ?? {},
    }
    this.index.set(summary.id, summary)
    const session = this.makeSession(summary, [], false)
    this.saveIndex()
    return session
  }

  /**
   * Branch a new session off `parentId` at the turn that ended with assistant message `atUuid`.
   * The transcript up to that turn is copied; the SDK forks its own transcript on the first start.
   */
  fork(parentId: string, atUuid: string): HostSession {
    const parent = this.get(parentId)
    if (!parent) throw new ForkError(404, 'Unknown session')
    if (parent.summary.forkAt) throw new ForkError(409, 'Send a message in this fork before forking it again')
    const events = parent.allEvents()
    const at = events.findIndex((e) => e.event.kind === 'checkpoint' && e.event.assistantUuid === atUuid)
    if (at < 0) throw new ForkError(400, 'Unknown fork point')
    const end = events.findIndex((e, i) => i > at && e.event.kind === 'turn_end')
    const kept = events.slice(0, end < 0 ? at + 1 : end + 1).filter((e) => e.event.kind !== 'status')
    const now = (this.opts.now ?? Date.now)()
    const summary: SessionSummary = {
      ...parent.summary,
      // bypass is never inherited silently: the fork starts in default unless this host allows bypass
      mode: parent.summary.mode === 'bypassPermissions' && this.opts.allowBypass !== true ? 'default' : parent.summary.mode,
      id: randomUUID(),
      title: `${parent.summary.title} (fork)`,
      state: 'idle',
      createdAt: now,
      updatedAt: now,
      costUsd: 0,
      forkedFrom: parent.id,
      forkAt: atUuid,
    }
    this.index.set(summary.id, summary)
    writeFileSync(this.logPath(summary.id), kept.map((e) => `${JSON.stringify(e)}\n`).join(''))
    const session = this.makeSession(summary, kept, false)
    this.saveIndex()
    return session
  }

  get(id: string): HostSession | null {
    const live = this.live.get(id)
    if (live) return live
    const summary = this.index.get(id)
    if (!summary) return null
    const events = this.readEvents(id)
    // a session with any persisted assistant activity has an SDK transcript to resume
    const resumable = events.some((e) => e.event.kind === 'session' || e.event.kind === 'assistant_text' || e.event.kind === 'turn_end')
    return this.makeSession(summary, events, resumable)
  }

  closeAll(): void {
    for (const s of this.live.values()) s.close()
    this.saveIndex()
  }

  private makeSession(summary: SessionSummary, events: EventEnvelope[], resumable: boolean): HostSession {
    const hooks: SessionHooks = {
      now: this.opts.now,
      persist: (id, env) => appendFileSync(this.logPath(id), `${JSON.stringify(env)}\n`),
      onChange: () => this.saveIndex(),
    }
    let session: HostSession
    if (this.opts.factory) session = this.opts.factory(summary, events, hooks, resumable)
    else {
      if (!this.opts.queryFn) throw new Error('SessionStore needs a queryFn or a factory')
      session = new AgentSession(summary, events, { ...hooks, queryFn: this.opts.queryFn, model: this.opts.model, allowBypass: this.opts.allowBypass === true }, resumable)
    }
    this.live.set(summary.id, session)
    return session
  }

  private readEvents(id: string): EventEnvelope[] {
    const p = this.logPath(id)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as EventEnvelope]
        } catch {
          return [] // tolerate a torn final line
        }
      })
  }

  private saveIndex(): void {
    writeFileSync(this.indexPath(), JSON.stringify([...this.index.values()], null, 2))
  }

  private indexPath(): string {
    return path.join(this.opts.dir, 'sessions.json')
  }

  private logPath(id: string): string {
    return path.join(this.opts.dir, `${id}.jsonl`)
  }
}
