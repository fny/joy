# API

joy has two HTTP surfaces you can program against: the daemon's local API on each machine, and the relay's `/joy/v2` API. This page explains what each one is for, how to authenticate, where to find the full, generated reference, and when the CLI or the MCP server is the better tool. It is an orientation, not a list of every route: both servers publish their own OpenAPI document.

## Which surface to use

| You want to… | Use |
|---|---|
| Script sessions on the machine you are on | The [`joy` CLI](cli.md). It wraps the daemon's local API and handles waiting, turn attribution and exit codes. |
| Let an agent anywhere drive your whole account | The [MCP server](mcp.md). |
| Build a local tool against one machine's daemon | The daemon's local API. |
| Build a new client for the whole account | The relay API, plus the app's encryption. See [What the relay can read](#what-the-relay-can-read). |

## The daemon's local API

Every machine's daemon serves an HTTP API on the loopback interface only.

- **Address:** `http://127.0.0.1:<port>`. The port is 4997 unless the `PORT` environment variable says otherwise. The running daemon's actual port is in `daemon.json` (see below).
- **Host check:** the daemon answers only requests addressed to `localhost`, `127.0.0.1` or `::1`. This blocks web pages that try to reach it through DNS rebinding.
- **Token:** requests that change something (`POST`, `PUT`, `PATCH`, `DELETE`) must carry the header `X-Joy-Token: <token>`. The token is created fresh each time the daemon starts and written to `~/.joy/relays/<host>_<port>/state/daemon.json`, a file only your user can read. Read requests are not token-checked; they rely on the loopback binding and the host check.
- **Docs:** open `http://127.0.0.1:4997/docs?token=<token>` in a browser for the rendered reference, or fetch `GET /openapi.json` for the document itself. Both accept the token as the `X-Joy-Token` header, a bearer token, or the `?token=` query parameter.

Read the token and port from `daemon.json`:

```bash
state=~/.joy/relays/relay.example.com_4997/state/daemon.json
port=$(jq -r .port "$state")
token=$(jq -r .token "$state")

curl -s "http://127.0.0.1:$port/v2/sessions" | jq '.sessions[0]'
curl -s -X POST "http://127.0.0.1:$port/v2/sessions/1a2b3c4d/abort" -H "X-Joy-Token: $token"
```

### Two route families

- **The operation catalog** (`/status`, `/sessions`, `/send`, `/sessions/:id/check`, `/sessions/:id/queue`, `/sessions/:id/events` and more) is what the CLI calls.
- **The machine surface under `/v2/`** is what the app reaches through the relay: sessions, the queue, approvals, files and git status, harness descriptions (`/v2/harnesses`, with each agent's models, config and usage limits), usage, and the sealed environment store.

The OpenAPI document covers both. Two useful routes:

- `GET /sessions/:id/check` answers whether a session is idle, busy, waiting on input, or ended, and what it is waiting on.
- `GET /sessions/:id/events?follow=1` streams the session's records as newline-delimited JSON. The first line is `{ "hello": true, "seq": <n> }`; each later line is `{ "seq", "at", "record" }`. Add `after=<seq>` to resume or `last=<n>` to start with the most recent records.

### Reaching a daemon from elsewhere

The daemon never listens on a public interface. Your devices reach it through the relay: the app seals each request with the machine's key, the relay forwards the sealed bytes to the daemon's connection, and the daemon unseals it and runs it against its local API. The relay cannot read or change these requests. The MCP server uses the same path.

## The relay API

The relay serves its API under `/joy/v2` on the relay's origin, for example `https://relay.example.com:4997/joy/v2`. It covers:

- **Accounts and pairing:** signing in with an account key, and pairing new devices and machines.
- **Sessions:** creating sessions, the durable message queue, cancellation, and each session's event log, including a server-sent events stream of changes (`/joy/v2/events/stream`).
- **Machines:** registration, sealed machine metadata, and the sealed tunnel to each machine's daemon (`/joy/v2/machines/:id/http`).
- **Everything else the app syncs:** attachments, account settings, automations and their runs, and push notification tokens.
- **The daemon lane:** the lease and claim endpoints daemons use to pick up work. Clients do not call these.

Authentication:

- Most routes need `Authorization: Bearer <token>`, the token a device gets when it signs in or pairs.
- A relay whose operator has closed its perimeter also needs `X-Joy-Relay-Key: <key>` on every request. The app and the daemon derive this key from your account, so you normally never type it.
- `GET /joy/v2/capabilities` needs neither. It identifies the server as a joy relay and reports its protocol version; clients use it to check a URL before trusting it.

The relay's own reference is at `https://relay.example.com:4997/docs?token=<docs token>`, with the OpenAPI document at `/openapi.json?token=<docs token>`. The docs token is set by the relay's operator (`JOY_RELAY_DOCS_TOKEN`); see [Self-hosting](../getting-started/self-hosting.md).

## What the relay can read

joy is end-to-end encrypted: your devices and your machines encrypt content before it reaches the relay, and only they hold the keys. So most payloads on the relay API are ciphertext:

- **Sealed:** message text, agent output and tool calls, session metadata such as titles and folders, session keys, machine metadata, account settings, automation specs, attachments, and every request and response through the machine tunnel.
- **Visible to the relay:** ids, timestamps, sizes, which machine owns which session, session and turn states (queued, running, finished), and the text of push notifications, which travel through Apple and Google in plain text.

A client of the relay API must therefore implement joy's key handling and sealing to read or write anything useful. The app's source (`packages/joy-app`) is the reference implementation. For most automation, the CLI or the MCP server does this for you.

See [Security](security.md) for the full model.

## Related

- [CLI reference](cli.md)
- [MCP server](mcp.md)
- [Scripting and agents](../guides/scripting-and-agents.md)
- [Security](security.md)
- [Self-hosting](../getting-started/self-hosting.md)
