#!/bin/sh
# certbot deploy-hook: copy the renewed cert where caddy (runs as caddy, can't
# read /etc/letsencrypt/live) can see it, then reload.
set -e
mkdir -p /etc/joy-relay/certs
install -o caddy -g caddy -m 640 /etc/letsencrypt/live/joy.voltai.party/fullchain.pem /etc/joy-relay/certs/fullchain.pem
install -o caddy -g caddy -m 640 /etc/letsencrypt/live/joy.voltai.party/privkey.pem /etc/joy-relay/certs/privkey.pem
systemctl reload caddy || systemctl restart caddy
