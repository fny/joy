# Self-hosting a relay

The relay is the one server in a joy setup. It holds accounts, the list of machines, each session's message queue, and push notification delivery. It stores only encrypted data it cannot read. This page shows how to run your own with Podman or plain Node, put TLS in front of it, protect it with an access key, back it up, and upgrade it.

## What you need

- A server reachable from both your phone and your machines. A small cloud VM is plenty: the relay is one Node process with an embedded database and one dependency.
- A domain name pointing at it, such as `relay.example.com`, and a TLS certificate. The app and the daemon connect over HTTPS.
- [Podman](https://podman.io), or Node.js 22 or newer. The container examples use Podman; Docker takes the same `build`, `run` and `compose` commands with `docker` in place of `podman` and no `--format` flag.

The relay speaks plain HTTP. Always run it behind a TLS-terminating proxy; the examples below use [Caddy](https://caddyserver.com), which gets certificates for you.

## Choose a docs password

The relay serves a description of its API at `/docs`, and it will not start until you either give that page a password or turn it off. Generate a password:

```bash
openssl rand -base64 18
```

Use it as `JOY_RELAY_DOCS_TOKEN` in the examples below. If you do not want the docs page at all, set `JOY_RELAY_DOCS=off` instead. With neither, the relay exits at once and its log says why:

```
[joy-relay] refusing to start: JOY_RELAY_DOCS_TOKEN is not set. …
```

## Run it with Podman

Build the image from a checkout of the repository:

```bash
podman build --format docker -t joy-relay packages/joy-relay
```

`--format docker` keeps the image's health check; Podman's default image format drops it. Then run it:

```bash
podman run -d --name joy-relay \
  -p 127.0.0.1:3105:3105 \
  -v joy-relay-data:/data \
  -e JOY_RELAY_DOCS_TOKEN=<your docs password> \
  joy-relay
```

The container listens on port 3105, keeps all state in the `joy-relay-data` volume, and runs as an unprivileged user. Publishing the port on `127.0.0.1` keeps it private to the host, so only your proxy can reach it. `podman stop joy-relay` shuts it down cleanly in under a second.

A container started with `podman run` does not come back after a reboot. To keep the relay running, use a Quadlet unit instead.

## Keep it running with systemd

Podman's Quadlet turns a small file into a systemd service. This runs rootless, as your user.

Put your settings in `~/.config/joy-relay/relay.env`, and keep the file private:

```bash
mkdir -p ~/.config/joy-relay
printf 'JOY_RELAY_DOCS_TOKEN=%s\n' "$(openssl rand -base64 18)" > ~/.config/joy-relay/relay.env
chmod 600 ~/.config/joy-relay/relay.env
```

Create `~/.config/containers/systemd/joy-relay.container`:

```ini
[Unit]
Description=joy relay

[Container]
Image=localhost/joy-relay
PublishPort=127.0.0.1:3105:3105
Volume=joy-relay-data:/data
EnvironmentFile=%h/.config/joy-relay/relay.env

[Service]
Restart=always

[Install]
WantedBy=default.target
```

Start it, and let it run while you are logged out:

```bash
systemctl --user daemon-reload
systemctl --user start joy-relay
loginctl enable-linger $USER
journalctl --user -u joy-relay -f     # should show "[joy-relay] listening 0.0.0.0:3105"
```

Run Caddy on the host in front of it, as in [Put TLS in front](#put-tls-in-front).

## Run it with Podman Compose and Caddy

This runs the relay and a Caddy proxy together, with Caddy fetching and renewing the TLS certificate. You need `podman compose`, which uses `podman-compose` or `docker-compose` if either is installed. Point your domain's DNS at the server and open ports 80 and 443 first; Caddy needs port 80 to prove it owns the domain.

Rootless Podman cannot bind ports below 1024. Allow it once, as root:

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/90-unprivileged-ports.conf
sudo sysctl --system
```

In a new directory, create `Caddyfile`:

```
relay.example.com {
    reverse_proxy relay:3105
}
```

Create `.env` with your settings, and keep it private (`chmod 600 .env`):

```
JOY_RELAY_DOCS_TOKEN=<your docs password>
JOY_RELAY_ACCESS_KEY=
```

Create `compose.yaml`, with `context` pointing at the relay package in your checkout:

```yaml
services:
  relay:
    build:
      context: /path/to/joy/packages/joy-relay
    restart: always
    env_file: .env
    environment:
      JOY_RELAY_TRUST_PROXY: "1"
    volumes:
      - relay-data:/data

  caddy:
    image: docker.io/library/caddy:2
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro,Z
      - caddy-data:/data
    depends_on:
      - relay

volumes:
  relay-data:
  caddy-data:
```

Start it:

```bash
podman compose up -d
podman compose logs relay     # should end with "[joy-relay] listening 0.0.0.0:3105"
```

The relay is then at `https://relay.example.com`. To bring both containers back after a reboot, enable Podman's restart service once: `systemctl --user enable podman-restart.service`, plus `loginctl enable-linger $USER`.

Leave `JOY_RELAY_ACCESS_KEY` empty for now; [Protect the relay with an access key](#protect-the-relay-with-an-access-key) explains how to fill it in once you have paired a machine. `JOY_RELAY_TRUST_PROXY=1` tells the relay that Caddy terminates TLS for it, so its API docs name your `https://` address; Caddy reaches it over the Compose network rather than loopback, where the relay would work that out on its own. The `Z` on the Caddyfile mount lets the container read it on SELinux hosts and does nothing elsewhere.

## Run it with Node

```bash
cd packages/joy-relay
npm install --omit=dev

JOY_RELAY_DATA_DIR=/var/lib/joy-relay/data \
JOY_RELAY_DOCS_TOKEN=<your docs password> \
node server.mjs
```

Always set `JOY_RELAY_DATA_DIR` when running outside a container. Run the relay under a process supervisor such as systemd so it restarts after a crash or reboot.

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
| `JOY_RELAY_HOST` | `127.0.0.1` (`0.0.0.0` in the container image) | Address to bind. Keep the default when a proxy runs on the same host. |
| `JOY_RELAY_DATA_DIR` | `/data/relay` in the container image | Where the database, token secret, and attachments live. |
| `JOY_RELAY_ACCESS_KEY` | unset (open) | Perimeter key every request must carry. See below. |
| `JOY_RELAY_TOKEN_SECRET` | generated on first start | Secret that signs device sign-in tokens. When unset, the relay creates one and saves it as `token.secret` in the data directory. |
| `JOY_RELAY_TOKEN_ISSUERS` | `joy` | Comma-separated issuer names the relay accepts on tokens; the first one is used for new tokens. Leave it alone unless you are migrating. |
| `JOY_RELAY_DOCS_TOKEN` | none, **required** | Password for the relay's API documentation page. The relay refuses to start without it unless `JOY_RELAY_DOCS=off`. |
| `JOY_RELAY_DOCS` | on | Set to `off` to serve no API documentation. Then no docs password is needed, and `/docs` answers 404. |
| `JOY_RELAY_MAX_EVENTS_PER_SESSION` | unset (no limit) | Cap each session's stored history at this many events. A session that reaches it stops saving output and refuses new messages, and its owner is told to continue in a new session. Leave it unset unless you need to bound disk use on a shared relay. |
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

The machine-readable version is at `/openapi.json` with the same token. When an access key is set, these pages need it too. With `JOY_RELAY_DOCS=off`, both answer 404.

## Back it up

Everything the relay knows lives in its data directory: the database, the token secret, and uploaded attachments. To back it up:

1. Stop the relay: `podman stop joy-relay`, or `systemctl --user stop joy-relay` for a Quadlet unit.
2. Copy the data. For a volume: `podman volume export joy-relay-data > joy-relay-backup.tar`.
3. Start it again.

To restore, create an empty volume and import the archive into it (`podman volume import joy-relay-data joy-relay-backup.tar`) before starting the relay.

Only one relay process can use a data directory at a time; a second one refuses to start. A copy taken while the relay runs may be inconsistent, so stop it first or use a filesystem snapshot.

Even with the whole data directory, nobody can read your sessions without an account's backup code. That also means the relay's owner cannot recover a user's lost backup code.

## Upgrade it

```bash
git pull
podman build --format docker -t joy-relay packages/joy-relay
systemctl --user restart joy-relay          # Quadlet: picks up the new image
```

For a container started with `podman run`, remove it and run it again with the same options: `podman rm -f joy-relay`, then the `podman run` command above. With Compose, `podman compose up -d --build`.

Database changes apply automatically on start. Machines and devices reconnect by themselves within a few seconds; queued messages wait on the relay and nothing is lost.

## Related

- [Install and first run](install.md)
- [How joy works](overview.md)
- [Security and privacy](../reference/security.md)
- [API reference](../reference/api.md)
- [Troubleshooting](../reference/troubleshooting.md)
