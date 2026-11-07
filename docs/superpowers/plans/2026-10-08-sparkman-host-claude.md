# Host Claude Panel — Implementation Plan (compact)

Spec: `docs/superpowers/specs/2026-10-08-sparkman-host-claude-design.md`. Executed inline by the controller (user asked for speed: no per-task review loop; one review at the end).

1. **Shared protocol** — `src/agent/protocol.ts`: `AgentMode`, `AgentEvent` union, `EventEnvelope`, `SessionSummary`, request bodies. No SDK import (UI-safe).
2. **Session engine** — `server/agent/`: async input queue; `AgentSession` (lazy `query()` start, SDK→event normalizer, permission broker via `canUseTool`, `setMode`, `interrupt`, subscribers, JSONL log); `SessionStore` (index + replay + resume). Unit tests with an injected fake query.
3. **Fake agent** — `server/agent/fake-query.ts`: scripted SDK-shaped messages honoring mode + `canUseTool`.
4. **HTTP server** — `server/index.ts` + `server/app.ts` (Hono): tailnet auth middleware, routes, SSE, static `dist/` with SPA fallback. Unit tests for auth + routes via `app.request()`.
5. **UI** — `src/agent/agent-api.ts`, `reduce-events.ts` (+ unit test), `use-agent-session.ts`; `src/features/agent/*` (page, session list, transcript, tool card, permission card, mode picker, composer); route `/agent`; rail item "Claude". Markdown via `react-markdown` + `remark-gfm`.
6. **Wiring** — Vite dev proxy `/api/agent` → `127.0.0.1:4100`; scripts `server`, `server:fake`, `start`; `tsconfig.server.json`; Playwright web server = fake-mode server serving the build; e2e `agent.spec.ts`; README (tailscale serve + env).
7. **Verify** — unit, build, full e2e, one real Claude Code smoke; one whole-feature review.
