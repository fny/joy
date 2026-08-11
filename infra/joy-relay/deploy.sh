#!/usr/bin/env bash
# One-command redeploy of the joy relay box (joy.voltai.party): rsync the
# build context + joy-relay package + infra files, then run bootstrap.sh
# remotely. Idempotent — safe to rerun any time.
#
#   infra/joy-relay/deploy.sh
#
# Env overrides: JOY_RELAY_HOST (default ubuntu@joy.voltai.party),
# JOY_RELAY_SSH_KEY (default ~/.ssh/joy.voltai.party).
set -euo pipefail

HOST="${JOY_RELAY_HOST:-ubuntu@joy.voltai.party}"
KEY="${JOY_RELAY_SSH_KEY:-$HOME/.ssh/joy.voltai.party}"
SSH="ssh -i $KEY"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "== rsync build context -> $HOST:~/relay-src =="
# The happy-server image build needs the REAL monorepo root: root
# package.json + lockfile + .npmrc + patches + scripts (postinstall applies
# patches and builds happy-wire) — see Containerfile.happy.
rsync -az --delete -e "$SSH" \
  --include='/package.json' --include='/pnpm-lock.yaml' \
  --include='/pnpm-workspace.yaml' --include='/.npmrc' \
  --include='/patches/***' --include='/scripts/***' \
  --include='/infra/***' \
  --include='/packages/' --include='/packages/happy-server/***' \
  --include='/packages/happy-wire/***' \
  --exclude='node_modules' --exclude='*' \
  "$ROOT/" "$HOST":relay-src/

echo "== rsync joy-relay package -> $HOST:~/joy-relay =="
rsync -az --delete -e "$SSH" --exclude=node_modules \
  "$ROOT/packages/joy-relay/" "$HOST":joy-relay/

echo "== bootstrap =="
$SSH "$HOST" 'bash ~/relay-src/infra/joy-relay/bootstrap.sh'

echo "== verify =="
for port in 4997 14997; do
  if curl -fsS --max-time 10 "https://joy.voltai.party:$port/" | grep -q 'Welcome to Happy Server!'; then
    echo "https://joy.voltai.party:$port OK"
  else
    echo "https://joy.voltai.party:$port FAILED (security group not open yet?)" >&2
  fi
done
