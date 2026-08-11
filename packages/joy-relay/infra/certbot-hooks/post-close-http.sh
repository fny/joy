#!/bin/sh
# certbot post-hook: close the :80 punch-hole opened by the pre-hook.
if ufw status | grep -q "Status: active"; then
    ufw delete allow 80/tcp
fi
