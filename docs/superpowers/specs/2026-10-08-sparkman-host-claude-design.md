# SparkMan — Talk to Claude Code on the host

**Date:** 2026-10-08 · **Status:** design approved in conversation

## Intent
From the SparkMan UI, chat with Claude Code running **on the SparkMan host itself** (not the Spark nodes), with the same permission modes Claude Code offers. Single operator, reached over their tailnet.

## Decisions
| Topic | Decision |
|---|---|
| Interface | Chat panel ("Claude" page in the rail): streaming markdown, collapsible tool cards, Approve/Deny cards, session list, Stop. |
| Permissions | Mode picker mirroring Claude Code: `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`; switchable mid-session; Bypass needs a confirm. |
| Access | Server binds `127.0.0.1`; published with `tailscale serve` (HTTPS on the tailnet name). Requests carrying `Tailscale-User-Login` must match `SPARKMAN_ALLOWED_USERS` (fail closed if unset). Requests without the header are accepted only from loopback (on-host use). |
| Engine | `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode (one live query per chat → `setPermissionMode`, `interrupt`), `systemPrompt` preset `claude_code`, user/project/local settings, host's existing Claude Code credentials, `includePartialMessages` for token streaming, `canUseTool` → UI approval. |
| Persistence | Per-session normalized event log (JSONL) + session index under `SPARKMAN_DATA_DIR` (default `~/.sparkman`). Page reload replays events; after a server restart a session resumes via the SDK `resume` option. |
| Deployment | One Node process (`server/`, Hono) serves the API and the built SPA. Fleet data stays simulated. |

## Wire protocol (server → browser)
SSE stream of `{ seq, ts, event }` where `event` is one of: `session` (cwd, model, mode, version), `user`, `text_delta` (live only, not persisted), `assistant_text`, `tool_use`, `tool_result`, `permission_request`, `permission_resolved`, `mode`, `status` (idle/running), `turn_end` (cost, duration, isError), `error`. Subagent (`parent_tool_use_id`) traffic is not shown.

HTTP: `GET/POST /api/agent/sessions`, `GET /api/agent/sessions/:id` (summary + persisted events), `GET …/:id/stream?after=<seq>` (SSE), `POST …/:id/messages`, `POST …/:id/permissions/:requestId`, `POST …/:id/mode`, `POST …/:id/interrupt`, `GET /api/agent/health`.

## Testing
The query function is injected. A scripted fake agent (`SPARKMAN_AGENT_FAKE=1`) emits deterministic SDK-shaped messages (streamed text, a Bash call that asks permission, a result with cost) for unit tests and Playwright; the e2e web server is this server in fake mode serving the built SPA. One manual smoke against real Claude Code.

## Out of scope
Multiple users, file browser/terminal, image paste, MCP/config UI, model picker.
