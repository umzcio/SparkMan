import { accessSync, constants, existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { isAgentMode } from '../src/agent/protocol.ts'
import { createFakeQuery } from './agent/fake-query.ts'
import { SessionStore } from './agent/store.ts'
import type { QueryFn } from './agent/types.ts'
import { createApp } from './app.ts'
import { AuthStore } from './auth.ts'
import { loadFleetConfig } from './fleet/config.ts'
import { FleetDb } from './fleet/db.ts'
import { LogStore } from './fleet/logs.ts'
import { GatewayDb } from './gateway/store.ts'
import { FleetService } from './fleet/service.ts'
import { createSshRunner } from './fleet/ssh.ts'
import { createFakeAppServer } from './codex/fake-app-server.ts'
import { CodexHost } from './codex/host.ts'
import { spawnAppServer } from './codex/rpc.ts'
import { CodexSession } from './codex/session.ts'

const env = process.env
const fake = env.SPARKMAN_AGENT_FAKE === '1'
const port = Number(env.SPARKMAN_PORT ?? 4100)
const hostname = env.SPARKMAN_HOST ?? '127.0.0.1'
const defaultCwd = env.SPARKMAN_AGENT_CWD ?? os.homedir()
const allowedUsers = (env.SPARKMAN_ALLOWED_USERS ?? '')
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean)
// fake mode gets a throwaway data dir so test runs start clean
const dataDir = fake ? mkdtempSync(path.join(os.tmpdir(), 'sparkman-fake-')) : (env.SPARKMAN_DATA_DIR ?? path.join(os.homedir(), '.sparkman', 'agent'))
const allowBypass = env.SPARKMAN_ALLOW_BYPASS === '1'
const allowedHosts = (env.SPARKMAN_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean)
const requestedMode = isAgentMode(env.SPARKMAN_AGENT_MODE) ? env.SPARKMAN_AGENT_MODE : 'default'
const defaultMode = requestedMode === 'bypassPermissions' && !allowBypass ? 'default' : requestedMode

// The auth model trusts only loopback connections (tailscale serve connects from loopback).
if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
  console.error(`Refusing to listen on ${hostname}: SparkMan's agent API must bind to loopback. Publish it with "tailscale serve" instead.`)
  process.exit(1)
}

const queryFn: QueryFn = fake ? createFakeQuery({ delayMs: Number(env.SPARKMAN_FAKE_DELAY_MS ?? 120) }) : (query as unknown as QueryFn)

const store = new SessionStore({ dir: dataDir, queryFn, defaultCwd, defaultMode, allowBypass, model: env.SPARKMAN_AGENT_MODEL || undefined })

/** First executable named `bin` on PATH (or `bin` itself when it's a path). */
function findBinary(bin: string): string | null {
  const candidates = bin.includes('/') ? [bin] : (env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, bin))
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK)
      return c
    } catch {
      // keep looking
    }
  }
  return null
}

// Codex on the host: one shared `codex app-server`, sessions stored next to Claude's
const codexBin = env.SPARKMAN_CODEX === '0' ? null : fake ? 'fake' : findBinary(env.SPARKMAN_CODEX_BIN ?? 'codex')
const codexHost = codexBin ? new CodexHost(fake ? createFakeAppServer({ delayMs: Number(env.SPARKMAN_FAKE_DELAY_MS ?? 120) }) : () => spawnAppServer(codexBin)) : null
const codexStore = codexHost
  ? new SessionStore({
      dir: path.join(dataDir, 'codex'),
      defaultCwd,
      defaultMode: 'auto',
      allowBypass,
      factory: (summary, events, hooks) => new CodexSession(summary, events, { ...hooks, host: codexHost, allowBypass, model: env.SPARKMAN_CODEX_MODEL || undefined }),
    })
  : null
