FROM docker.io/library/node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends tmux git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER node
WORKDIR /repo/packages/joy-daemon
CMD ["node", "--import", "tsx", "src/server.ts"]
