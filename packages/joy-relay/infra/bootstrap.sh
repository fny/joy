#!/usr/bin/env bash
# Idempotent bootstrap for the joy relay box (joy.voltai.party).
# Run as ubuntu with sudo (deploy.sh does both the rsync and this). Assumes
# the joy-relay package (including these infra files, at ~/joy-relay/infra)
# was rsynced to ~/joy-relay and ~/joy-relay-dev.
#
# Edge layout: 4997 = Joy Relay (STABLE), 14997 = Joy Relay Dev.
# 80/443/1443 are DISABLED: ufw allows only 22 + the two relay ports;
# certbot renews through a pre/post-hook punch-hole on :80 (the EC2 security
# group must keep 22, 80, 4997, 14997 allowed — 80 stays ufw-closed outside
# renewals).
set -euo pipefail

INFRA=~/joy-relay/infra

echo "== packages =="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy curl fail2ban certbot ufw > /dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - > /dev/null
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs > /dev/null
fi
node -v; caddy version | head -1

echo "== fail2ban =="
sudo cp "$INFRA/jail.local" /etc/fail2ban/jail.local
sudo systemctl enable --now fail2ban > /dev/null
sudo systemctl restart fail2ban

echo "== certs =="
sudo mkdir -p /etc/joy-relay
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

echo "== relay deps + data dirs =="
# Each instance needs its own node_modules (pglite) and a data dir OUTSIDE
# the checkout (deploy rsyncs with --delete; data must survive).
(cd ~/joy-relay && npm install --omit=dev --no-audit --no-fund --silent)
(cd ~/joy-relay-dev && npm install --omit=dev --no-audit --no-fund --silent)
mkdir -p ~/joy-relay-data/stable ~/joy-relay-data/dev

echo "== units =="
sudo cp "$INFRA/joy-relay.service" /etc/systemd/system/
sudo cp "$INFRA/joy-relay-dev.service" /etc/systemd/system/
sudo cp "$INFRA/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable joy-relay.service joy-relay-dev.service > /dev/null 2>&1 || true
sudo systemctl restart joy-relay.service joy-relay-dev.service caddy
sleep 2
sudo systemctl is-active joy-relay joy-relay-dev caddy fail2ban | tr '\n' ' '; echo

echo "== firewall =="
# 22 first — never lock ourselves out. 80/443/1443 are intentionally absent.
sudo ufw allow OpenSSH > /dev/null
sudo ufw allow 4997/tcp > /dev/null
sudo ufw allow 14997/tcp > /dev/null
sudo ufw delete allow 24997/tcp > /dev/null 2>&1 || true
sudo ufw default deny incoming > /dev/null
sudo ufw default allow outgoing > /dev/null
sudo ufw --force enable > /dev/null
sudo ufw status numbered

echo "== bootstrap complete =="
