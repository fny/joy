#!/usr/bin/env bash
# Idempotent bootstrap for the joy relay box (joy.voltai.party).
# Run as ubuntu with sudo (deploy.sh does both the rsync and this). Assumes:
# repo build context rsynced to ~/relay-src, joy-relay package rsynced to
# ~/joy-relay, infra files in ~/relay-src/infra/joy-relay.
#
# Edge layout: 4997 = joy-relay (PRIMARY), 14997 = happy-server direct.
# 80/443/1443 are DISABLED: ufw allows only 22/4997/14997; certbot renews
# through a pre/post-hook punch-hole on :80 (the EC2 security group must keep
# 22, 80, 4997, 14997 allowed — 80 stays ufw-closed outside renewals).
set -euo pipefail

INFRA=~/relay-src/infra/joy-relay

echo "== packages =="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq podman caddy curl fail2ban certbot ufw > /dev/null
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

echo "== fail2ban =="
sudo cp "$INFRA/jail.local" /etc/fail2ban/jail.local
sudo systemctl enable --now fail2ban > /dev/null
sudo systemctl restart fail2ban

echo "== certs =="
sudo install -D -m 755 "$INFRA/certbot-hooks/pre-open-http.sh" /etc/letsencrypt/renewal-hooks/pre/open-http.sh
sudo install -D -m 755 "$INFRA/certbot-hooks/post-close-http.sh" /etc/letsencrypt/renewal-hooks/post/close-http.sh
sudo install -D -m 755 "$INFRA/certbot-hooks/deploy-caddy.sh" /etc/letsencrypt/renewal-hooks/deploy/caddy.sh
if ! sudo test -d /etc/letsencrypt/live/joy.voltai.party; then
  # First issuance: certbot standalone needs :80 free (final caddy config
  # never binds it, but stop caddy in case an older config is running).
  sudo /etc/letsencrypt/renewal-hooks/pre/open-http.sh
  sudo systemctl stop caddy 2>/dev/null || true
  sudo certbot certonly --standalone -d joy.voltai.party \
    --non-interactive --agree-tos -m faraz.yashar@gmail.com
  sudo /etc/letsencrypt/renewal-hooks/post/close-http.sh
fi
# (Re)install the cert where caddy can read it, even if certbot didn't run.
sudo /etc/letsencrypt/renewal-hooks/deploy/caddy.sh

echo "== happy-server image =="
cd ~/relay-src
sudo podman build -q -f infra/joy-relay/Containerfile.happy -t localhost/happy-server:latest .

echo "== quadlets + units =="
sudo mkdir -p /etc/containers/systemd
sudo cp "$INFRA/happy-server.container" /etc/containers/systemd/
sudo cp "$INFRA/postgres.container" /etc/containers/systemd/
sudo cp "$INFRA/joy-relay.service" /etc/systemd/system/
sudo cp "$INFRA/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl restart happy-server.service postgres.service joy-relay.service caddy
sleep 3
sudo systemctl is-active happy-server joy-relay caddy postgres fail2ban | tr '\n' ' '; echo

echo "== firewall =="
# 22 first — never lock ourselves out. 80/443/1443 are intentionally absent.
sudo ufw allow OpenSSH > /dev/null
sudo ufw allow 4997/tcp > /dev/null
sudo ufw allow 14997/tcp > /dev/null
sudo ufw default deny incoming > /dev/null
sudo ufw default allow outgoing > /dev/null
sudo ufw --force enable > /dev/null
sudo ufw status numbered

echo "== bootstrap complete =="
