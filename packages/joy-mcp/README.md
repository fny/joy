# joy-mcp

A remote MCP server that is a full client of **one** joy account. It sees and
drives every session on every machine the way the app does — through the
relay's durable queue and the sealed machine tunnels — and tells a connected
agent when a turn finishes. The Claude app connects to it as a custom
connector; Claude Code and scripts connect with a bearer.

The relay stores ciphertext only, so this is a paired client holding the
account's content key and machine keys, running beside the relay on its box
and sharing its origin:

```
https://<relay host>/mcp                 the MCP endpoint (Streamable HTTP; the relay port answers too)
…/.well-known/oauth-protected-resource/mcp
…/.well-known/oauth-authorization-server
…/authorize  …/token  …/register         OAuth 2.1 with dynamic registration
```

Caddy routes those paths to this process (internal `:3107`); everything else
on the origin stays the relay's.

## Setting it up on the relay box

```sh
cd ~/joy-mcp
node cli.mjs pair --relay https://<relay host>:4997          # approve in the joy app (QR / link)
node cli.mjs pair --relay … --secret <backup code>            # or from the account backup code
sudo systemctl enable --now joy-mcp                            # serves once paired
node cli.mjs status
```

Credentials, tokens and registered OAuth clients live in `~/.joy-mcp`
(owner-only). Pairing keeps the account secret; the bearer renews itself.

## Connecting

- **Claude app** → Settings → Connectors → add `https://<relay host>/mcp`.
  The sign-in page asks for the account's backup code (checked, never stored).
- **Claude Code**: `node cli.mjs token new claude-code` prints a bearer, then
  `claude mcp add --transport http joy https://<relay host>/mcp --header "Authorization: Bearer <token>"`.

## The surface

Tools (every session tool takes `session`: the eight-character joy id, the
relay id, or a unique prefix):

| Group | Tools |
|---|---|
| orientation | `list_sessions` (all machines by default), `session` (status + approvals + queue + conversation, paged with `before`), `check` |
| talking | `send` (queues behind a running turn; returns `ahead`, the rows the relay had in front of it, and carries `check` when it did not go straight in; a `/steer` mid-turn goes over the machine tunnel), `ask` (send + wait for that turn's reply), `wait_for_turns` (until any watched session finishes or needs a human), `updates_since` (cursor paging), `events` (raw records) |
| decisions | `approvals`, `approve`, `deny` |
| control | `abort`, `queue`, `queue_cancel`, `queue_resume`, `kill` |
| creating | `machines`, `new_session` (creates a missing folder itself unless `create_dir: false`; waits up to 60 s for the daemon's session id; a spawn the daemon refused answers `spawn_failed` with the reason and the row reads `failed`) |

Resources: `joy://sessions`, `joy://sessions/{id}`, `joy://sessions/{id}/state`,
`joy://machines`. Subscribing to a session's resource gets a
`resources/updated` notification when its turn ends, it comes to need input,
or it ends; `notifications/message` carries a one-line log of the same.

Outcomes are the CLI's — `answered · needs_input · timeout · gone · error` —
and the state × action contract is the CLI's table
(`packages/joy-daemon/src/cli.matrix.oracle.ts`). A client speaks for the
account's owner: sends go in as the human's own message (unwrapped). With
`reply_to: joy:<id>` the text is delivered as a peer message
(`<joy-message from="mcp:<client>" reply-to="joy:<id>">`) the agent answers
to that session. Waits (`ask`, `wait_for_turns`) default to 45 s and return
a resumable `timeout`; chain `wait_for_turns` calls with `since` = the
previous `cursor`.

## Tests

`pnpm test` — the wire formats against the app's shapes, the state ladder and
message folding, and an end-to-end run over a real in-memory relay with a
fake daemon answering the sealed tunnel, driven by the SDK's own MCP client.
