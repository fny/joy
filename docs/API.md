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
| `joy-create-session` | POST /sessions | Spawn agent (`agent`: claude\|codex\|opencode\|pi\|agy; `resume_id`, `forkSession`, `continue`, `model`, `effort`, `permissionMode`, `yolo`, `extraArgs`, `gitUrl` — clone first into cwd, attempt-owned temp dir renamed in on success, failure reported as `clone_failed:<msg>` and nothing launched, also honoured by the relay spawn spec (#151, #547); unknown agent → loud error). `cwd` is canonicalised ONCE (`~` expanded, `.`/`..` folded, symlinks resolved through the deepest existing ancestor — `paths.canonicalCwd`) before the clone, the launch, the window record and the Claude transcript path, the way Claude Code keys its own project dir (#549 #564). Claude gets `CLAUDE_CODE_ENABLE_TASKS=0` + fresh `--append-system-prompt` every spawn. Over the relay the same options travel as the `spawnSpec` of `POST /joy/v2/sessions`, SEALED (#107): `v2e1:` + b64(nonce24 ‖ secretbox(json)) under the machine's dedicated spawn-spec key (`deriveKey(machineKey, 'Joy Spawn Spec', [machineId])`, a sibling of the tunnel key; both ends derive it, the relay never holds it) once the daemon advertises `capabilities.spawnSpecSealed: true` in its sealed machine metadata. Plain JSON `{v:1,t:'spawn',…}` from an app that predates the seal — or one without the machine key — still spawns on any daemon; a sealed spec the daemon cannot open (wrong key, no machine key) is reported `spawn-failed` `bad_spawn_spec:<why>` and nothing launches |
| `joy-restart-session` | POST /sessions/:id/restart | Relaunch in place, carrying the CURRENT model, effort (`currentEffort` after a mid-session `/effort`, #51) and permission mode, and a user-locked `/title` (#474) A codex replacement also carries its launch config overrides (`extraArgs` → `-c key=value`, #561). |
| `joy-fork-session` | POST /sessions/:id/fork | Fork from the last message into a NEW session (claude) → `localSessionId`. Permission mode fails CLOSED (#50): the pane's live mode, else the window record's persisted mode, else `default` — never bypass |
| `joy-handoff` / `joy-handback` | POST /sessions/:id/handoff {agent, model?}, POST /sessions/:id/handback | Hand a session's work to another model via a note the session writes (returns {ok, pending}; progress on the cards' `joy__handoff`); hand it back into the original session. One in-flight job per session: a second call while the note is being written (or a persisted job exists) is `{ok:false, error:"handoff already in progress" \| "handback already in progress"}` (#53) |
| `joy-teleport-export` / `joy-teleport-import` | POST /sessions/:id/teleport-export, POST /teleport-import | Move a conversation between machines: export the resumable transcript tail (base64, ≤6MB) with the source's permission mode (same fail-closed rule as fork, #50); import canonicalises `cwd` (#549), writes the transcript under that cwd's project dir and resumes (claude) under a new id; a missing `permissionMode` imports as `default`. A same-machine import is refused only into the folder where a session (live or on record) already owns the conversation — into another folder it is the supported same-box fork (#550) |
| `joy-kill-session` | DELETE /sessions/:id | Kill one. Optional `ifStatus` (`?ifStatus=ended` or body `{ifStatus}`): the kill happens only if the session's status matches at that instant, else 409 `{error:"status_mismatch", status}` — the app's detached-session cleanup uses it so a session that restarted meanwhile is never killed (#174). 503 `{ok:false, error:"record_not_terminated"}` when the session was torn down but no termination marker could be durably written (window record unlink and tombstone both refused) — the kill is not safe against a daemon restart yet; retry the kill or fix the state dir (#567) |
| `joy-kill-all-sessions` | POST /sessions/kill-all | Kill everything |
| `joy-restart-daemon` | POST /daemon/restart | Exec-restart the daemon |
| `joy-status` | GET /status | Daemon + sessions snapshot |
| `joy-notify` | POST /notify | Push notification to all devices |
| `joy-send` | POST /send | Deliver text to a session (queue-routed). `from` (`joy:<id>` \| `cli` \| `app` \| `cron:<name>`) + optional `replyTo` make the DAEMON wrap the text in `<joy-message from=… reply-to=…>` and stamp `meta.from` on the mirrored record — the sender's own wrapper is stripped, a `joy:` sender must exist here. `replyTo` defaults to `from` for a `joy:` sender; an explicit `null` or `""` stamps NO `reply-to` (what `joy send --no-reply` and `joy run` send, #112). `exclusive` keeps the old refuse-if-busy scripting contract. Returns `queued_id`. Acceptance is durable: if the queue spool cannot be persisted the op returns `not_durable` (HTTP 503) and nothing is acknowledged or mirrored (#551; same for `queueAdd` and handoff notes) A daemon-owned slash command (`/title`, `/steer`, `/btw`, `/login-code`, `/joy-prompt`) is NOT wrapped whole — its head stays interceptable; a `/steer` / `/btw` body still carries the `<joy-message>` stamp (#552). |
| `joy-check` | GET /sessions/:id/check | `idle` \| `busy` (busySince) \| `needs_input` (held approvals, a hook-reported `waiting` {kind, tool?, since} — claude's permission prompt / elicitation — or a `<joy-options>` question) \| `ended`, plus queue depth and permissionMode — the one computation behind `joy check`/`wait`/`ask` |
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
| `joy-hook` | POST /sessions/:id/hook | Claude Code hook ingress (`event` + optional `session_id, transcript_path, prompt, prompt_id, message, source, trigger, permission_mode, notification_type, end_reason` (Claude's `reason`)`, error_type, tool_name, stop_hook_active, agent_id, agent_type, launch_id`). Events: SessionStart, SessionEnd, UserPromptSubmit, Stop, StopFailure, PostToolUse, PermissionRequest, SubagentStop, Notification, PreCompact. Fenced first: `launch_id` must echo the session's `JOY_LAUNCH_ID` (when it has one) and `session_id` its bound conversation, else the event is ignored (`ok:false`); a subagent's event (`agent_id`) never touches the main agent's state. The first accepted event flips the session's hook-authority latch (FEATURES.md "Cross-cutting invariants") |
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
| Pairing | `POST /auth/request` (doubles as poll) · `GET /auth/request/status?publicKey=` · `POST /auth/response`; `…/auth/account/*` for the account-secret flavour | sealed response, first write wins. Two clocks (#610): unanswered requests expire 24h from creation, answered ones 10min from the answer — enforced on read, answer and sweep alike; approving an expired request is `410 request_expired` (app: "The code expired — scan again"), never a success that vanishes. **Proof of possession (#127)**: every `requested`, `proof_required` and `consumed` reply carries a handshake — `challenge` (32 random bytes, b64) and `relayPublicKey` (a per-request relay X25519 key); `{state:'expired'}` and `401 invalid_proof` carry none — and the pickup poll presents `proof` = b64 HMAC-SHA256 keyed by X25519(requesterPriv, relayPub) over `"joy-pairing-proof-v1" ‖ challenge ‖ requesterPub ‖ relayPub` (the label is a wire constant shared with the daemon's `pairing.ts`). A proof that is offered is always checked: a wrong one is `401 invalid_proof` and consumes nothing. For the **terminal** flavour (the daemon) the proof is REQUIRED: an answered request polled without it is `200 {state:'proof_required', error, message, challenge, relayPublicKey}` — an observer of the QR gets no bearer — and a proven pickup is RETRYABLE within the answered window (a reply lost in transit is polled again with the same proof, not re-paired; racing proven pickups all succeed). The **account** flavour (the app's restore requester) keeps the legacy one-shot pickup by default (#607/#70): a later proof-less poll is `200 {state:'consumed', error:'pairing_answer_already_collected', consumedAt, message, challenge, relayPublicKey}` — clients show `message` (joy auth prints it; the app alerts it) and start a new pairing — while a proof it does send unlocks the same retryable pickup. `JOY_RELAY_PAIRING_PROOF_ACCOUNT=1` (read at start-up; default off) makes the proof REQUIRED for the account flavour too, exactly as for terminal — flip it only once every app build in the field sends the proof, since an older app keeps polling a `proof_required` answer until its 20-minute deadline and then reports the code expired. Challenge freshness (F3): a VALID proof presented on a not-yet-answered request spends its challenge — the `requested` reply carries a fresh one (same `relayPublicKey`) and the next pickup must prove over that, so a proof captured on the wire before the answer cannot collect the bearer after it; a proof-less poll or a wrong proof never rotates, so an observer of the QR cannot invalidate the holder's next proof, and a delivering pickup never rotates, so a lost reply is re-collected with the same proof. Requests created before the handshake existed receive one on their next poll. Requesters: the daemon (`pairing.ts`, tweetnacl) sends the proof on its pickup and falls back to the legacy proof-less pickup against a relay that issues no handshake; the app (`encryption/pairingProof.ts`, tweetnacl + expo-crypto) proves over the handshake of the latest reply on every poll after the first, keeps polling on `proof_required`, and after a rejected poll goes proof-less once to re-learn the handshake. **Rollout order**: relay first, then daemons — a pre-proof daemon against a proof relay fails CLOSED (`proof_required` → `joy auth` throws "pairing not authorized (state=proof_required)"; re-pair after updating), a proof daemon against a pre-proof relay pairs the legacy way; the account flavour stays legacy until every app build sends the proof, then `JOY_RELAY_PAIRING_PROOF_ACCOUNT=1` flips it (a pre-proof app against a flipped relay polls `proof_required` until its 20-minute deadline and reports the code expired). Not addressed here: any authenticated account can still be the one to ANSWER a visible QR (account substitution) — the requester cannot tell who answered |
| Machines | `GET/POST /machines` · `GET/PATCH/DELETE /machines/:id` | POST upserts (403 `machine_owned_elsewhere`); PATCH is CAS on `metadata`/`daemonState` (`expected*Version` → `success`\|`version-mismatch`); `active`/`activeAt` derived from daemon leases. The sealed `metadata` carries the daemon's `capabilities` advertisement (today `spawnSpecSealed: true`, advertised only when the daemon's nucleus lane holds the machine key — a daemon without it publishes the field absent, so the app sends plain JSON it can open); the app reads it before choosing a wire form, and a daemon that predates it simply advertises nothing |
| Push | `POST/GET /push-tokens` · `DELETE /push-tokens/:token` · `POST /push {title, body?, data?}` | relay delivers via Expo; dead tokens dropped |
| Sessions | `GET/POST /sessions` · `GET/DELETE /sessions/:id` · `GET /sessions/:id/events` · `GET /events/stream` (SSE) · `POST /sessions/:id/spawn/retry` | sealed session cards; durable queue. `DELETE /sessions/:id?ifStatus=a,b` is conditional (#173): the record (with its messages, events, turns and attachments) goes only while its relay `state` is one of the named states at the delete, else `409 {error:"status_mismatch", status}` with the current one (an unknown state name is `400 bad_ifStatus`; no `ifStatus` = unconditional, as before) — the mirror of the daemon kill's `ifStatus`. The app's folder cleanup deletes with `ifStatus=detached,archived,failed` after stopping (and confirming stopped) every running session, so a session that restarted while the dialog was open keeps its record and is reported, never deleted under a live agent. `POST /sessions` `spawnSpec` is stored verbatim and hashed into the creation intent's idempotency check: the app seals it under the machine's spawn-spec key when the daemon advertises `capabilities.spawnSpecSealed` (#107) and re-sends the identical envelope on every retry of one intent (a re-sealed spec is `409 idempotency_mismatch`); a plain-JSON spec from an older app is still accepted by every daemon. Old app + new daemon → plain, spawns; new app + old daemon → no capability advertised → plain, spawns |
| Messages / turns | `GET/POST /sessions/:id/messages` · `GET/PATCH/DELETE …/messages/:id` · `POST …/messages/:id/retry` · `GET …/turns/:id` · `POST …/turns/:id/cancellations` | server-owned queue, real cancellation. `clientIntentId` is the message identity: a re-POST with the same id replays the first acceptance (same messageId/turnId) even though the re-sealed ciphertext differs — the app passes its localId, so a lost-ack retry never queues a second turn. Event budget (#613): a session holds at most 50,000 events; `POST …/messages` refuses at ADMISSION with `429 session_event_budget_exhausted` once `events + 3 × (open turns + 1) ≥ 50,000` — the 3-per-turn reserve keeps room for the queued/started/terminal lifecycle events every already-accepted turn still writes, so the relay never authorizes work it cannot record. Retrying never clears it; the app maps it once in `sendMessage` to "This session is full — continue in a new session" |
| Attachments | `POST /attachments` (raw sealed body, `x-session`, `x-cipher-hash`) · `GET /attachments/:id` | ciphertext only, deduped per (session, hash), orphan-swept 24h, purged with the session; cited by id in `POST …/messages` `attachments:[]` — reference + accept + claim commit in ONE transaction (an unknown id 422s the whole send; a replayed retry references nothing). References are a JOIN TABLE (#58): a blob cited by two prompts holds one row per prompt, every offer carries its own authorization, and the blob stays pinned while ANY message cites it; a deduped re-upload renews the orphan clock INSIDE the upload transaction (#611) so an aged blob cited right after re-upload cannot be swept before the message commits. The daemon materializes only citations that are BOTH inside the sealed prompt and in the relay-validated offer list, and unlinks what it wrote if a later one fails |
| Tunnel | `POST /machines/:id/http` | E2E-sealed request/response frames to the daemon's local HTTP server (≈1MB frame cap → the 400KB inline file threshold). In-memory and live, bounded end to end: admission runs on the HEADERS (ownership, liveness, `content-length`) before a body byte is buffered — `503 daemon_offline` when the daemon's tunnel poll is stale; `413 body_too_large` for a declared size over 32 MiB; `503 daemon_busy` + `retry-after: 1` when the daemon's parked inbox is full (16 requests / 64 MiB per daemon, #84); `503 relay_busy` + `retry-after: 1` when the relay-wide budget is (256 requests / 256 MiB across all daemons). The declared size is RESERVED against both budgets while the upload is in flight and re-checked with the real length, so K unfinished uploads cannot pin K × 32 MiB. Clients (daemon `tunnel/client.ts`, app `sync/v2/tunnel.ts`) re-seal and retry the two busy codes per `retry-after` up to 3 attempts, never `daemon_offline`; the app's `sync/v2/machine.ts` words all of them. Response side: the relay buffers at most 8 MiB per client; past that a daemon frame post waits for the client socket to drain, and a client that has not drained within 10 s is dropped (its stream destroyed mid-body, never ended cleanly). A client that sees the sealed head but no FINAL frame reports `connection_slow` ("connection too slow", not tamper) and re-asks an idempotent GET once. A client that disconnects takes its parked request with it, so the daemon never executes a request nobody awaits |
| Daemon lane | `POST /daemon/leases` · `PUT /daemon/leases/:id` · `…/claims/{work,control,tunnel}` · `…/deliveries/:id/received` · `…/sessions/:id/{bind,spawn-failed,facts}` · `PATCH /daemon/sessions/:id` (card, state, and `sessionKeyEnvelope` — the lane re-envelopes every bound session to the current account content key on boot, so a content-key rotation never strands existing sessions) · `…/turns/:id/{submitted,start,facts,reconcile}` · `…/tunnel/:id/frames` | lease-token authenticated; presence = unexpired lease. Records produced while a relay turn runs post as that turn's `output` facts (fenced to its lease, drained before the terminal fact); records outside any turn post to `…/sessions/:id/facts` (output only, `turnId` null, same replay/budget rules). `spawn-failed` body is `{reason, deliveryId}` — `deliveryId` names the ATTEMPT (#612) and the answer is `{ok, applied, reason}`. `applied:false` splits two ways (#581): `already_bound` / `already_progressed` mean the COMMAND moved on and the daemon retires it; `stale_attempt` / `ambiguous_attempt` mean only this DELIVERY was stale while the spawn command is still live and still queued, so the daemon reports again on its next offer. Output the relay refuses for good (`429 session_event_budget_exhausted`) is dropped so the turn can still terminalize, and the loss is surfaced rather than silent (#130): the daemon counts it per session, publishes `joy__eventBudget` {since, dropped} on the card, and fires one push at the first refusal. `/submitted` and `/start` answer `409 session_archived` / `409 session_failed` when the session closed under an in-flight turn (#614) — archiving cancels queued turns and supersedes outstanding deliveries in the same transaction; the daemon drops the turn (no retry, no `failed` terminal; an already-dispatching turn is closed `cancelled`). `…/tunnel/:id/frames` answers `404 request_gone` (client left / idle deadline), `403 wrong_daemon` (another machine's lease), `410 client_gone` (the client's socket is already dead) or `429 client_slow` (the client did not drain 8 MiB of buffered response within 10 s — the relay destroyed its stream) instead of a 200 carrying `{error}` (#83); all are settled BEFORE the frame body is read, and the executor treats every one as terminal: it stops streaming, cancels the local response it was reading, and never re-posts. A post may be held up to 10 s while a slow client drains; exchanges run concurrently per request, so one held post stalls only its own exchange |

A perimeter key (`JOY_RELAY_ACCESS_KEY`, header `x-joy-relay-key`) can gate
the whole surface; unknown paths are 404 — there is no upstream. Relay
environment (all optional; the service unit lists them too):
`JOY_RELAY_PORT`, `JOY_RELAY_DATA_DIR`, `JOY_RELAY_ACCESS_KEY`,
`JOY_RELAY_TOKEN_SECRET`, `JOY_RELAY_TOKEN_ISSUERS`, `JOY_RELAY_TRUST_PROXY`,
`JOY_RELAY_DOCS_TOKEN`, and `JOY_RELAY_PAIRING_PROOF_ACCOUNT` (`1` = the
account pairing flavour requires the #127 proof; unset = legacy one-shot
pickup for the app's restore flow — see the Pairing row).

## Structured git status (`GET /v2/sessions/:id/git/status?v=2`)

The daemon parses git's machine formats ONCE — `status --porcelain=v2 -z
--branch --show-stash -uall`, `diff --numstat -z` (staged and unstaged,
including the two-path rename form), `for-each-ref` with NUL-separated
fields, and one `rev-parse` per value — and answers a versioned schema
(`packages/joy-daemon/src/domain/gitStatus.ts`). Nothing is trimmed and no
C-quoted path is ever decoded: every record is cut at git's own terminator.
The app (`sync/v2/machine.ts` → `sync/gitStatusModel.ts`) renders these facts
and has no git text parser any more. With `v` absent the route still answers
the original flat shape (`branch/oid/upstream/ahead/behind/clean/entries[]`
with cwd-relative `path`) for older apps.

| Field | Meaning |
|---|---|
| `v: 2`, `ok` | Schema version. `ok:false` carries `code` (`git_missing` \| `git_failed` \| `timeout`) + `error` (git's stderr, one trailing newline removed) |
| `relation` | `root` (cwd is the worktree root) \| `inside` (a subdirectory) \| `none` (not a repository — a SUCCESSFUL answer: `{v, ok:true, relation:'none', cwd}`) |
| `repository` | `root` (absolute), `gitDir`, `commonDir`, `linkedWorktree` (gitDir ≠ commonDir, i.e. `git worktree add`), `prefix` (cwd under root: `""` or `"sub/dir/"`) |
| `head` | `{kind:'branch', name, oid}` \| `{kind:'detached', oid}` \| `{kind:'unborn', name}` (no commit yet; `name` is the branch HEAD points at). A rebase/merge in progress is `detached` + `operation`, never a pseudo-branch |
| `upstream` | `{name, ahead, behind}` or null; `ahead`/`behind` null when the upstream ref is gone |
| `operation` | `merge` \| `rebase` \| `cherry-pick` \| `revert` \| `bisect` \| null (from the git dir's state files) |
| `stashCount`, `clean` | Stash entries; `clean` is "no entries at all" — a conflict-only tree is NOT clean |
| `branches[]` | `{name, oid, current, worktree, upstream}` from `refs/heads`; `current` marks THIS worktree's checkout, `worktree` the absolute path of whichever checkout holds it (linked worktrees included) |
| `entries[]` | Scoped to the cwd (pathspec `.`), untracked files listed one by one. Per entry: `path` (see below), `index`/`worktree` (porcelain XY letters, `.` = unchanged, `?` both for untracked), `untracked`, `conflict` (`{xy}` for EVERY `u` record — AA and DD included), `rename` (`{from: path, score, copy}`), `submodule`, `binary` (true from numstat's `-`, null when no numstat covered it), `lines: {staged, unstaged}` |
| `lines` / `totals.staged` / `totals.unstaged` | `{added, removed}` — exact — or the string `'unavailable'`: binary files, untracked files, and every entry of a side whose numstat read failed. Never a stand-in zero. A side with no change (`.`) is `{0,0}` as a fact. Totals sum the available text files of a side and are `'unavailable'` only when that numstat read failed |
| `totals.counts` | `{staged, unstaged, untracked, conflicted, entries}` — conflicted entries are counted once, not as staged/unstaged |

**Path identity vs display.** Every path is a `GitPath`:
`{repo, cwd, display, utf8, rawBase64?}`. `cwd` is the IDENTITY — the
session-cwd-relative path that `files/content?path=`, `git/diff?path=` and
`git/entries?path=` accept (`../x` for a rename partner outside the cwd);
`repo` is the same identity relative to the worktree root. `display` is
what to SHOW: cwd-relative, C0 control characters replaced by their Unicode
control pictures (a newline in a name renders as `␊`), undecodable bytes as
U+FFFD. When the filename bytes are not valid UTF-8, `utf8` is false, the
three strings are lossy (U+FFFD where the bytes could not be decoded) and
`rawBase64` carries the exact repo-relative bytes — nothing is silently
renamed, and a caller that can address raw bytes has them. A filename that
begins with U+FEFF keeps it (the decoder is created with `ignoreBOM`).

## Background daemon behaviors (not ops)

- **The acceptance ledger** (`domain/ledger.ts`, one SQLite file per relay
  state dir: `~/.joy/relays/<relay>/state/ledger.sqlite`, WAL +
  `synchronous=FULL`, every method one `BEGIN IMMEDIATE … COMMIT`). It replaced
  `queue-<id>.json`, `<id>.receipts.json`, `v2-outbound.json`,
  `codex-inbound-<id>.json`, `codex-checkpoint-<id>.json`, `v2-spawns.json`
  and the execution fields of `window-<id>.json` (which keeps identity and
  configuration only). Tables: `commands` (the queue item the app sees — its
  id is the `queued_id` on the wire), `attempts` (one per submission to a
  harness), `observations` (echoes, turn ends), `outbox` (every adapter record
  and turn terminal, in persisted order), `receipts` (retained proof of
  delivery, independent of the pending row), `checkpoints` (transcript /
  turn / message replay cursors), `spawn_intents`, `jobs` (handoffs).
  Acceptance returns only after the commit, else throws (`not_durable` 503;
  `session_ended` 404 for a session whose generation is closed). A dispatch
  attempt is committed before the first key / socket write; a crash in
  between is an explicit `unknown` reconciled by the next generation (Codex
  resends under a NEW client id per attempt — the deterministic
  `codex-in:<id>:<seq>` scheme is gone, attempts and receipts carry
  ownership; OpenCode resends under the SAME idempotent message id; Claude
  retypes; pi/agy resend). A redelivered relay seq dedupes against the
  pending row or the retained receipt — never a second turn (#516). Every
  write naming a session generation is refused once a newer one opened
  (#481). Terminal rows are pruned after 7 days; legacy files are imported
  once at boot (`domain/ledgerImport.ts`, originals in `state/imported-v1/`).
- **The session coordinator** (`domain/coordinator.ts`, Wave C2) owns the
  execution policy the adapters used to duplicate. Every command is a ledger
  row moving through `queued → submitting → accepted | unknown → running →
  completed | failed | cancelled | interrupted` (plus `cancelling`); the
  table `nextState(state, event)` decides every pair and is tested
  exhaustively. Adapters are **drivers** (`submit`, `interrupt`, `observe`,
  `reconcile`, optional `steer`, `prepare`, `handleCommand`, `runtimeRef`,
  `resume`) that keep protocol buffering only — Codex, OpenCode, pi, agy and
  Claude (`claude/claudeDriver.ts`): every session's queue is the
  coordinator's, and `domain/queueFacade.ts` (`queueFor`) is the app-facing
  vocabulary over it (`AgentSession` has no queue methods). Rules: one driver operation per session at a time
  (`concurrentSubmit` drivers may submit while a turn runs; an attempt
  awaiting its verdict always serializes); the op token committed with the
  attempt is checked when the driver's result is applied — a stale result
  is an orphan (interrupted if it accepted a turn), never applied; a
  transient rejection re-queues and retries with backoff, three of them (busy
  refusals excluded) fail the row; a submit that throws or times out is
  `unknown`, reconciled by the driver (`accepted | running | absent → resend
  | unknown → held`), never blindly resent. The driver's **echo** (Codex
  clientId, OpenCode admission, pi rpc response, agy stdin) moves a command
  to `running`; the runtime's **turn end** for that turn is the terminal
  (`completed`, or `failed` / `cancelled` / `interrupted` with
  `agent_reported_*`); an idle runtime with no turn end for the running
  attempt is `interrupted{idle_without_terminal}` (#463); a turn nobody
  submitted is a **foreign** turn (`provenance: "terminal"` in the queue
  snapshot) and never confirms an attempt. **Cancel** is durable: a queued
  row is cancelled at once; a row in flight becomes `cancelling`, the
  driver's interrupt is retried with backoff until the runtime confirms
  (turn end, `interrupted`, idle) and after five tries is flagged
  `unresolved` (snapshot `unresolvedCancels`, journal line) instead of being
  reported cancelled; a session-wide interrupt (OpenCode, pi) is withheld
  while uncancelled work would be collateral and resolves with the turn's
  own end; late evidence for a cancelled row interrupts the turn it names.
  **Generations**: `retire(restart | process_exited)` leaves queued rows for
  the replacement, ends a running command `interrupted{restart}` (the turn
  was live in a runtime torn down on purpose — it is never re-run), and turns
  a submission with no delivery evidence into `unknown` for reconcile;
  `retire(killed)` interrupts everything. The queue snapshot (`joy__queue`,
  `queueList`) adds `running`, `busy`, `provenance`, `unresolvedCancels`,
  `drafts` and `commands` (every non-terminal row with its state) to the
  pre-C2 fields. `send … exclusive` refuses when anything is running OR
  queued. **Claude specifics**: a row stays `queued` while it waits at the
  pane gate (`prepare`: idle per `Session.promptReadiness()`, a fresh
  capture at the ready prompt with an EMPTY box, a dirty box cleared by the
  verified C-u loop — docs/pane-input-clearing.md); `submitting` means typed
  with its Enter pending; `running` follows the runtime's proof of delivery
  (UserPromptSubmit with the exact text, the transcript's user echo — its
  uuid receipt retained —, a `<command-name>` / `<bash-input>` echo, a slash
  command's dialog, or the hook-less turn-start-with-fresh-box read); a
  `!bash` / `/slash` command is complete at delivery. The turn edges are the
  hooks' (UserPromptSubmit → turn_started, Stop → completed, StopFailure →
  failed, the 60 s idle notification → idle) with the transcript's
  turn_duration / end_turn / interrupt marker as the hook-less tie-breaker;
  a turn nobody dispatched is foreign. A submit that never echoes within the
  window (extended while the pane visibly works) puts the row back to
  `queued` and pauses the queue `dispatch_timeout` (the attempt stays
  matchable: a late echo runs the command instead of re-typing it and lifts
  the pause); an unclearable box pauses `input_dirty` (self-healing); a
  failed type pauses `dispatch_failed`; `resume` lifts a pause. A cancel of a
  typed-not-submitted row drops its Enter and settles it cancelled (#35);
  Stop cancels every row in flight durably and sends Escape (the runtime's
  interrupt marker / a Stop confirms it). `/steer <msg>` and `/btw <q>` are
  commands of origin `steer` (never a chip): typed ahead of the FIFO through
  the driver's steer op — into a running turn, a foreign one, or an idle box
  — one pane operation at a time, so two steers never supersede each other
  and a plain prompt waits for both. A restart leaves queued rows for the
  replacement; a row typed but not submitted at the restart is reconciled
  `absent` and re-typed once, a running one ends `interrupted{restart}`.
- **One outbox sender per session** (`relay/outbox.ts`): rows post in `seq`
  order, retried by `runtimeEventId` with the backoff persisted in the row (a
  restart resumes the schedule), dropped on a permanent refusal, parked on an
  unbound session until its bind. A turn terminal is written the instant the
  outcome is known and lands after that session's earlier outputs (#74).
  The nucleus lane runs a relay turn as one coordinator command: the row is
  accepted with `relay_turn_id` (a re-offer is the same row), `/start` is
  posted when the command reaches `running` (the driver's echo — no busy()
  guess, no activity gate), the terminal fact is the command's terminal
  state with its reason as `meta.reason`, and a cancel offer is the row's
  durable cancel (a re-offer of one already requested is not new work). A
  restart mid-turn closes the relay turn `interrupted{restart}`. At boot the
  lane resumes every relay turn the ledger still carries for a
  coordinator-driven session and writes the terminal row (`term:<turn>`,
  idempotent) for any that ended while no lane was alive (R13). A
  local checkpoint recorded while its rows are unacked stays pending until
  the acks arrive, so a crash replays instead of skipping (#67). Backlog over
  2000 rows / 64 MiB per session pauses new prompt dispatch and holds
  adapter checkpoints (`RelaySession.outboundPersistDegraded`).
- Sealed sessions refuse plaintext: once a session has a content key, only a
  valid authenticated `v2e1:` envelope is accepted as a prompt; plaintext JSON
  fails the turn with `plaintext_on_sealed_session` (#579). Outbox rows carry
  their sealing identity; a sealed row whose key is gone is dropped with a log
  line, never sent in the clear (#582).
- `GET /v2/sessions/:id/git/status` paths are relative to the session cwd (a
  subdirectory session sees `inner.txt`, an outside-cwd rename partner
  `../x`), not to the repository root (#601); `?v=2` answers the structured
  schema above, which carries the repo-relative identity as well. Tracked symlinks keep their own
  identity; containment is checked on the real path (#603). Body identifiers
  never override the URL's session/queue-item id (#599).
- `POST /joy/v2/machines` accepts an optional `expectedMetadataVersion`;
  a different current version answers 409 `metadata_version_mismatch` and
  writes nothing (the daemon's key repair re-reads and retries, bounded), so
  an app rename between the daemon's read and its write is never lost (#61).
- A relay row deleted behind a live session (card PATCH 404, facts POST 404,
  or a boot-time GET 404 on a recovered record) unbinds the session and
  re-announces it under a fresh row, so a session deleted from the app while
  its daemon was unreachable never keeps running invisibly (#120). A turn the
  adapter itself ended as failed/cancelled terminalizes as such (#584).
- Push notifications are content-free by default (`Finished`, `Permission
  needed`, `Clarification needed`); `JOY_PUSH_SNIPPETS=1` opts the reply
  snippet and AI title back in (#118). Machine metadata is merged with a
  compare-and-set on a fresh read, never overwriting an app-side rename (#61).
  Preserve-unknown: a machine row whose sealed metadata the daemon cannot
  open is left exactly as it is — no metadata write and no key-envelope
  repair, whether or not the row carries a `dataEncryptionKey` (a missing
  envelope is not proof the blob is disposable; a paired client may still
  hold its key). There is no recovery policy that overwrites such a row.
- Tunnel executor: the sealed request path (`p`) MUST be `/`-rooted,
  same-origin and URL-encoded — a daemon-local request-target such as
  `/v2/files/content?path=%2Fhome%2Fme%2FMy%20Docs`. It is resolved against
  the local base (no `//`, `\\` or `@` after the leading `/`, no userinfo,
  no absolute URL) and the request-target actually sent must re-parse to the
  same origin, path and query — so a `..`-collapsed `/..//host/x` is refused
  like `//host/x`. A raw space is tolerated (encoded to `%20`); tab, CR, LF
  and every other C0/C1 control are refused. Anything else is answered with a
  sealed 400 `bad_path` and never reaches the local surface (#119). Every
  relay call carries `x-joy-relay-key`; a gate refusal (`relay key required`)
  is logged once per outage and again after a later flip or key rotation, and
  an own-lease executor retries a failed first lease with backoff instead of
  crashing (#82). Pairing sends the perimeter key derived from the account
  secret and accepts base64url backup codes (#586 #64).
- Local event routes stream their opening history with drain-aware pacing
  (10 s deadline) before the bounded live feed, so a large history reaches a
  reading client and a stalled one is dropped (#597). The history is paged
  from its store in bounded batches (256 records, ~1 MiB serialized) and
  framed one record at a time into 64 KiB socket chunks; the next batch is
  read only once the previous one is on the wire, so a stream retains one
  batch of record references, one framed record and one chunk — never the
  serialized history. On the wire the `/events` `history` frame is still the
  single SSE event `event: history\ndata: [<records>]\n\n` (byte-identical to
  the whole-array form) and `/sessions/:id/events` still opens with the
  `{ hello, seq }` line followed by one NDJSON line per record.
- CLI turn wait (`joy ask` / `wait` / `run`, `waitTurn` in `cli.ts`): polls
  `/sessions/:id/queue` until the turn id has left the queue, then `/check`
  until an explicit `idle` / `needs_input`. ONE deadline covers the whole
  command (#501): `ask`/`run`/`wait` create a `lifetime(--timeout)` before
  their first request, and session resolution, the seq probe, the send
  (`run`: the create too), every poll, the 300/400 ms sleeps, the 150 ms
  finish grace, the record stream and the final catch-up all run under its
  signal / remaining time; a timed-out wait starts NO catch-up. A pre-wait
  probe that hits the deadline exits 4 (a stalled `POST /send` says the
  message may or may not have been queued). `run`'s teardown runs on its own
  10 s clock so a spent lifetime still cleans up. `/check` 404 → `gone` (exit 1); any other non-2xx or an
  unknown `state` → `error` (exit 1, `reason`) — never `answered` (#496). The
  `/sessions/:id/events?follow=1` stream is resumed from the last consumed
  `seq` when it breaks. Before an `answered` / `needs_input` outcome the CLI
  establishes the log's high-water — the head seq it asks for directly
  (`?last=0`), never below the seq any `{hello, seq}` frame advertised — and
  fetches through it once (bounded by the remaining deadline); rows it still
  lacks turn the outcome into `error` ("output stream lost after seq N — the
  daemon holds records through seq M"). A connected follow socket is not
  proof its advertised rows arrived: a reopened stream that says hello{seq:2}
  and stalls before row 2 is an incomplete reply, not a success (#497). The text of a queued turn starts at the
  mirrored user row whose (wrapper-stripped) text is the sent prompt, else at
  the seq seen when the queue poll noticed the dispatch (#498). `joy new -m`
  reuses the send path and exits with its code on refusal (#494); its retry
  line shell-quotes the prompt (`shellQuote`, one single-quoted word), so a
  `$(…)` or backtick in the message is inert when pasted.
- `joy install` bakes the effective `JOY_RELAY_URL` AND `JOY_HOME_DIR` into
  the systemd unit / launchd plist, so the supervised daemon reads the same
  credentials and state the installing CLI did (an overridden home used to be
  dropped and the service started against `~/.joy`, #499).
- `joy stop` signals only a verified daemon: the pid from an authenticated
  `/status`, or the daemon.json pid whose command line and start time match;
  a stale record is removed without signalling (#495). A daemon the installed
  service owns (the unit's `MainPID` / the launchd job's PID is that pid) is
  stopped through `systemctl --user stop` / `launchctl unload` — a direct
  SIGTERM was undone by `Restart=always` / `KeepAlive` three seconds later
  while `stop` reported success (#502); a failing supervisor stop is exit 1
  and nothing is signalled. Only a detached daemon gets the signal directly.
  The supervisor inspection is three-valued: owns the pid / answered and does
  not (inactive or absent unit or job, `launchctl` 113) / the inspection
  itself failed. A failed inspection is NOT "no supervisor" (#502 residual):
  `joy stop` then reads independent evidence, strongest first — the launch
  mode the daemon recorded in daemon.json (`launcher`: `systemd` | `launchd`
  | `detached`, from INVOCATION_ID / XPC_SERVICE_NAME; `joy start` strips
  those markers so a daemon started from a service-hosted shell still records
  `detached`), the pid's `/proc/<pid>/cgroup` (a unit's process sits in
  `…/joy-daemon.service`), then whether the unit file / plist is installed.
  With none of it, `stop` exits 1 with "could not determine whether the
  daemon is supervised" and signals nothing. The single-daemon lock
  is an SQLite `BEGIN IMMEDIATE` on `daemon.lock.db` — OS-backed, released
  when the process dies, nothing to reclaim; `daemon.lock` is an informational
  pidfile (#589). Node ≥ 22.13.

- Usage cache warmer: boot + every 2h (`server.ts`).
- Resource alerts: RAM/disk ≥90% (5min sampling) and claude/codex quota ≥90%
  (4h polling) → push, edge-triggered, 85% re-arm, 4h cooldown per alert
  (`domain/resourceAlerts.ts`).
- Machine heartbeat: cpu/ram/disk/load into encrypted daemonState every 20s
  (`PATCH /joy/v2/machines/:id`, CAS on `daemonStateVersion`).
- Provider keys: the sealed store `~/.joy/env.sealed` (sealed under a machine-local `~/.joy/env.key`, published exclusively; legacy relay-key stores are re-sealed on first read), applied at boot and re-read before every spawn for every agent; a plaintext `~/.joy/env` is sealed into it on first boot and deleted. Writers serialize on an OS-backed SQLite transaction lock (`env.lock.db`, `BEGIN IMMEDIATE`, held for the whole read-modify-publish; `store_busy` after 5 s; released by the OS when the holder dies — never stolen on age); a value containing NUL is dropped with a warning and never applied or resealed (#533 #535).
