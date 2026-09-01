#!/usr/bin/env bash
# One-command redeploy of the joy relay box (joy.voltai.party): rsync the
# joy-relay package + infra files, then run bootstrap.sh remotely.
# Idempotent — safe to rerun any time.
#
#   packages/joy-relay/infra/deploy.sh          # full: STABLE + DEV
#   packages/joy-relay/infra/deploy.sh dev      # DEV relay only — rsync
#                                               # ~/joy-relay-dev + restart it;
#                                               # stable untouched
#
# Env overrides: JOY_RELAY_HOST (default ubuntu@joy.voltai.party),
# JOY_RELAY_SSH_KEY (default ~/.ssh/joy.voltai.party).
set -euo pipefail

HOST="${JOY_RELAY_HOST:-ubuntu@joy.voltai.party}"
KEY="${JOY_RELAY_SSH_KEY:-$HOME/.ssh/joy.voltai.party}"
SSH="ssh -i $KEY"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TARGET="${1:-all}"

# Gated ports need the perimeter key for the health probe once it's set on
# the box (joy-relay.env).
relay_key() { $SSH "$HOST" 'grep -s "^JOY_RELAY_ACCESS_KEY=" ~/joy-relay.env | cut -d= -f2-' || true; }
probe() { # port
  local port="$1" hdr=()
  [[ -n "${RELAY_KEY:-}" ]] && hdr=(-H "x-joy-relay-key: $RELAY_KEY")
  curl -fsS --max-time 10 "${hdr[@]}" "https://joy.voltai.party:$port/joy/v1/capabilities" | grep -q '"joy-relay"'
}

if [[ "$TARGET" == "dev" ]]; then
  echo "== DEV relay only: rsync + restart joy-relay-dev (stable untouched) =="
  rsync -az --delete -e "$SSH" --exclude=node_modules --exclude=package-lock.json --exclude=infra --exclude=data \
    "$ROOT/packages/joy-relay/" "$HOST":joy-relay-dev/
  $SSH "$HOST" 'cd ~/joy-relay-dev && npm install --omit=dev --no-audit --no-fund --silent && mkdir -p ~/joy-relay-data/dev && sudo systemctl restart joy-relay-dev.service && sleep 1 && sudo systemctl is-active joy-relay-dev'
  RELAY_KEY="$(relay_key)"
  probe 14997 && echo "https://joy.voltai.party:14997 OK" || { echo "14997 FAILED" >&2; exit 1; }
  exit 0
fi

echo "== rsync joy-relay package -> $HOST:~/joy-relay + ~/joy-relay-dev =="
rsync -az --delete -e "$SSH" --exclude=node_modules --exclude=package-lock.json \
  "$ROOT/packages/joy-relay/" "$HOST":joy-relay/
# Dev gets the same code on a FULL deploy; day-to-day dev iteration goes
# through `deploy.sh dev`, which touches only this copy.
rsync -az --delete -e "$SSH" --exclude=node_modules --exclude=package-lock.json --exclude=infra --exclude=data \
  "$ROOT/packages/joy-relay/" "$HOST":joy-relay-dev/

echo "== bootstrap =="
$SSH "$HOST" 'bash ~/joy-relay/infra/bootstrap.sh'

echo "== verify =="
RELAY_KEY="$(relay_key)"
for port in 4997 14997; do
  ok=""
  for _ in $(seq 6); do
    if probe "$port"; then ok=1; break; fi
    sleep 2
  done
  if [[ -n "$ok" ]]; then
    echo "https://joy.voltai.party:$port OK"
  else
    echo "https://joy.voltai.party:$port FAILED (unit down, or security group not open?)" >&2
    exit 1
  fi
done
