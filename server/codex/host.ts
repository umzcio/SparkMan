import { RpcClient, type CodexTransport } from './rpc.ts'

/** Something that wants the notifications and server requests for one Codex thread. */
export interface ThreadListener {
  onNotification(method: string, params: Record<string, unknown>): void
  onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown>
}

/**
 * The one `codex app-server` this SparkMan process talks to, shared by every Codex session.
 * Started on first use and restarted on demand if it dies.
 */
export class CodexHost {
  private readonly makeTransport: () => CodexTransport
  private client: RpcClient | null = null
  private ready: Promise<RpcClient> | null = null
  private readonly threads = new Map<string, ThreadListener>()
  /** threads this app-server process has loaded (resume needed after a restart) */
  private readonly loaded = new Set<string>()
  version = 'unknown'

  constructor(makeTransport: () => CodexTransport) {
    this.makeTransport = makeTransport
  }

  /** The initialized client (starting the app-server if needed). */
  rpc(): Promise<RpcClient> {
    if (this.client && !this.client.closed && this.ready) return this.ready
    const client = new RpcClient(this.makeTransport())
    this.client = client
    this.loaded.clear()
    client.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      const threadId = typeof p.threadId === 'string' ? p.threadId : null
      if (threadId) this.threads.get(threadId)?.onNotification(method, p)
    })
    client.onServerRequest(async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      const listener = typeof p.threadId === 'string' ? this.threads.get(p.threadId) : undefined
      if (!listener) throw new Error(`No SparkMan session for ${method}`)
      return listener.onServerRequest(method, p)
    })
    this.ready = (async () => {
      const init = await client.request<{ userAgent?: string }>('initialize', { clientInfo: { name: 'sparkman', title: 'SparkMan', version: '0.1.0' }, capabilities: null })
      // "sparkman/0.160.1 (...)" → the Codex version
      this.version = /\/([\d.]+)/.exec(init.userAgent ?? '')?.[1] ?? 'unknown'
      client.notify('initialized')
      return client
    })()
    this.ready.catch(() => {
      if (this.client === client) this.ready = null
    })
    return this.ready
  }

  /** Typed request on the shared connection. */
  async request<T>(method: string, params: unknown = {}): Promise<T> {
    return (await this.rpc()).request<T>(method, params)
  }

  attach(threadId: string, listener: ThreadListener): void {
    this.threads.set(threadId, listener)
    this.loaded.add(threadId)
  }

  detach(threadId: string): void {
    this.threads.delete(threadId)
  }

  isLoaded(threadId: string): boolean {
    return this.loaded.has(threadId) && !!this.client && !this.client.closed
  }

  close(): void {
    this.client?.close()
    this.client = null
    this.ready = null
  }
}
