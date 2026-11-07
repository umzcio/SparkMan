# SparkMan — follow-ups after the phase-1 UI prototype

Deferred from the final whole-branch review (feat/ui-prototype).

## Next iteration (prototype polish)
- **History is recomputed from current state.** Stopping a deployment, rebooting a node or revoking a key changes past charts/logs/usage. Fix: per-timestamp membership (deployment active between createdAt/stoppedAt, replica reachable via `isOffline(outages, id, t)`, key between createdAt/revokedAt) in `src/api/mock/metrics.ts`, `logs.ts`, `simulator.ts`.
- Drain only changes a badge (routing/load ignore `drained`); disabled alert rules still fire for injected failures; rollout reboot step shows "Offline" instead of "Rebooting"; "ongoing" durations freeze between refetches.
- Small spec gaps: node header lacks UEFI/FQDN; logs table shows Service not Source; Usage has no requests-over-time chart; live values don't tween; rollout composer can't change target/ring order.
- Snippets name the server default model even if it isn't served while others are; rejected rollouts show "—" for Started/Duration.

## Phase-2 prerequisites (before a real HttpClient / Python backend)
- UI hard-codes backend facts: rollout target `7.5.0`, ring sizes and "4 GX10" (`rollout-sheet.tsx`), 110 GB usable per node (`deployments/fit.ts`), $3/$15 pricing (`usage-page.tsx`). Source them from `listNodeUpdates`, the catalog, and `UsageReport`.
- Mutation hooks rely on simulator `changed` events for cache invalidation; a real client needs `onSuccess` invalidation or guaranteed server-sent change events.
- Document the client contract in `src/api/client.tsx`: `getNode` resolves `null` on 404 while other methods reject; `subscribe` must emit `changed` after mutations; errors carry `message`. Move `FleetConfig` to `types.ts`; rename `ClientEvent` away from `SimEvent`.
- Verify agent snippets against current tool versions (Codex `wire_api = "chat"` vs `/v1/responses`; Cursor can't reach `.local` URLs).

## Host Claude — SDK feature set (2026-10-09)

- Fork: `resumeDropsTurn` is not passed, so the CLI's fork-point validation is off; a fork whose resume is refused keeps `forkAt` and retries the same point. Decide whether to pass it and clear `forkAt` on refusal.
- Rewind / fork inside a fork: whether the forked transcript keeps the parent's user-message uuids (and file checkpoints) is unverified, so "Rewind" on inherited messages may report "No file checkpoint".
- Messages queued while a turn runs may be merged into one turn and get no checkpoint of their own (the rewind dialog says so).
- Idle Claude Code processes close after 10 minutes (`SessionDeps.idleMs`); capabilities, context, usage and MCP views restart one on demand. Consider caching the init result so read-only views don't start a process at all.
- Not exposed from the browser by design: `updateSettings`, MCP OAuth / elicitation (shown as "needs auth"), sandbox config.
