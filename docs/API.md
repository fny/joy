# joy API reference

The two programmable surfaces: the **relay** (joy-relay, the one server the app
and daemons meet through) and the **joy-daemon** (per-machine process that owns
tmux panes and agent adapters). Maintained by hand — update this file whenever
an op is added/renamed (source of truth: `packages/joy-daemon/src/domain/operations.ts`
and `src/domain/fileOps.ts`); FEATURES.md is the companion feature map.

## Topology

```
joy-app ⇄ joy-relay (e.g. joy.voltai.party:4997, /joy/v2 over HTTPS + SSE)
              ⇄ joy-daemon (one per machine per account/relay)
                    ⇄ tmux panes: claude | codex | opencode | pi
```

- Accounts are auto-created on first `POST /joy/v2/auth` contact (ed25519
  challenge signature); one backup code works on every relay (machines
  register per-account-per-relay).
- All session/machine payloads between app and daemon are end-to-end encrypted
  (libsodium); the relay stores/forwards ciphertext. Attachment blobs are
  encrypted client-side with `deriveKey(sessionKey, 'Happy Blobs', ['session'])`
  (the label is a wire constant — renaming it would orphan every existing blob).
- The daemon also runs a **local HTTP server** (`~/.joy/daemon.json` carries
  port + bearer token) exposing the same ops over REST — that is what the
  `joy` CLI and hooks use. Wire identifiers: `joy__source: "joy-daemon"`, tag
  prefix `joy-daemon-<id>`, service unit `joy-daemon`.

## Transport forms

Every operation exists in up to three forms, generated from one table:

| Form | Carrier | Naming |
|---|---|---|
| Machine RPC | relay E2E tunnel (`POST /joy/v2/machines/:id/http`, sealed frames) | `joy-*` rpcName |
| Session RPC | relay E2E tunnel (same carrier) | bare name |
| HTTP | local daemon server | method + path below |

## Machine-readable spec

`GET /openapi.json` on the daemon's local HTTP server dumps OpenAPI 3.1
generated from the op catalog at request time (`transports/openapi.ts`) —
**requires the instance token** (X-Joy-Token header or Bearer) even though it
is a GET. Each route carries `x-rpc-name`; RPC-only ops appear under
`x-rpc-only`. Op `summary` is set everywhere; `params`/`result` JSON-Schema
annotations are incremental (permissive objects where absent).

## Machine-scope operations

| rpcName | HTTP | What |
|---|---|---|
| `joy-list-sessions` | GET /sessions | All sessions (now includes `agent` flavor per record) |
| `joy-get-session` | GET /sessions/:id | One session record |
| `joy-create-session` | POST /sessions | Spawn agent (`agent`: claude\|codex\|opencode\|pi; `resume_id`, `forkSession`, `continue`, `model`, `effort`, `permissionMode`, `yolo`, `extraArgs`; unknown agent → loud error). Claude gets `CLAUDE_CODE_ENABLE_TASKS=0` + fresh `--append-system-prompt` every spawn |
| `joy-restart-session` | POST /sessions/:id/restart | Relaunch in place |
| `joy-kill-session` | DELETE /sessions/:id | Kill one |
| `joy-kill-all-sessions` | POST /sessions/kill-all | Kill everything |
| `joy-restart-daemon` | POST /daemon/restart | Exec-restart the daemon |
| `joy-status` | GET /status | Daemon + sessions snapshot |
| `joy-notify` | POST /notify | Push notification to all devices |
| `joy-send` | POST /send | Deliver text to a session (queue-routed) |
| `joy-queue-list/add/edit/cancel/resume/reorder` | /sessions/:id/queue… | Durable dispatch queue CRUD |
| `joy-send-keys` | POST /sessions/:id/keys | Raw key tokens into the pane (escape hatch, not primary interaction) |
| `joy-set-mode` | POST /sessions/:id/mode | Permission/model/effort switches |
| `joy-pane` | GET /sessions/:id/pane | ANSI pane capture (terminal view) |
| `joy-resize` | POST /sessions/:id/resize | Drive tmux window cols/rows |
| `joy-transcript` | GET /sessions/:id/transcript | Parsed transcript slice |
| `joy-session-log` | GET /sessions/:id/log | Raw log tail |
| `joy-list-logs` / `joy-read-log` | GET /logs, /logs/messages | Past-session transcript browser (per cwd) |
| `joy-usage` | GET /usage | Cost/token report from local transcripts (persistent cache in `~/.joy/usage-cache.json`, background-warmed 2h) |
| `joy-session-usage` | GET /usage/sessions | Per-session cost rows |
| `joy-limits` | GET /limits | SERVER-truth account quota: claude 5h/weekly via local OAuth token → `api.anthropic.com/api/oauth/usage`; codex from newest rollout `rate_limits` |
| `joy-agent-config-read` | GET /agent-config/:agent | Raw + parsed agent config file |
| `joy-agent-config-set` | POST /agent-config/:agent/set | Merge JSON-path assignment lines (`a[0].b = "x"`, null deletes); `.joy-bak` backup |
| `joy-agent-config-write` | POST /agent-config/:agent | Full raw replace (must parse) |
| `joy-agent-config-schema` | GET /agent-config/:agent/schema | Fetched + cached JSON Schema (claude, opencode) |
| `joy-codex-models` / `joy-opencode-models` | GET /codex/models, /opencode/models | Model lists |
| `joy-opencode-sessions` / `joy-opencode-set-model` | GET /opencode/sessions, POST /sessions/:id/opencode/model | opencode extras |
| `joy-refresh-commands` | POST /commands/refresh | Re-scan slash commands |

## Session-scope operations

