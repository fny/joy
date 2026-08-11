#!/usr/bin/env bash
# One-command redeploy of the joy relay box (joy.voltai.party): rsync the
# build context + joy-relay package + infra files, then run bootstrap.sh
# remotely. Idempotent — safe to rerun any time.
#
#   packages/joy-relay/infra/deploy.sh
#
# Env overrides: JOY_RELAY_HOST (default ubuntu@joy.voltai.party),
# JOY_RELAY_SSH_KEY (default ~/.ssh/joy.voltai.party).
set -euo pipefail

HOST="${JOY_RELAY_HOST:-ubuntu@joy.voltai.party}"
KEY="${JOY_RELAY_SSH_KEY:-$HOME/.ssh/joy.voltai.party}"
SSH="ssh -i $KEY"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "== rsync build context -> $HOST:~/relay-src =="
# The happy-server image build needs the REAL monorepo root: root
# package.json + lockfile + .npmrc + patches + scripts (postinstall applies
# patches and builds happy-wire) — see Containerfile.happy.
# --delete-excluded: relay-src is a strict mirror of the include list — stale
# paths that fall out of it (e.g. the old /infra) must not linger in the box's
# build context.
rsync -az --delete --delete-excluded -e "$SSH" \
  --include='/package.json' --include='/pnpm-lock.yaml' \
  --include='/pnpm-workspace.yaml' --include='/.npmrc' \
  --include='/patches/***' --include='/scripts/***' \
  --include='/packages/' --include='/packages/happy-server/***' \
  --include='/packages/happy-wire/***' \
  --exclude='node_modules' --exclude='*' \
  "$ROOT/" "$HOST":relay-src/

echo "== rsync joy-relay package -> $HOST:~/joy-relay =="
rsync -az --delete -e "$SSH" --exclude=node_modules \
  "$ROOT/packages/joy-relay/" "$HOST":joy-relay/

echo "== bootstrap =="
$SSH "$HOST" 'bash ~/joy-relay/infra/bootstrap.sh'

echo "== verify =="
# The happy-server container takes ~30s to boot after the restart — retry
# rather than declaring a 502 a failure.
for port in 4997 14997; do
  ok=""
  for _ in $(seq 12); do
    if curl -fsS --max-time 10 "https://joy.voltai.party:$port/" 2>/dev/null | grep -q 'Welcome to Happy Server!'; then
      ok=1; break
    fi
    sleep 5
  done
  if [[ -n "$ok" ]]; then
    echo "https://joy.voltai.party:$port OK"
  else
    echo "https://joy.voltai.party:$port FAILED (container still down, or security group not open?)" >&2
    exit 1
  fi
done
