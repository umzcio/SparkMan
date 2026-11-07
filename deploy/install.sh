#!/usr/bin/env bash
# Install SparkMan on an Ubuntu host.
# Run from the repo as the account whose Claude Code / Codex logins SparkMan should use:
#   ./deploy/install.sh          as a normal user: systemd user service, settings in ~/.config/sparkman
#   sudo ./deploy/install.sh     as root: system service, settings in /etc/sparkman
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }

command -v node >/dev/null || { echo "Node.js 22+ is required (https://nodejs.org or nvm)."; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22+ is required (found $(node -v))."; exit 1; }
if ! command -v pnpm >/dev/null; then
  say "Enabling pnpm via corepack"
  corepack enable pnpm 2>/dev/null || { echo "Install pnpm 10: npm i -g pnpm"; exit 1; }
fi
PNPM="$(command -v pnpm)"

say "Installing dependencies"
pnpm install --frozen-lockfile
say "Building the UI"
pnpm build

if [ "$(id -u)" -eq 0 ]; then
  mkdir -p /etc/sparkman /var/lib/sparkman
  ENV_FILE=/etc/sparkman/sparkman.env
  if [ ! -f "$ENV_FILE" ]; then
    sed -e "s#^SPARKMAN_AGENT_CWD=.*#SPARKMAN_AGENT_CWD=/root#" -e "s#^SPARKMAN_DATA_DIR=.*#SPARKMAN_DATA_DIR=/var/lib/sparkman/agent#" deploy/sparkman.env.example > "$ENV_FILE"
    echo "SPARKMAN_FLEET_DB_DIR=/var/lib/sparkman" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    warn "Created $ENV_FILE"
  fi
  say "Installing the systemd system service (runs as root)"
  sed -e "s#@DIR@#$DIR#g" -e "s#@PATH@#$PATH#g" -e "s#@PNPM@#$PNPM#g" deploy/sparkman-system.service > /etc/systemd/system/sparkman.service
  sed -e "s#@DIR@#$DIR#g" -e "s#@PATH@#$PATH#g" -e "s#@PNPM@#$PNPM#g" deploy/sparkman-gateway-system.service > /etc/systemd/system/sparkman-gateway.service
  systemctl daemon-reload
  systemctl enable sparkman sparkman-gateway
  systemctl restart sparkman sparkman-gateway
  [ -f /etc/sparkman/users.json ] || warn "No accounts yet: pnpm user:set <name>  (sign-in turns on once /etc/sparkman/users.json exists)"
  [ -f /etc/sparkman/fleet.json ] || warn "No fleet config: copy deploy/fleet.example.json to /etc/sparkman/fleet.json (until then the UI runs the simulator)"
  say "SparkMan is running on http://127.0.0.1:${SPARKMAN_PORT:-4100}"
  echo "   Publish it on your tailnet:   tailscale serve --bg ${SPARKMAN_PORT:-4100}"
  echo "   and the gateway at /v1:        tailscale serve --bg --set-path /v1 http://127.0.0.1:${SPARKMAN_GATEWAY_PORT:-4200}/v1"
  echo "   Logs:                         journalctl -u sparkman -u sparkman-gateway -f"
  exit 0
fi

mkdir -p "$HOME/.config/sparkman" "$HOME/.config/systemd/user"
ENV_FILE="$HOME/.config/sparkman/sparkman.env"
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s#^SPARKMAN_AGENT_CWD=.*#SPARKMAN_AGENT_CWD=$HOME#" -e "s#^SPARKMAN_DATA_DIR=.*#SPARKMAN_DATA_DIR=$HOME/.sparkman/agent#" deploy/sparkman.env.example > "$ENV_FILE"
  warn "Created $ENV_FILE — set SPARKMAN_ALLOWED_USERS to your Tailscale login, then: systemctl --user restart sparkman"
fi

say "Installing the systemd user service"
sed -e "s#@DIR@#$DIR#g" -e "s#@PATH@#$PATH#g" -e "s#@PNPM@#$PNPM#g" deploy/sparkman.service > "$HOME/.config/systemd/user/sparkman.service"
systemctl --user daemon-reload
systemctl --user enable --now sparkman
# keep it running when you're logged out
loginctl enable-linger "$USER" 2>/dev/null || warn "Run: sudo loginctl enable-linger $USER  (so SparkMan survives logout/reboot)"

command -v claude >/dev/null || warn "Claude Code isn't on PATH — install it and run 'claude' once to log in, or the Claude page will error."
command -v codex >/dev/null || warn "Codex CLI isn't on PATH — 'npm i -g @openai/codex' then 'codex login', or the Codex page stays hidden."

say "SparkMan is running on http://127.0.0.1:${SPARKMAN_PORT:-4100}"
echo "   Publish it on your tailnet:   sudo tailscale serve --bg ${SPARKMAN_PORT:-4100}"
echo "   Logs:                         journalctl --user -u sparkman -f"
