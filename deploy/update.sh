#!/usr/bin/env bash
# Pull the latest SparkMan, rebuild and restart the service(s).
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
if [ "$(id -u)" -eq 0 ]; then
  # restart the console; the gateway only when its code changed would be nicer, but it restarts in ~2 s
  systemctl restart sparkman sparkman-gateway
  systemctl --no-pager status sparkman sparkman-gateway | grep -E "●|Active:"
else
  systemctl --user restart sparkman
  systemctl --user --no-pager status sparkman | head -5
fi
