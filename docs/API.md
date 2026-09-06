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
                    ⇄ tmux panes: claude | codex | opencode | pi | agy (headless)
```

- Accounts are auto-created on first `POST /joy/v2/auth` contact (ed25519
  challenge signature); one backup code works on every relay (machines
  register per-account-per-relay).
- All session/machine payloads between app and daemon are end-to-end encrypted
  (libsodium); the relay stores/forwards ciphertext. Message content is
  `v2e1:` + secretbox of `{v:1,t:'plain',text,attachments?:[{id,name,size,
  mime?,width?,height?,thumbhash?}]}` under the per-session key. Agent-side
  `output` events carry `{v:1,t:'record',record}` instead: `record` is the
  adapter's WireRecord (role `session` with `content.data.ev` = text /
  tool-call-start / tool-call-end (+`result`: clamped tool output, `isError`) / turn-start / turn-end+usage, or role
  `user` for a prompt typed at the terminal) — the daemon forwards every
  normalizer record through the lane, so the chat shows tool cards, thinking
  and usage for all four harnesses; the app hands `record` to the same
  normalizer the old socket lane fed. Attachment
  bytes are sealed with the same key (nonce24 ‖ secretbox) before
  `POST /joy/v2/attachments` (`x-session`, `x-cipher-hash` = sha256 of the
  sealed body). The relay only sees the id list on the message body (for
  validation + GC); names and display facts live inside the sealed text.
  The daemon fetches, opens and writes each file into the session cwd, then
  appends its `./name` on its own line to the prompt — any miss fails the
  turn (`attachment_{fetch,open,write}_failed`) rather than dispatching a
  truncated prompt.
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
| `joy-create-session` | POST /sessions | Spawn agent (`agent`: claude\|codex\|opencode\|pi\|agy; `resume_id`, `forkSession`, `continue`, `model`, `effort`, `permissionMode`, `yolo`, `extraArgs`, `gitUrl` — clone first into cwd, attempt-owned temp dir renamed in on success, failure reported as `clone_failed:<msg>` and nothing launched, also honoured by the relay spawn spec (#151, #547); unknown agent → loud error). Claude gets `CLAUDE_CODE_ENABLE_TASKS=0` + fresh `--append-system-prompt` every spawn |
| `joy-restart-session` | POST /sessions/:id/restart | Relaunch in place |
| `joy-fork-session` | POST /sessions/:id/fork | Fork from the last message into a NEW session (claude) → `localSessionId` |
| `joy-handoff` / `joy-handback` | POST /sessions/:id/handoff {agent, model?}, POST /sessions/:id/handback | Hand a session's work to another model via a note the session writes (returns {ok, pending}; progress on the cards' `joy__handoff`); hand it back into the original session |
| `joy-teleport-export` / `joy-teleport-import` | POST /sessions/:id/teleport-export, POST /teleport-import | Move a conversation between machines: export the resumable transcript tail (base64, ≤6MB), import writes it under the target cwd's project dir and resumes (claude) |
| `joy-kill-session` | DELETE /sessions/:id | Kill one. Optional `ifStatus` (`?ifStatus=ended` or body `{ifStatus}`): the kill happens only if the session's status matches at that instant, else 409 `{error:"status_mismatch", status}` — the app's detached-session cleanup uses it so a session that restarted meanwhile is never killed (#174) |
| `joy-kill-all-sessions` | POST /sessions/kill-all | Kill everything |
| `joy-restart-daemon` | POST /daemon/restart | Exec-restart the daemon |
| `joy-status` | GET /status | Daemon + sessions snapshot |
| `joy-notify` | POST /notify | Push notification to all devices |
| `joy-send` | POST /send | Deliver text to a session (queue-routed). `from` (`joy:<id>` \| `cli` \| `app` \| `cron:<name>`) + optional `replyTo` make the DAEMON wrap the text in `<joy-message from=… reply-to=…>` and stamp `meta.from` on the mirrored record — the sender's own wrapper is stripped, a `joy:` sender must exist here. `exclusive` keeps the old refuse-if-busy scripting contract. Returns `queued_id`. Acceptance is durable: if the queue spool cannot be persisted the op returns `not_durable` (HTTP 503) and nothing is acknowledged or mirrored (#551; same for `queueAdd` and handoff notes) |
| `joy-check` | GET /sessions/:id/check | `idle` \| `busy` (busySince) \| `needs_input` (held approvals, or a `<joy-options>` question) \| `ended`, plus queue depth and permissionMode — the one computation behind `joy check`/`wait`/`ask` |
| `joy-approvals` / `joy-approvals-answer` | GET/POST /sessions/:id/approvals | Held tool-call approvals (codex) and `{requestId, decision: allow\|deny}` |
| `joy-env-list` / `joy-env-set` / `joy-env-unset` | GET /env · POST /env · DELETE /env/:name | The sealed environment store (`~/.joy/env.sealed`, AES-GCM under the machine key): names only out, values in; applied to `process.env` at boot and before EVERY spawn so all four agents inherit it. Also on the tunnel as `/v2/env` |
| (stream) | GET /sessions/:id/events?after=&last=&follow=1 | NDJSON of the session's adapter records (`{seq, at, record}` — text, tool calls, turn lifecycle+usage, user rows with `meta.from`); first line `{hello, seq}`. Backs `joy events`, `wait`, `ask` |
| `joy-queue-list/add/edit/cancel/resume/reorder` | /sessions/:id/queue… | Durable dispatch queue CRUD |
| `joy-send-keys` | POST /sessions/:id/keys | Raw key tokens into the pane (escape hatch, not primary interaction) |
| `joy-set-mode` | POST /sessions/:id/mode | Permission/model/effort switches |
| `joy-pane` | GET /sessions/:id/pane | ANSI pane capture (terminal view) |
| `joy-resize` | POST /sessions/:id/resize | Drive tmux window cols/rows (every agent runs on its own tmux server `joy-<id>`, session `joy-<id>`, window `agent`; `tmux_window` in session JSON is the target `joy-<id>:agent`) |
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
| `joy-codex-models` / `joy-opencode-models` / `joy-agy-models` | GET /codex/models, /opencode/models, /agy/models | Model lists (agy: `agy models` display names — the name is the `--model` id) |
| `joy-opencode-sessions` / `joy-opencode-set-model` | GET /opencode/sessions, POST /sessions/:id/opencode/model | opencode extras |
| `joy-refresh-commands` | POST /commands/refresh | Re-scan slash commands |

## Session-scope operations

| rpcName | HTTP | What |
|---|---|---|
| `abort` | POST /sessions/:id/abort | Escape the running turn (does NOT clear the input box — see docs/pane-input-clearing.md) |
| `killSession` | (via DELETE /sessions/:id) | Session-scope kill |
| `bash` | POST /sessions/:id/bash | Run a command in cwd |
| `readFile` | POST /sessions/:id/readFile | ≤400KB inline base64; larger spills to an encrypted blob (`blobRef`) the app downloads/decrypts. Paths: session cwd, the session's media dir, and the temp dirs (`/tmp`, `os.tmpdir()`) — read-side ops only (readFile/listDirectory/getDirectoryTree/ripgrep); write/delete stay cwd-only |
| `writeFile` | POST /sessions/:id/writeFile | Write file. Atomic (temp sibling + fsync + rename): a failed write leaves the previous contents whole (#539); `expectedHash` check and write are one critical section per path (#63). `PUT /v2/sessions/:id/files/content` has the same contract; invalid base64 is a 400 with nothing touched (#605) |
| `deleteFile` | POST /sessions/:id/deleteFile | Unlink one file (no trash). Files only — directories refused |
| `listDirectory` / `getDirectoryTree` | POST /sessions/:id/… | FS browsing |
| `ripgrep` / `difftastic` | POST /sessions/:id/… | Search / diff helpers. Argv is jailed: only an allow-list of options passes, path operands are validated against the cwd (+ read roots), option-like arguments that smuggle paths (`-f`, `--pre`, `-L`, `--ignore-file`, `-`) are refused (#537) |
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

`<joy-options>` picker · `<joy-img>` inline image · `<joy-file>` file chip ·
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
| Meta | `GET /capabilities` (no auth) | `{relay:'joy-relay', protocol:{major:2}, features[]}` — the app's server check and the deploy/stack health probes use it; there is no `/joy/v1` any more |
| Account | `POST /auth` · `GET /account/profile` | login = signed challenge over the ed25519 public key; account auto-created |
| Pairing | `POST /auth/request` (doubles as poll) · `GET /auth/request/status?publicKey=` · `POST /auth/response`; `…/auth/account/*` for the account-secret flavour | sealed response, first write wins, 24h TTL |
| Machines | `GET/POST /machines` · `GET/PATCH/DELETE /machines/:id` | POST upserts (403 `machine_owned_elsewhere`); PATCH is CAS on `metadata`/`daemonState` (`expected*Version` → `success`\|`version-mismatch`); `active`/`activeAt` derived from daemon leases |
| Push | `POST/GET /push-tokens` · `DELETE /push-tokens/:token` · `POST /push {title, body?, data?}` | relay delivers via Expo; dead tokens dropped |
| Sessions | `GET/POST /sessions` · `GET/DELETE /sessions/:id` · `GET /sessions/:id/events` · `GET /events/stream` (SSE) · `POST /sessions/:id/spawn/retry` | sealed session cards; durable queue |
| Messages / turns | `GET/POST /sessions/:id/messages` · `GET/PATCH/DELETE …/messages/:id` · `POST …/messages/:id/retry` · `GET …/turns/:id` · `POST …/turns/:id/cancellations` | server-owned queue, real cancellation. `clientIntentId` is the message identity: a re-POST with the same id replays the first acceptance (same messageId/turnId) even though the re-sealed ciphertext differs — the app passes its localId, so a lost-ack retry never queues a second turn |
| Attachments | `POST /attachments` (raw sealed body, `x-session`, `x-cipher-hash`) · `GET /attachments/:id` | ciphertext only, deduped per (session, hash), orphan-swept 24h, purged with the session; cited by id in `POST …/messages` `attachments:[]` — reference + accept + claim commit in ONE transaction (an unknown id 422s the whole send; a replayed retry references nothing). The daemon materializes only citations that are BOTH inside the sealed prompt and in the relay-validated offer list, and unlinks what it wrote if a later one fails |
| Tunnel | `POST /machines/:id/http` | E2E-sealed request/response frames to the daemon's local HTTP server (≈1MB frame cap → the 400KB inline file threshold) |
| Daemon lane | `POST /daemon/leases` · `PUT /daemon/leases/:id` · `…/claims/{work,control,tunnel}` · `…/deliveries/:id/received` · `…/sessions/:id/{bind,spawn-failed,facts}` · `PATCH /daemon/sessions/:id` (card, state, and `sessionKeyEnvelope` — the lane re-envelopes every bound session to the current account content key on boot, so a content-key rotation never strands existing sessions) · `…/turns/:id/{submitted,start,facts,reconcile}` · `…/tunnel/:id/frames` | lease-token authenticated; presence = unexpired lease. Records produced while a relay turn runs post as that turn's `output` facts (fenced to its lease, drained before the terminal fact); records outside any turn post to `…/sessions/:id/facts` (output only, `turnId` null, same replay/budget rules) |

A perimeter key (`JOY_RELAY_ACCESS_KEY`, header `x-joy-relay-key`) can gate
the whole surface; unknown paths are 404 — there is no upstream.

## Background daemon behaviors (not ops)

- Sealed sessions refuse plaintext: once a session has a content key, only a
  valid authenticated `v2e1:` envelope is accepted as a prompt; plaintext JSON
  fails the turn with `plaintext_on_sealed_session` (#579). Spooled outbound
  records carry their sealing identity; a sealed record whose key is gone is
  dropped with a log line, never sent in the clear (#582).
- `GET /v2/sessions/:id/git/status` paths are relative to the session cwd (a
  subdirectory session sees `inner.txt`, an outside-cwd rename partner
  `../x`), not to the repository root (#601). Tracked symlinks keep their own
  identity; containment is checked on the real path (#603). Body identifiers
  never override the URL's session/queue-item id (#599).
- `joy stop` signals only a verified daemon: the pid from an authenticated
  `/status`, or the daemon.json pid whose command line and start time match;
  a stale record is removed without signalling (#495). The single-daemon lock
  is an SQLite `BEGIN IMMEDIATE` on `daemon.lock.db` — OS-backed, released
  when the process dies, nothing to reclaim; `daemon.lock` is an informational
  pidfile (#589). Node ≥ 22.13.

- Usage cache warmer: boot + every 2h (`server.ts`).
- Resource alerts: RAM/disk ≥90% (5min sampling) and claude/codex quota ≥90%
  (4h polling) → push, edge-triggered, 85% re-arm, 4h cooldown per alert
  (`domain/resourceAlerts.ts`).
- Machine heartbeat: cpu/ram/disk/load into encrypted daemonState every 20s
  (`PATCH /joy/v2/machines/:id`, CAS on `daemonStateVersion`).
- Provider keys: the sealed store `~/.joy/env.sealed` (machine key), applied at boot and re-read before every spawn for every agent; a plaintext `~/.joy/env` is sealed into it on first boot and deleted.
