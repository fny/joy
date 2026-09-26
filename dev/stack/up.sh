#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
web=$(realpath "${1:?Usage: up.sh EXPORTED_WEB_DIRECTORY}")
port=${JOY_TEST_PORT:-3210}
bind=${JOY_TEST_BIND:-0.0.0.0}
node_image=docker.io/library/node:22-slim
test -f "$web/index.html"
test -f "$web/pocket/worker.js"
test -d "$repo/node_modules"
podman network exists joy-pocket || podman network create joy-pocket
podman volume exists joy-pocket-relay-data || podman volume create joy-pocket-relay-data
common=(--init --network joy-pocket --security-opt label=disable --security-opt no-new-privileges --cap-drop ALL --user node --pull never)
if ! podman container exists joy-pocket-relay; then
  podman run -d --name joy-pocket-relay "${common[@]}" \
    -v "$repo:/repo:ro" -v joy-pocket-relay-data:/data:U \
    -w /repo/packages/joy-relay \
    -e JOY_RELAY_HOST=0.0.0.0 -e JOY_RELAY_PORT=3105 \
    -e JOY_RELAY_DATA_DIR=/data/relay -e JOY_RELAY_DOCS=off \
    -e JOY_RELAY_TRUST_PROXY=1 "$node_image" node server.mjs
else
  podman start joy-pocket-relay >/dev/null
fi
if ! podman container exists joy-pocket-web; then
  tls_args=()
  if [[ -n "${JOY_TEST_TLS_DIR:-}" ]]; then
    tls_dir=$(realpath "$JOY_TEST_TLS_DIR")
    test -f "$tls_dir/server.crt"
    test -f "$tls_dir/server.key"
    # Only the leaf key enters the container; the CA signing key stays outside.
    podman secret create --replace joy-pocket-tls-key "$tls_dir/server.key" >/dev/null
    tls_args=(-p "$bind:${JOY_TEST_HTTPS_PORT:-3443}:8443"
      --secret joy-pocket-tls-key,uid=1000,gid=1000,mode=0400
      -v "$tls_dir/server.crt:/run/joy-server.crt:ro"
      -e TLS_CERT=/run/joy-server.crt -e TLS_KEY=/run/secrets/joy-pocket-tls-key)
  fi
  podman run -d --name joy-pocket-web "${common[@]}" \
    "${tls_args[@]}" \
    -p "$bind:$port:8080" -v "$web:/web:ro" \
    -v "$repo/dev/stack/gateway.mjs:/gateway.mjs:ro" \
    -e "ALLOWED_HOSTS=agent-01,localhost,127.0.0.1,100.121.220.10,agent-01.taile7098d.ts.net${JOY_TEST_VM_IP:+,$JOY_TEST_VM_IP}" \
    "$node_image" node /gateway.mjs
else
  podman start joy-pocket-web >/dev/null
fi
# Image construction installs OS dependencies; do that separately with approval.
if podman image exists localhost/joy-pocket-daemon:dev; then
  podman volume exists joy-pocket-daemon-home || podman volume create joy-pocket-daemon-home
  if ! podman container exists joy-pocket-daemon; then
    agent_args=()
    if [[ -n "${JOY_TEST_CODEX_BIN:-}" ]]; then
      agent_args=(-v "$(realpath "$JOY_TEST_CODEX_BIN"):/usr/local/bin/codex:ro")
    fi
    podman run -d --name joy-pocket-daemon "${common[@]}" \
      -v "$repo:/repo:ro" -v joy-pocket-daemon-home:/home/node:U \
      "${agent_args[@]}" \
      -e JOY_HOME_DIR=/home/node/.joy -e JOY_RELAY_URL=http://joy-pocket-relay:3105 \
      localhost/joy-pocket-daemon:dev
  else
    podman start joy-pocket-daemon >/dev/null
  fi
else
  echo 'Daemon image not built yet. Web and relay are running.'
fi
printf 'Joy: http://agent-01:%s (Voice on a remote browser requires HTTPS)\n' "$port"
if [[ -n "${JOY_TEST_TLS_DIR:-}" ]]; then
  printf 'Direct HTTPS: https://agent-01:%s (trust the local CA in your browser first)\n' "${JOY_TEST_HTTPS_PORT:-3443}"
  if [[ -n "${JOY_TEST_VM_IP:-}" ]]; then
    printf 'From the VM host: https://%s:%s\n' "$JOY_TEST_VM_IP" "${JOY_TEST_HTTPS_PORT:-3443}"
  fi
fi
