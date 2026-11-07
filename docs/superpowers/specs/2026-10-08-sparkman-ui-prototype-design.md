# SparkMan — UI Prototype Design

**Date:** 2026-10-08
**Status:** Approved in conversation; pending written-spec review
**Phase:** 1 of N (UI prototype on mock data)

## 1. Intent

SparkMan is a fleet management console for ~12 NVIDIA DGX Spark (GB10) / ASUS Ascent GX10 desktop AI systems. It is the single front door that AI coding agents (Claude Code, Codex CLI, OpenCode, Cursor, VS Code) point at, and the place the operator watches and maintains the fleet: resource usage, gateway usage, logs, alerts, and system updates.

**Phase 1 goal:** a clickable, live-feeling UI prototype driven by realistic simulated data. Success = the operator would genuinely leave it open; every screen is navigable, charts tick live, and actions visibly change state. The data layer is shaped like the real backend so it can be swapped in later without UI rewrites.

### Decisions captured

| Topic | Decision |
|---|---|
| Scope | UI prototype, mock data. No real backend in phase 1. |
| Users | Single operator. No auth, roles, or user management. API keys are per agent/tool. |
| Serving model | Mixed pool: most nodes serve one model each; some nodes are linked via ConnectX-7 in 2–4 node groups for large models. Gateway routes by model name and load-balances replicas. |
| Stack | Vite + React + TypeScript + TanStack Router + TanStack Query + shadcn/ui + shadcn Charts (Recharts). |
| Look | User's reference screenshots in `screenshots/` (icon rail, server list/detail, log explorer), recolored to NVIDIA green on near-black. |

### Research context (informs mock data shape and future backend)

- NVIDIA has no turnkey web console for Spark fleets. The official path is the agentless **DGX Spark Enterprise Manageability** toolkit: stdlib-Python tools run over SSH returning a JSON envelope `{tool, ts, host, status, rc, duration_ms, summary, warnings, artifacts}` (inventory, `spark_diagctl.py` L1/L2 health, `reset_reason_reporter.py`, `spark_updatectl.py` with rings + pre/postcheck).
- GB10 telemetry: `nvidia-smi`/NVML report GPU memory as "Not Supported" (unified memory) — memory comes from `/proc/meminfo` (MemAvailable). `power.draw` is GPU-only. nvidia-smi temperature reads 8–15 °C below ACPI thermal zones; show both.
- Updates: `apt dist-upgrade` + `fwupdmgr` then reboot; no rollback. GX10 firmware has community reports of bricking — staged rollouts and approval gates matter.
- Serving: NIM / vLLM / SGLang / Ollama all expose OpenAI-compatible APIs. Likely future gateway: LiteLLM (keys, routing, usage).
- Brand: NVIDIA Green `#76B900`, used as an accent on black/dark grey. NVIDIA logo not used (requires written permission).

## 2. Screens & navigation

Slim icon rail (shadcn Sidebar, collapsed/icon mode) with four groups separated by dividers, plus a ⌘K command palette (shadcn Command) to jump to any node, deployment, or page. Breadcrumb header on every page.

### Fleet
- **Overview (`/`)** — KPI stat tiles: nodes online (n/12), fleet GPU utilization, unified memory used of 1.5 TB, total GPU power, gateway tokens/sec. 12-node health grid (status dot, GPU %, mem %, temp, assigned deployment; click → node). Active alerts card. Recent activity feed (updates, reboots, deploys, alerts).
- **Nodes (`/nodes`)** — list modeled on the Hyperping server list: filter chips All / Online / Degraded / Offline with counts; each row shows status dot, hostname, model (Spark FE / GX10) + OS, inline bars for GPU / Mem / Disk / Temp, last seen. Resolved/incident banner when applicable.
- **Node detail (`/nodes/$id`)** — header: hostname, model, DGX OS version, driver, UEFI, uptime, last seen, Live badge, time range toggle (1h/6h/24h/7d), action menu (Reboot, Drain, Run diagnostics, Collect L2 bundle — all mock, state-changing). Tabs:
  - **Metrics** — chart cards: GPU utilization, unified memory, GPU power, temperature (GPU vs ACPI zone, two series), CPU (user/system), network (10GbE + ConnectX-7), NVMe IO + usage.
  - **Processes** — GPU processes table (pid, user, process, engine, GPU mem).
  - **Inventory** — firmware, driver, kernel, CUDA, key packages; asset tag.
  - **Health** — L1 diag summary checks (pass/warn/fail) with timestamps.
  - **Logs** — embedded log explorer pre-filtered to `host:<id>`.

