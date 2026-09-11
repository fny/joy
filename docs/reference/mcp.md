# MCP server

joy-mcp is a remote MCP server that acts as a full client of one joy account. Connect it to the Claude app, Claude Code, or any MCP client, and that client can see every session on every machine, send messages, wait for replies, answer approvals and start new sessions: the same things you do in the joy app. This page covers what it is, how to connect to it, what it offers, and how to run it beside your own relay.

## What it is

The relay stores only ciphertext. To read a session, joy-mcp must hold the keys the app holds, so it is a paired client of your account, just like a phone. It runs next to the relay, shares its origin, and talks to your machines the way the app does: through the relay's queue and the sealed connection to each machine's daemon.

It serves these paths on the relay's origin:

```text
https://relay.example.com/mcp                                   the MCP endpoint (Streamable HTTP)
https://relay.example.com/.well-known/oauth-protected-resource/mcp
https://relay.example.com/.well-known/oauth-authorization-server
https://relay.example.com/authorize  /token  /register  /revoke  OAuth 2.1 with dynamic client registration
```

Anyone who connects acts as the account's owner. Treat a joy-mcp token like your backup code.

## Connecting

### From the Claude app

1. Open Settings, then Connectors, and add a custom connector with the URL `https://relay.example.com/mcp`.
2. The sign-in page asks for your account backup code. joy-mcp checks it and does not store it.

### From Claude Code or a script

Mint a bearer token on the machine where joy-mcp runs, then add the server with that token:

```bash
joy-mcp token new claude-code
claude mcp add --transport http joy https://relay.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

Manage tokens with:

```bash
joy-mcp token ls                  # hash, type, client name, issued, expiry
joy-mcp token rm <hash prefix>    # at least 4 characters from token ls
```

## Tools

Every tool that takes a `session` accepts the eight-character joy session id, the relay's session id, or a unique prefix.

| Tool | What it does |
|---|---|
| `list_sessions` | Every session on every machine, newest first, with machine, folder, title and state. Archived and headless sessions are left out unless asked for. |
| `session` | One session: status, pending approvals, the queue, and the conversation, paged backwards with `before`. |
| `check` | The state to decide on before sending: `idle`, `busy`, `needs_input`, `ended` or `unreachable`, with what it waits on. |
| `send` | Deliver text through the queue. If a turn is running, the text waits behind it. `no_queue` refuses instead. |
| `ask` | Send, wait for that message's turn, and return its reply. |
| `wait_for_turns` | Block until any watched session finishes a turn, needs input, or ends. With no sessions named, it watches the whole account. |
| `updates_since` | The same events as a page from a cursor, for clients that poll. |
| `events` | The raw records behind a conversation: text, tool calls, turn lifecycle, usage. |
| `approvals` | Approvals the agent holds for a human, oldest first. |
| `approve`, `deny` | Answer the oldest approval, or a named one. |
| `abort` | Interrupt the running turn. Queued messages survive and run next. |
| `queue` | The messages waiting behind the running turn, and whether the queue is paused. |
| `queue_cancel` | Drop one queued message by its turn id. |
| `queue_resume` | Release a queue the daemon paused. |
| `kill` | End the session and its terminal window. |
| `machines` | The machines on the account, and which agents, models and permission modes each can run. |
| `new_session` | Start a session in a folder on a machine, optionally with a first message. Creates the folder unless `create_dir: false`. |

Outcomes match the CLI: `answered`, `needs_input`, `timeout`, `gone`, `error`. `ask` and `wait_for_turns` wait 45 seconds by default and return a resumable `timeout`. Chain `wait_for_turns` calls by passing the previous result's `cursor` as `since`.

## Resources

| Resource | Contents |
|---|---|
| `joy://sessions` | All sessions. |
| `joy://sessions/{id}` | One session. |
| `joy://sessions/{id}/state` | One session's state. |
| `joy://machines` | The machines on the account. |

Subscribe to a session's resource to get a `resources/updated` notification when its turn ends, when it needs input, or when it ends.

## How messages are stamped

By default, text you send through joy-mcp goes in as the account owner's own message, exactly as if you typed it in the app. The agent's next turn is the reply.

With `reply_to: "joy:<id>"`, the text is delivered as a peer message instead:

```text
<joy-message from="mcp:<client>" reply-to="joy:1a2b3c4d">
…your text…
</joy-message>
```

`<client>` is the name of the token or the OAuth client. The agent then answers by sending to the session named in `reply-to`. See [Scripting and agents](../guides/scripting-and-agents.md).

## Running it beside your own relay

joy-mcp lives in `packages/joy-mcp` in the joy repository. Install its dependencies on the relay machine, pair it with your account, and serve it.

```bash
cd packages/joy-mcp
npm install --omit=dev

# Pair: approve from the joy app (it shows a QR code and a link) …
node cli.mjs pair --relay https://relay.example.com:4997
# … or pair with the account backup code.
node cli.mjs pair --relay https://relay.example.com:4997 --secret <backup code>

node cli.mjs status     # relay, account, machines and sessions it can see

JOY_MCP_PUBLIC_URL=https://relay.example.com node cli.mjs serve
```

| Variable | Effect |
|---|---|
| `JOY_MCP_PUBLIC_URL` | Required for `serve`: the origin clients connect to, such as `https://relay.example.com`. |
| `JOY_MCP_PORT` | The local port. Default 3107. |
| `JOY_MCP_HOME` | Where credentials, tokens and registered OAuth clients are kept. Owner-only. |
| `JOY_RELAY_URL` | The relay, if you omit `--relay` when pairing. |
| `JOY_RELAY_ACCESS_KEY` | The relay's perimeter key, for a gated relay. |

Then route the joy-mcp paths from your TLS proxy to that port, and everything else to the relay. With Caddy:

```text
relay.example.com {
    @mcp path /mcp /mcp/* /authorize /authorize/* /token /register /revoke /.well-known/oauth-* /healthz
    handle @mcp {
        reverse_proxy 127.0.0.1:3107
    }
    handle {
        reverse_proxy 127.0.0.1:3105
    }
}
```

Run `serve` under a service manager so it restarts. The pairing keeps its credentials and renews its own bearer.

## Related

- [CLI reference](cli.md)
- [Scripting and agents](../guides/scripting-and-agents.md)
- [Self-hosting](../getting-started/self-hosting.md)
- [Security](security.md)
