# Self-hosting a relay

The relay is the one server in a joy setup. It holds accounts, the list of machines, each session's message queue, and push notification delivery. It stores only encrypted data it cannot read. This page shows how to run your own with Docker or plain Node, put TLS in front of it, protect it with an access key, back it up, and upgrade it.

## What you need

- A server reachable from both your phone and your machines. A small cloud VM is plenty: the relay is one Node process with an embedded database and one dependency.
- A domain name pointing at it, such as `relay.example.com`, and a TLS certificate. The app and the daemon connect over HTTPS.
- Docker, or Node.js 22 or newer.

The relay speaks plain HTTP. Always run it behind a TLS-terminating proxy; the examples below use [Caddy](https://caddyserver.com), which gets certificates for you.

## Run it with Docker

From a checkout of the repository:

```bash
docker build -t joy-relay packages/joy-relay

docker run -d --name joy-relay --restart unless-stopped \
  -p 127.0.0.1:3105:3105 \
  -v joy-relay-data:/data \
  -e JOY_RELAY_DOCS_TOKEN=choose-a-docs-password \
  joy-relay
```

The image listens on port 3105, keeps all state in the `/data` volume, runs as an unprivileged user, and has a built-in health check. Publishing the port on `127.0.0.1` keeps it private to the host, so only your proxy can reach it.

## Run it with Node

```bash
cd packages/joy-relay
npm install --omit=dev

JOY_RELAY_DATA_DIR=/var/lib/joy-relay/data \
JOY_RELAY_DOCS_TOKEN=choose-a-docs-password \
node server.mjs
```

Always set `JOY_RELAY_DATA_DIR` when running outside Docker. Run the relay under a process supervisor such as systemd so it restarts after a crash or reboot.

## Put TLS in front

A minimal Caddyfile that serves the relay on the standard HTTPS port:

```
relay.example.com {
    reverse_proxy 127.0.0.1:3105
}
```

Caddy obtains and renews the certificate. You can also serve it on another port, such as `relay.example.com:4997 { … }`, and give people that address.

The relay streams live updates to web clients with server-sent events. Caddy passes these through without extra configuration. If you use another proxy, turn off response buffering for the relay.

## Settings

The relay reads its settings from environment variables.

| Variable | Default | What it does |
|---|---|---|
| `JOY_RELAY_PORT` | `3105` | Port to listen on. |
| `JOY_RELAY_HOST` | `127.0.0.1` (`0.0.0.0` in the Docker image) | Address to bind. Keep the default when a proxy runs on the same host. |
| `JOY_RELAY_DATA_DIR` | `/data/relay` in the Docker image | Where the database, token secret, and attachments live. |
| `JOY_RELAY_ACCESS_KEY` | unset (open) | Perimeter key every request must carry. See below. |
| `JOY_RELAY_TOKEN_SECRET` | generated on first start | Secret that signs device sign-in tokens. When unset, the relay creates one and saves it as `token.secret` in the data directory. |
| `JOY_RELAY_TOKEN_ISSUERS` | `joy` | Comma-separated issuer names the relay accepts on tokens; the first one is used for new tokens. Leave it alone unless you are migrating. |
| `JOY_RELAY_DOCS_TOKEN` | a built-in value | Password for the relay's API documentation page. Set your own. |
| `JOY_RELAY_TRUST_PROXY` | automatic | `1` to always trust `X-Forwarded-Proto` from your proxy, `0` never. Affects only the server address shown in the API documentation. |

Keep `token.secret` (or `JOY_RELAY_TOKEN_SECRET`) with your backups. If it is lost or changed, every device and machine has to sign in again.

## Protect the relay with an access key

With no access key, anyone who can reach your relay can create an account on it and use it. The data they store is encrypted and separate from yours, but it is your server. To make the relay private, set `JOY_RELAY_ACCESS_KEY`. Every request without the right key is then refused.

The simplest key to use is the one joy derives from your own backup code, because your devices then send it without being told:

1. Pair a machine with `joy auth relay.example.com`. It prints a line starting with `relay perimeter key`. That value is your key.
2. Set `JOY_RELAY_ACCESS_KEY` to that value on the relay and restart it.
3. Your paired machines keep working: the daemon derived the same key from your backup code when you paired it.
4. Your signed-in devices keep working: the app derives it too.

A new device that has not signed in yet cannot derive the key. When you enter the relay address on its welcome screen, the app detects the protected relay and asks for the **Relay access key**. Enter the same value.

If several people share one relay, each account derives a different key, so give them the configured key directly. They can enter it in the app under **Settings → Account** with the lock icon on the relay row (**Relay password**), and set `JOY_RELAY_ACCESS_KEY` in their daemon's environment.

## Check that it is up

The relay answers an unauthenticated probe:

```bash
curl https://relay.example.com/joy/v2/capabilities
```

A healthy relay returns JSON that includes `"relay": "joy-relay"`. When an access key is set, add `-H "x-joy-relay-key: <your key>"`; without it the probe returns 401, which also tells you the relay is up.

## API documentation

The relay serves its own API reference at:

```
https://relay.example.com/docs?token=<JOY_RELAY_DOCS_TOKEN>
```

The machine-readable version is at `/openapi.json` with the same token. When an access key is set, these pages need it too.

## Back it up

Everything the relay knows lives in its data directory: the database, the token secret, and uploaded attachments. To back it up:

1. Stop the relay (`docker stop joy-relay`).
2. Copy the data directory or volume.
3. Start it again.

Only one relay process can use a data directory at a time; a second one refuses to start. A copy taken while the relay runs may be inconsistent, so stop it first or use a filesystem snapshot.

Even with the whole data directory, nobody can read your sessions without an account's backup code. That also means the relay's owner cannot recover a user's lost backup code.

## Upgrade it

```bash
git pull
docker build -t joy-relay packages/joy-relay
docker stop joy-relay && docker rm joy-relay
docker run -d --name joy-relay … joy-relay   # same options as before
```

Database changes apply automatically on start. Machines and devices reconnect by themselves within a few seconds; queued messages wait on the relay and nothing is lost.

## Related

- [Install and first run](install.md)
- [How joy works](overview.md)
- [Security and privacy](../reference/security.md)
- [API reference](../reference/api.md)
- [Troubleshooting](../reference/troubleshooting.md)
