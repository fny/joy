#!/usr/bin/env bash
# E2E prod-mirror stack: the EXACT prod topology on one box, fully isolated.
#
#   joy-app (web :8082) ─┐
#   joy-daemon ──────────┼──▶ joy-relay :3105 ──proxy──▶ happy-server :3005 (pglite)
#   joy CLI / v2 mode ───┘         │
#                                  └─ native /joy/v1 + /joy/v2 (PGlite)
#
# Nothing here touches the live daemon on this box (different ports, homes,
# tmux sockets) and nothing reaches any remote server.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
E2E_HOME="${JOY_E2E_HOME:-$HOME/.joy-e2e}"
HAPPY_PORT=3005
RELAY_PORT=3105
mkdir -p "$E2E_HOME/logs" "$E2E_HOME/happy-data" "$E2E_HOME/relay-data"

pidfile() { echo "$E2E_HOME/$1.pid"; }

is_up() { [ -f "$(pidfile "$1")" ] && kill -0 "$(cat "$(pidfile "$1")")" 2>/dev/null; }

start_happy() {
  is_up happy && { echo "happy-server already up ($(cat "$(pidfile happy)"))"; return; }
  port_free $HAPPY_PORT || { echo "port $HAPPY_PORT busy but no pidfile — kill the stray listener first (ss -tlnp | grep $HAPPY_PORT)" >&2; return 1; }
  ( cd "$REPO/packages/happy-server" || exit 1
    export DB_PROVIDER=pglite
    export PGLITE_DIR="$E2E_HOME/happy-data/pglite"
    export DATA_DIR="$E2E_HOME/happy-data"
    export HANDY_MASTER_SECRET=joy-e2e-local-master-secret
    export PORT=$HAPPY_PORT NODE_ENV=development METRICS_ENABLED=false
    npx tsx ./sources/standalone.ts migrate >"$E2E_HOME/logs/happy-migrate.log" 2>&1 || exit 1
    # setsid: pidfile holds a PROCESS GROUP leader, so stop kills npx AND the
    # tsx server it spawned (killing just npx orphaned the listener).
    setsid nohup npx tsx ./sources/standalone.ts serve >"$E2E_HOME/logs/happy-server.log" 2>&1 &
    echo $! >"$(pidfile happy)" )
  echo "happy-server starting on :$HAPPY_PORT (pid $(cat "$(pidfile happy)"))"
}

port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }

start_relay() {
  is_up relay && { echo "joy-relay already up ($(cat "$(pidfile relay)"))"; return; }
  port_free $RELAY_PORT || { echo "port $RELAY_PORT busy but no pidfile — kill the stray listener first (ss -tlnp | grep $RELAY_PORT)" >&2; return 1; }
  ( cd "$REPO/packages/joy-relay" && \
    JOY_RELAY_PORT=$RELAY_PORT \
    JOY_RELAY_UPSTREAM_HOST=127.0.0.1 JOY_RELAY_UPSTREAM_PORT=$HAPPY_PORT \
    JOY_RELAY_DATA_DIR="$E2E_HOME/relay-data" \
    setsid nohup node server.mjs >"$E2E_HOME/logs/joy-relay.log" 2>&1 & \
    echo $! >"$(pidfile relay)" )
  echo "joy-relay starting on :$RELAY_PORT (pid $(cat "$(pidfile relay)"))"
}

wait_healthy() {
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$RELAY_PORT/joy/v1/capabilities" >/dev/null 2>&1 \
       && curl -fsS -o /dev/null "http://127.0.0.1:$RELAY_PORT/" 2>/dev/null; then
      echo "stack healthy: relay native + proxy path answering"
      return 0
    fi
    sleep 1
  done
  echo "stack failed to become healthy — check $E2E_HOME/logs/" >&2
  return 1
}

stop_one() {
  if [ -f "$(pidfile "$1")" ]; then
    kill -- -"$(cat "$(pidfile "$1")")" 2>/dev/null || kill "$(cat "$(pidfile "$1")")" 2>/dev/null || true
  fi
  rm -f "$(pidfile "$1")"
}

kill_port() { fuser -k "$1"/tcp 2>/dev/null || true; }

case "${1:-}" in
  start) start_happy; start_relay; wait_healthy ;;
  stop) stop_one relay; stop_one happy; echo stopped ;;
  status)
    for s in happy relay; do is_up "$s" && echo "$s: up ($(cat "$(pidfile "$s")"))" || echo "$s: down"; done ;;
  reset)
    stop_one relay; stop_one happy
    kill_port $RELAY_PORT; kill_port $HAPPY_PORT; sleep 1
    rm -rf "$E2E_HOME/happy-data" "$E2E_HOME/relay-data"
    echo "state wiped ($E2E_HOME)" ;;
  *) echo "usage: stack.sh start|stop|status|reset"; exit 2 ;;
esac
