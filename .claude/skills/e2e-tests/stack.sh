#!/usr/bin/env bash
# E2E prod-mirror stack: the EXACT prod topology on one box, fully isolated.
#
#   joy-app (web :8082) ─┐
#   joy-daemon ──────────┼──▶ joy-relay :3105 (PGlite: accounts, machines,
#   joy CLI / actors ────┘                     push, /joy/v1 + /joy/v2 plane)
#
# The relay is the only server. Nothing here touches the live daemon on this
# box (different ports, homes, tmux sockets) and nothing reaches any remote
# server.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
E2E_HOME="${JOY_E2E_HOME:-$HOME/.joy-e2e}"
RELAY_PORT=3105
mkdir -p "$E2E_HOME/logs" "$E2E_HOME/relay-data"

pidfile() { echo "$E2E_HOME/$1.pid"; }
is_up() { [ -f "$(pidfile "$1")" ] && kill -0 "$(cat "$(pidfile "$1")")" 2>/dev/null; }
port_free() { ! ss -tln 2>/dev/null | grep -q ":$1 "; }

start_relay() {
  is_up relay && { echo "joy-relay already up ($(cat "$(pidfile relay)"))"; return; }
  port_free $RELAY_PORT || { echo "port $RELAY_PORT busy but no pidfile — kill the stray listener first (ss -tlnp | grep $RELAY_PORT)" >&2; return 1; }
  ( cd "$REPO/packages/joy-relay" && \
    JOY_RELAY_PORT=$RELAY_PORT \
    JOY_RELAY_DATA_DIR="$E2E_HOME/relay-data" \
    JOY_RELAY_TOKEN_SECRET=joy-e2e-local-token-secret \
    setsid nohup node server.mjs >"$E2E_HOME/logs/joy-relay.log" 2>&1 & \
    echo $! >"$(pidfile relay)" )
  echo "joy-relay starting on :$RELAY_PORT (pid $(cat "$(pidfile relay)"))"
}

wait_healthy() {
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$RELAY_PORT/joy/v1/capabilities" >/dev/null 2>&1; then
      echo "stack healthy: relay answering on :$RELAY_PORT"
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
  start) start_relay; wait_healthy ;;
  stop) stop_one relay; echo stopped ;;
  status) is_up relay && echo "relay: up ($(cat "$(pidfile relay)"))" || echo "relay: down" ;;
  reset)
    stop_one relay
    kill_port $RELAY_PORT; sleep 1
    rm -rf "$E2E_HOME/relay-data"
    echo "state wiped ($E2E_HOME)" ;;
  *) echo "usage: stack.sh start|stop|status|reset"; exit 2 ;;
esac