// Live fleet (phase 2): only with a site config (/etc/sparkman/fleet.json); fake/e2e runs keep the simulator.
const fleetCfg = fake || env.SPARKMAN_FLEET === '0' ? null : loadFleetConfig()
const fleetDir = env.SPARKMAN_FLEET_DB_DIR ?? path.join(os.homedir(), '.sparkman')
const gatewayDb = fleetCfg && env.SPARKMAN_GATEWAY !== '0' ? new GatewayDb(path.join(fleetDir, 'gateway.db')) : null
const fleet = fleetCfg
  ? new FleetService(fleetCfg, new FleetDb(path.join(fleetDir, 'fleet.db')), createSshRunner(fleetCfg.sshUser, fleetCfg.sshKeyPath), {
      ...(env.SPARKMAN_LOGS === '0' ? {} : { logs: new LogStore(path.join(fleetDir, 'logs.db')) }),
      logArchiveDir: env.SPARKMAN_LOG_ARCHIVE || undefined,
      rolloutApply: env.SPARKMAN_ROLLOUT_APPLY === '1',
      cooling: env.SPARKMAN_FAN !== '0',
      ...(gatewayDb ? { gateway: gatewayDb } : {}),
      ...(env.SPARKMAN_TOOL_EVAL_BIN && existsSync(env.SPARKMAN_TOOL_EVAL_BIN)
        ? { toolEval: { bin: env.SPARKMAN_TOOL_EVAL_BIN, user: env.SPARKMAN_TOOL_EVAL_USER || undefined, workDir: path.join(fleetDir, 'tool-eval') } }
        : {}),
    })
  : null
fleet?.start()

// Username/password sign-in: on whenever the users file exists (pnpm user:set creates it); off in fake/e2e runs.
const usersFile = env.SPARKMAN_USERS_FILE ?? '/etc/sparkman/users.json'
const auth = !fake && env.SPARKMAN_AUTH !== '0' && existsSync(usersFile)
  ? new AuthStore({ usersFile, sessionsFile: path.join(dataDir, '..', 'sessions.json') })
  : null
if (auth && !auth.hasUsers()) console.warn(`  ${usersFile} has no users: add one with "pnpm user:set <name>"`)

// in dev the UI comes from Vite; only serve the build in production or fake (e2e) mode
const serveBuild = env.NODE_ENV === 'production' || fake
const app = createApp({ store, ...(codexStore ? { codexStore } : {}), allowedUsers, allowedHosts, allowBypass, defaultCwd, fake, ...(fleet ? { fleet } : {}), ...(gatewayDb ? { gateway: gatewayDb } : {}), ...(auth ? { auth } : {}), staticDir: serveBuild ? path.resolve('dist') : undefined })

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`SparkMan host agent listening on http://${hostname}:${info.port}${fake ? ' (FAKE agent)' : ''}`)
  console.log(`  data: ${dataDir}   default cwd: ${defaultCwd}   bypass mode: ${allowBypass ? 'ENABLED' : 'disabled'}`)
  console.log(`  codex: ${codexBin ?? 'not found (set SPARKMAN_CODEX_BIN)'}`)
  console.log(`  sign-in: ${auth ? `on (${usersFile})` : 'off (no users file)'}`)
  console.log(`  fleet: ${fleetCfg ? `${fleetCfg.hosts.length} nodes (live)` : 'simulator (no fleet config)'}`)
  if (allowedUsers.length === 0) console.warn('  SPARKMAN_ALLOWED_USERS is empty: tailnet requests will be rejected (local access only).')
  else console.log(`  tailnet users: ${allowedUsers.join(', ')}  →  expose with: tailscale serve --bg ${info.port}`)
})

let shuttingDown = false
function shutdown() {
  // systemd signals the whole group, so pnpm's forwarded SIGTERM arrives as a second one
  if (shuttingDown) return
  shuttingDown = true
  store.closeAll()
  fleet?.stop()
  codexStore?.closeAll()
  codexHost?.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
