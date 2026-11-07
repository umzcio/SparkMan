# Notes for AI agents working on this fleet

- **Installing or serving a model**: follow `docs/playbooks/model-install.md` step by step, with its checks.
- **This site's specifics** (hosts, models library, node groups, fabric addresses, recipe folders, where credentials
  live, hardware quirks): `/etc/sparkman/site-notes.md` on the SparkMan host. Read it first. It is deliberately not
  in this repository; never copy hostnames, addresses or personal details into the repo.
- **Ground rules**: ask before installing system packages, using sudo beyond a playbook's prerequisites, rebooting,
  or stopping a model or container you didn't start. Never delete model weights or other data. Don't run test suites
  or benchmarks unless asked; type-checking and building are fine. Never print secrets.
- **SparkMan itself**: `pnpm -s typecheck` and `pnpm -s build` after a change; restart the `sparkman` service only —
  `sparkman-gateway` carries clients' in-flight requests.
