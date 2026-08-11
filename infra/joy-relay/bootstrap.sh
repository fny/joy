#!/usr/bin/env bash
# Idempotent bootstrap for the joy relay box (joy.voltai.party).
# Run as ubuntu with sudo. Assumes: repo build context rsynced to ~/relay-src,
# joy-relay package rsynced to ~/joy-relay, infra files in ~/relay-src/infra/joy-relay.
set -euo pipefail

echo "== packages =="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq podman caddy curl > /dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - > /dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs > /dev/null
fi
node -v; podman --version; caddy version | head -1

echo "== secrets =="
sudo mkdir -p /etc/joy-relay
if ! sudo test -f /etc/joy-relay/happy.env; then
  echo "HANDY_MASTER_SECRET=$(openssl rand -hex 32)" | sudo tee /etc/joy-relay/happy.env > /dev/null
  echo "PORT=3005" | sudo tee -a /etc/joy-relay/happy.env > /dev/null
  sudo chmod 600 /etc/joy-relay/happy.env
  echo "happy.env created"
fi
if ! sudo test -f /etc/joy-relay/pg.env; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" | sudo tee /etc/joy-relay/pg.env > /dev/null
  sudo chmod 600 /etc/joy-relay/pg.env
  echo "pg.env created"
fi

echo "== happy-server image =="
cd ~/relay-src
sudo podman build -q -f infra/joy-relay/Containerfile.happy -t localhost/happy-server:latest . 

echo "== quadlets + units =="
sudo mkdir -p /etc/containers/systemd
sudo cp infra/joy-relay/happy-server.container /etc/containers/systemd/
sudo cp infra/joy-relay/postgres.container /etc/containers/systemd/
sudo cp infra/joy-relay/joy-relay.service /etc/systemd/system/
sudo cp infra/joy-relay/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl restart happy-server.service postgres.service joy-relay.service caddy
sleep 3
sudo systemctl is-active happy-server joy-relay caddy postgres | tr '\n' ' '; echo
echo "== bootstrap complete =="