### AI Gateway
- **Endpoint (`/gateway`)** — base URL with copy button; tabbed copy-paste config snippets for Claude Code, Codex CLI, OpenCode, Cursor, VS Code. Live req/s, latency p50/p95, TTFT chart. Routing table: model name → deployment → replicas/nodes → health.
- **Deployments (`/deployments`)** — table/cards: model, engine (vLLM / Ollama / NIM / SGLang), nodes (chips; clustered groups shown as linked chips with a CX-7 link icon), replicas, status, tokens/sec, context length. "Deploy model" Sheet: choose model, engine, nodes (single or group); creates a deployment that transitions Pending → Loading → Serving in the simulator.
- **Usage (`/usage`)** — tokens in/out and requests over time (stacked by model or by key toggle), top agents/keys table, "equivalent cloud API cost" estimate tile.
- **API Keys (`/keys`)** — list (name, prefix, created, last used, rate limit, requests 24h); create (Dialog, reveal once) and revoke.

### Observe
- **Logs (`/logs`)** — modeled on the reference log explorer: query bar with `key:value` and `-exclude` syntax highlighting and `/` focus shortcut; time range 15m/1h/24h/7d; List/Visualize toggle; Live toggle. Stacked histogram by level (Error/Warn/Info/Debug) with incident bands annotated. Table: time (ms), level badge, source, host, message (monospace, truncation). Row click opens detail pane (Sheet on right): level + timestamp + source header, up/down navigation with "n / total", actions Lines around / Copy for AI / Same pattern, Message block, Fields table, Attributes table with inline `// annotations`. Log sources: journald, gateway access, inference engine (vLLM/Ollama/NIM), kernel (incl. NVRM Xid).
- **Alerts (`/alerts`)** — active incidents (title, severity, node, started, duration, status) with an incident detail Sheet (timeline, related logs). Rules list (enable toggle): node offline, GPU temp > threshold, Xid error, disk > 90%, gateway 5xx rate, update failed.

### Maintain
- **Updates (`/updates`)** — per-node pending updates (apt count, firmware via fwupd, DGX OS target version, reboot required). Rings: Canary (1), Ring 1 (3), Ring 2 (8). Rollout composer: select target version/packages → ring order → maintenance window → approval gate → start. Rollout progress view per node with precheck / apply / reboot / postcheck steps. GX10 nodes show a firmware caution badge. History table of past rollouts.
- **Settings (`/settings`)** — fleet connection (SSH user, key path, host list — display only), gateway settings (base URL, default model), log retention, theme toggle (dark default / light), simulator controls (inject failure: node offline, gateway errors, Xid storm).

## 3. Visual system

