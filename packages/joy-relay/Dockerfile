# joy relay — one container, one relay.
#
#   docker build -t joy-relay packages/joy-relay
#   docker run -d --name joy-relay -p 3105:3105 -v joy-relay-data:/data \
#     -e JOY_RELAY_ACCESS_KEY=… joy-relay
#
# The relay speaks plain HTTP; put TLS in front of it (Caddy does this on the
# relay box). Its whole state is the /data volume: the PGlite database, the
# token secret and attachments, in /data/relay — one level in, because the
# relay keeps its lock file BESIDE its data directory (relay.lock.db). Other settings come from JOY_RELAY_* env:
# JOY_RELAY_ACCESS_KEY (perimeter gate), JOY_RELAY_TOKEN_ISSUERS,
# JOY_RELAY_TRUST_PROXY (set it when a proxy sits in front), JOY_RELAY_DOCS_TOKEN.
FROM node:22-slim

ENV NODE_ENV=production \
    JOY_RELAY_HOST=0.0.0.0 \
    JOY_RELAY_PORT=3105 \
    JOY_RELAY_DATA_DIR=/data/relay

WORKDIR /app

# One dependency (PGlite, WebAssembly — nothing to compile), installed from
# the package's own manifest so the image does not need the monorepo.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.mjs ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3105

# The capabilities probe is unauthenticated, but a gated relay still wants its
# perimeter key on every request — send it when one is set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const k=process.env.JOY_RELAY_ACCESS_KEY;fetch('http://127.0.0.1:'+(process.env.JOY_RELAY_PORT||3105)+'/joy/v2/capabilities',{headers:k?{'x-joy-relay-key':k}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