| rpcName | HTTP | What |
|---|---|---|
| `abort` | POST /sessions/:id/abort | Escape the running turn (does NOT clear the input box — see docs/pane-input-clearing.md) |
| `killSession` | (via DELETE /sessions/:id) | Session-scope kill |
| `bash` | POST /sessions/:id/bash | Run a command in cwd |
| `readFile` | POST /sessions/:id/readFile | ≤400KB inline base64; larger spills to an encrypted blob (`blobRef`) the app downloads/decrypts |
| `writeFile` | POST /sessions/:id/writeFile | Write file |
| `deleteFile` | POST /sessions/:id/deleteFile | Unlink one file (no trash). Files only — directories refused |
| `listDirectory` / `getDirectoryTree` | POST /sessions/:id/… | FS browsing |
| `ripgrep` / `difftastic` | POST /sessions/:id/… | Search / diff helpers |
| `joy-hook` | POST /sessions/:id/hook | Claude hook events (PreCompact → "compacting" status) |
| `compacting` | POST /sessions/:id/compacting | Hook-driven status flip |

## In-band slash commands (daemon-intercepted, never reach the model verbatim)

| Command | Flavors | What |
|---|---|---|
| `/title <text>` / bare `/title` | all | Set+lock / unlock the session title |
| `/steer <msg>` | claude | Immediate mid-turn delivery, bypasses the queue |
| `/btw <q>` | claude | Steers Claude Code's built-in side-question command |
| `/login-code <code>` | claude | Types an auth code into the CLI's paste prompt |
| `/joy-prompt` | all | Re-delivers the CURRENT joy instruction block in-band, framed as superseding all earlier instructions (see agentTagsPrompt.ts `joyPromptReinjection`) |

## Agent tag vocabulary (agent → app, taught via agentTagsPrompt.ts)

`<options>` picker · `<joy-img>` inline image · `<joy-file>` file chip ·
`<joy-notify>` push · `<joy-title>` retitle · `<joy-bg>` long-running process
chip (claude-only extras add plan-mode/AskUserQuestion rules).

Delivery per flavor: claude `--append-system-prompt` (rebuilt every spawn, so
continue/fork/restart always carry current wording) · codex thread
`developerInstructions` (restore now passes fresh wording too) · opencode
first-prompt preamble · pi none at launch (use `/joy-prompt`).

## Relay-level surface (joy-relay, `/joy/v2`)

joy-relay is the only server; everything lives in its embedded PGlite store
(`packages/joy-relay`, live spec at `/docs` on the relay). Bearer tokens are
EdDSA JWTs minted by the relay (`JOY_RELAY_TOKEN_SECRET`, issuers
`JOY_RELAY_TOKEN_ISSUERS`). Every path below is under `/joy/v2`:

| Area | Routes | Notes |
|---|---|---|
| Account | `POST /auth` · `GET /account/profile` | login = signed challenge over the ed25519 public key; account auto-created |
| Pairing | `POST /auth/request` (doubles as poll) · `GET /auth/request/status?publicKey=` · `POST /auth/response`; `…/auth/account/*` for the account-secret flavour | sealed response, first write wins, 24h TTL |
| Machines | `GET/POST /machines` · `GET/PATCH/DELETE /machines/:id` | POST upserts (403 `machine_owned_elsewhere`); PATCH is CAS on `metadata`/`daemonState` (`expected*Version` → `success`\|`version-mismatch`); `active`/`activeAt` derived from daemon leases |
| Push | `POST/GET /push-tokens` · `DELETE /push-tokens/:token` · `POST /push {title, body?, data?}` | relay delivers via Expo; dead tokens dropped |
| Sessions | `GET/POST /sessions` · `GET/DELETE /sessions/:id` · `GET /sessions/:id/events` · `GET /events/stream` (SSE) · `POST /sessions/:id/spawn/retry` | sealed session cards; durable queue |
| Messages / turns | `GET/POST /sessions/:id/messages` · `GET/PATCH/DELETE …/messages/:id` · `POST …/messages/:id/retry` · `GET …/turns/:id` · `POST …/turns/:id/cancellations` | server-owned queue, real cancellation |
| Attachments | `POST /attachments` · `GET /attachments/:id` | ciphertext only, deduped per session, orphan-swept |
| Tunnel | `POST /machines/:id/http` | E2E-sealed request/response frames to the daemon's local HTTP server (≈1MB frame cap → the 400KB inline file threshold) |
| Daemon lane | `POST /daemon/leases` · `PUT /daemon/leases/:id` · `…/claims/{work,control,tunnel}` · `…/deliveries/:id/received` · `…/sessions/:id/{bind,spawn-failed}` · `PATCH /daemon/sessions/:id` · `…/turns/:id/{submitted,start,facts,reconcile}` · `…/tunnel/:id/frames` | lease-token authenticated; presence = unexpired lease |

A perimeter key (`JOY_RELAY_ACCESS_KEY`, header `x-joy-relay-key`) can gate
the whole surface; unknown paths are 404 — there is no upstream.

## Background daemon behaviors (not ops)

- Usage cache warmer: boot + every 2h (`server.ts`).
- Resource alerts: RAM/disk ≥90% (5min sampling) and claude/codex quota ≥90%
  (4h polling) → push, edge-triggered, 85% re-arm, 4h cooldown per alert
  (`domain/resourceAlerts.ts`).
- Machine heartbeat: cpu/ram/disk/load into encrypted daemonState every 20s
  (`PATCH /joy/v2/machines/:id`, CAS on `daemonStateVersion`).
- `~/.joy/env` loaded at boot + re-read at pi spawn (FIREWORKS_API_KEY etc.).
