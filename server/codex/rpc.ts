import { spawn } from 'node:child_process'
import readline from 'node:readline'

/** One JSON-RPC message on the `codex app-server` stdio channel (newline-delimited JSON, no "jsonrpc" field). */
export interface RpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** A bidirectional message pipe to an app-server (a child process, or the fake in tests). */
export interface CodexTransport {
  send(msg: RpcMessage): void
  onMessage(fn: (msg: RpcMessage) => void): void
  /** called once when the other side goes away */
  onClose(fn: (reason: string) => void): void
  close(): void
}

/** Spawn `codex app-server` as a child process. */
export function spawnAppServer(bin = 'codex', args: string[] = []): CodexTransport {
  const child = spawn(bin, ['app-server', ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const lines = readline.createInterface({ input: child.stdout })
  const onMsg: ((m: RpcMessage) => void)[] = []
  const onEnd: ((r: string) => void)[] = []
  let ended = false
  const end = (reason: string) => {
    if (ended) return
    ended = true
    for (const fn of onEnd) fn(reason)
  }
  lines.on('line', (line) => {
    if (!line.trim()) return
    try {
      const msg = JSON.parse(line) as RpcMessage
      for (const fn of onMsg) fn(msg)
    } catch {
      // not JSON: ignore (the server logs to stderr, but be tolerant)
    }
  })
  child.stderr.on('data', () => {}) // drain; app-server logs here
  child.on('error', (err) => end(err.message))
  child.on('exit', (code, signal) => end(`codex app-server exited (${signal ?? code})`))
  return {
    send: (msg) => {
      if (!ended) child.stdin.write(`${JSON.stringify(msg)}\n`)
    },
    onMessage: (fn) => onMsg.push(fn),
    onClose: (fn) => onEnd.push(fn),
    close: () => {
      child.stdin.end()
      child.kill()
    },
  }
}

export class RpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>

/** Request/response correlation plus notification and server-request dispatch over a transport. */
export class RpcClient {
  private nextId = 1
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private notificationHandlers: ((method: string, params: unknown) => void)[] = []
  private requestHandler: ServerRequestHandler | null = null
  private closedReason: string | null = null
  private readonly transport: CodexTransport

  constructor(transport: CodexTransport) {
    this.transport = transport
    transport.onMessage((msg) => this.dispatch(msg))
    transport.onClose((reason) => {
      this.closedReason = reason
      for (const p of this.pending.values()) p.reject(new Error(reason))
      this.pending.clear()
    })
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  request<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    if (this.closedReason) return Promise.reject(new Error(this.closedReason))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.transport.send({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.transport.send(params === undefined ? { method } : { method, params })
  }

  onNotification(fn: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(fn)
  }

  onServerRequest(fn: ServerRequestHandler): void {
    this.requestHandler = fn
  }

  close(): void {
    this.transport.close()
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.method && msg.id !== undefined) {
      // a request from the server (approvals, user input)
      const id = msg.id
      const handler = this.requestHandler
      if (!handler) {
        this.transport.send({ id, error: { code: -32601, message: `Unhandled request ${msg.method}` } })
        return
      }
      handler(msg.method, msg.params).then(
        (result) => this.transport.send({ id, result }),
        (err: unknown) => this.transport.send({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } }),
      )
      return
    }
    if (msg.method) {
      for (const fn of this.notificationHandlers) fn(msg.method, msg.params)
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message))
      else p.resolve(msg.result)
    }
  }
}
