/**
 * The model gateway as its own process (systemd unit sparkman-gateway), so restarting or updating the
 * console never cuts off a request mid-stream. Loopback only; published at /v1 with `tailscale serve`.
 */
import os from 'node:os'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { LogStore } from '../fleet/logs.ts'
import { createGatewayApp } from './proxy.ts'
import { GatewayDb } from './store.ts'

const env = process.env
const dir = env.SPARKMAN_FLEET_DB_DIR ?? path.join(os.homedir(), '.sparkman')
const port = Number(env.SPARKMAN_GATEWAY_PORT ?? 4200)
const hostname = env.SPARKMAN_GATEWAY_HOST ?? '127.0.0.1'
if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
  console.error(`Refusing to listen on ${hostname}: the gateway binds loopback only. Publish it with "tailscale serve".`)
  process.exit(1)
}

const db = new GatewayDb(path.join(dir, 'gateway.db'))
const logs = env.SPARKMAN_LOGS === '0' ? null : new LogStore(path.join(dir, 'logs.db'))
const app = createGatewayApp(db, { ...(logs ? { log: (l) => logs.add(l) } : {}) })
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`SparkMan gateway listening on http://${hostname}:${info.port} (state in ${dir})`)
})
const trim = setInterval(() => db.trim(), 3_600_000)

function shutdown() {
  clearInterval(trim)
  logs?.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
