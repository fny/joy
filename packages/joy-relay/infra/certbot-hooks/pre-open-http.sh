#!/bin/sh
# certbot pre-hook: LE HTTP-01 needs :80, which ufw keeps closed — open it
# only for the renewal window (post-hook closes it). The EC2 security group
# must keep 80 allowed; ufw is the day-to-day gate.
if ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp
fi