- **Theme:** dark-first; light theme available.
  - App canvas: rounded near-black window (`#0A0B0A`) floating on a dark backdrop with a subtle green/charcoal radial gradient (the reference's "glass frame", recolored).
  - Surfaces `#111311` / `#171A17`; hairline borders `rgb(255 255 255 / 0.08)`.
- **Accent:** NVIDIA Green `#76B900` (hover `#8CD600`) for active nav, focus rings, primary buttons, Live dot, selected tabs/toggles. Never a large fill.
- **Data colors (fixed per metric across the app):** GPU = green, CPU = teal, memory = violet, power/temp = amber. Log levels: Error `#F2545B`, Warn `#F5A524`, Info `#5B7CFA`, Debug neutral grey. All validated for contrast in both themes.
- **Type:** Inter (UI) + JetBrains Mono (numbers, logs, hostnames, code); `font-variant-numeric: tabular-nums` on live values.
- **Brand mark:** original spark/chip glyph + "SparkMan" wordmark. No NVIDIA logo.
- **Icons:** Lucide.
- **Components:** shadcn/ui — Sidebar, Card, Table, Tabs, Badge, Sheet, Command, Dialog, ToggleGroup, Tooltip, Progress, DropdownMenu, Switch, Input, Skeleton, Sonner, Chart.
- **Motion:** restrained. Live values tween; new log rows fade in; shadcn default Sheet/Dialog transitions; honor `prefers-reduced-motion`.

## 4. Architecture

### Layout
```
src/
  api/
    types.ts          domain types (Node, MetricSample, Deployment, ApiKey, LogLine, Incident, AlertRule, UpdatePlan, Rollout, SparkToolEnvelope, ...)
    client.ts         SparkManClient interface + React context provider
    mock/
      rng.ts          seeded PRNG
      fixtures.ts     static fleet definition (12 nodes, deployments, keys, rules)
      simulator.ts    tick-driven fleet world (2 s), history generation, actions
      logs.ts         log line generator with incident windows
      mock-client.ts  MockClient implements SparkManClient
  routes/             TanStack Router file-based routes
  features/<screen>/  screen components + query hooks
  components/ui/      shadcn-generated
  components/         AppRail, CommandMenu, PageHeader, MetricChart, StatTile, NodeStatusDot, TimeRangeToggle, LiveBadge, UsageBar
  lib/                format.ts (bytes, watts, °C, durations, relative time), colors.ts, utils.ts (cn)
```

### Data flow
- UI components never import mock code. All data flows through TanStack Query hooks → `SparkManClient`.
- `SparkManClient` exposes request methods (`listNodes`, `getNode`, `getMetrics(nodeId, range)`, `listDeployments`, `createDeployment`, `queryLogs(query, range)`, `listIncidents`, `startRollout`, …) and `subscribe(stream, callback) → unsubscribe` for live streams (node metrics, gateway stats, logs). This mirrors a future SSE/WebSocket backend.
- Phase 2 swaps `MockClient` for `HttpClient` in a single provider line.

### Mock simulator
- Seeded PRNG → reproducible fleet across reloads.
- **Fleet:** `spark-01`…`spark-08` (DGX Spark Founders Edition), `gx10-01`…`gx10-04` (ASUS GX10). Each: 128 GB unified memory, 20-core Grace CPU, 4 TB NVMe (GX10 variants 1–2 TB), 10GbE + ConnectX-7.
- **Workloads:**
  - 2-node vLLM group (`spark-01`+`spark-02`) serving a large coding model.
  - 4-node group (`gx10-01`…`gx10-04`) as an experiment cluster.
  - Remaining 6 nodes run single-node models across vLLM / Ollama / NIM.
- **Scripted state:**
  - One node degraded: thermal throttling plus a prior Xid error, reflected in alerts and logs.
  - One node has pending updates and a reboot required.
- **Metrics:** driven by workload (gateway traffic → GPU util → power → temp), with noise and a diurnal pattern. 7 days of history at downsampled resolution for 24h/7d ranges; 2 s live ticks.
- **Logs:** generated per source with realistic messages; incident windows correlate with alerts.
- **Envelopes:** inventory/health/update data wrapped in the Spark manageability JSON envelope shape.
- **Actions mutate state and emit toasts + activity entries:** reboot (node goes offline → back), drain, deploy, revoke key, start rollout (steps progress over ~30–60 s), toggle rule.
- **Failure injection** via Settings: node offline, gateway 5xx, Xid storm.

### Error handling
Every query renders loading (Skeleton), empty, and error states. Error states are reachable through failure injection.

## 5. Testing
- **Vitest:** simulator determinism (same seed → same fleet), metric bounds (0–100 %, memory ≤ 128 GB), log generator incident alignment, format helpers.
- **Playwright smoke:**
  - Visit every route; assert it renders and the console is free of errors.
  - Interactions: open a node detail, open the log detail pane and navigate, open the ⌘K palette, create and revoke an API key, start a rollout and see progress.
- **Screenshots:** dark and light screenshots of key pages for visual review.

## 6. Out of scope (phase 1)
Real SSH/telemetry collection, real OpenAI-compatible gateway/proxy, authentication, server-side persistence (only `localStorage` for settings/theme), full mobile layout (desktop first; reasonable down to tablet width).

## 7. Future phases (not designed here)
1. Python control-plane backend wrapping the Spark manageability tools over SSH + a lightweight metrics collector (nvidia-smi + /proc/meminfo + thermal zones).
2. Gateway via LiteLLM (or equivalent) fronting vLLM/Ollama/NIM, with keys and usage feeding the Usage screen.
3. Log shipping (journald → Loki/Vector or similar) feeding the Logs screen.
4. Update orchestration via `spark_updatectl.py` rings.
