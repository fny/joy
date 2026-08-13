# OpencodeSession — tmux-free agent adapter (design)

Spiked live against opencode 1.18.10 (`opencode serve`, 2026-08-01). This doc
maps its server API onto joy's adapter pattern and proposes the generalization
that makes tmux a per-agent capability instead of the daemon's substrate.

## Why opencode is the easy third adapter

The codex adapter fought for properties opencode gives away for free:

| Property | claude (tmux) | codex (app-server) | opencode (HTTP) |
|---|---|---|---|
| Transport | pane typing + parsing | JSON-RPC / unix socket | HTTP + SSE, OpenAPI at `/doc` |
| Send | type + Enter + echo-confirm | turn/start (no queue!) | `POST /prompt` → **admittedSeq** ack |
| Busy semantics | pane spinner parsing | daemon-side FIFO (M2 #4) | **native `delivery: steer\|queue`** |
| Item identity | transcript uuids | transient ids; we built canonical ordinals (M2 #5) | **stable msg ids + positional part ids (`text-0`)** |
| Restart/resume | --resume + transcript rebind | thread/resume + reconcile + checkpoint | **server persists sessions; cold restart → full history via GET** (verified) |
| Streaming | whole entries | whole items | **token deltas** (`session.next.text.delta`) |
| Approvals | pane dialogs | serverRequest hold | `permission` REST list/reply + SSE |
| Ask-user | pane dialogs | requestUserInput (unimplemented) | `question` list/reply/reject endpoints |
| Terminal view | tmux pane capture | tmux attach TUI | **PTY-over-HTTP** (`/api/pty` create/connect) — optional, no tmux |

Verified live: create → prompt (`{prompt:{text}, delivery?, id?: msg_*}` — the
client-supplied `msg_` id is our idempotency key) → SSE
`session.next.prompted/prompt.admitted/step.started/text.{started,delta,ended}/step.ended`
→ `GET /message` returns `{id, type: user|assistant, content:[{type:text, id:"text-0", text}], model, finish, tokens}`.
Killed the server mid-session; restart listed the session and served both
messages intact — resume is a GET, not a protocol dance.

## Adapter shape (`packages/joy-daemon/src/opencode/`)

`OpencodeSession implements AgentSession`, sibling of `CodexSession`:

- **Server lifecycle:** one `opencode serve --port 0` per session dir (or one
  shared server per machine — open question below), spawned by the daemon like
  the codex app-server; orphan-rejoin by port/pid record identical to codex
  (records + verifiable-liveness resurrect already generalized in the registry).
- **Send path:** relay pull → durable inbound spool (reuse `codexInboundStore`
  pattern) → `POST /prompt` with a deterministic `msg_` id derived from relay
  seq (idempotent retry) and `delivery:"queue"` (native queueing replaces the
  daemon FIFO codex needed). Ack = `admittedSeq`.
- **Outbound normalize:** `OpencodeNormalizer` maps SSE events → joy wire
  (turn-start on `step.started`, text on `text.ended` [v1: whole blocks; v2:
  stream deltas], tool events from tool parts, turn-end on step/idle) with
  deterministic localIds from `(messageID, partID)` — no ordinal machinery
  needed, the ids are already stable across live and history.
- **Reconcile on attach/restart:** GET `/message` after (re)connect, replay
  through the normalizer; the delivered-turn checkpoint generalizes but may be
  unnecessary — same ids live vs history means the relay append dedupe alone
  might suffice (decide during build).
- **Approvals/questions:** permission SSE/list → the app's approval bar (same
  `joy__codexApproval`-style metadata, generalize the key); question requests →
  the dialog bar with actual remote reply (better than "answer in terminal").
- **Interrupt:** `POST /interrupt`. **Model switch:** `POST /model` (live
  catalog from `/api/model` — the picker RPC generalizes to
  `joy-agent-models?agent=opencode`).
- **Terminal view (optional):** skip tmux entirely; later, wire `/api/pty` to
  the app's terminal page over the relay for a real shell if wanted.

## Registry/app changes

- `agent: 'opencode'` in CreateSessionOpts + window records (no tmux window
  fields; add `opencodePort`/`opencodePid`); recovery = record-based (the codex
  resurrect path, generalized).
- App: `flavor: 'opencode'` — reuse the codex gating (agent-specific new-session
  options: model picker from live catalog, its permission modes; hide
  terminal affordances unless PTY lands). Add a `capabilities` metadata field
  (`{ pane: bool, attachTui: bool }`) instead of more per-flavor conditionals.
- e2e: opencode runs the agent-agnostic chat suite + its own `suite-opencode.md`
  (mirrors suite-codex: options, model identity, resume, approvals, interrupt).

## Decisions (Faraz, 2026-08-01)

1. **Per-session servers** — `opencode serve --port 0` per session (ephemeral
   localhost port + pid recorded in the window record); codex-shaped lifecycle,
   recovery via the existing verifiable-liveness resurrect. Revisit shared
   server only if concurrent-session count hurts.
2. **Whole-block text for v1** — emit on `text.ended`; delta streaming deferred
   to a cross-agent wire feature.
3. **Auth: env/pre-authed only for v1** — missing-auth errors surface as a
   legible chat note; login-bar surfacing is a fast-follow if hit.
4. **Approvals in v1** — verify permission/question schemas during build with a
   live approval-proof round-trip.

## Open questions (resolved above — original framing kept for context)

1. **Server-per-session vs shared server.** Sessions carry `projectID`/
   `location`; one shared server could host many sessions/dirs (workspace API
   exists). Start with per-session (matches codex isolation + kill semantics),
   revisit.
2. **Delta streaming to the app** — joy wire currently sends whole text events;
   deltas need an app-side streaming-update path (exists for claude? partial) —
   v1 ships whole `text.ended` blocks.
3. **Auth/providers** — server picks up env keys (verified with OPENAI_API_KEY);
   surfacing `opencode auth` login flows remotely is out of scope v1.
4. **Question/permission payload shapes** — captured endpoints, not yet the
   schemas; pull from `/doc` during build.

## Effort

Comparable to codex M1 but smaller (no FIFO, no ordinal identity, no
resume-reconcile checkpoint dance): transport+normalizer+session ~2 days,
registry/app wiring ~1, approvals+e2e ~1.

## Provider setup findings (fireworks, 2026-08-01)

Verified working: `gpt-oss-120b` via fireworks-ai through `opencode serve`
(2.4s gen). Setup = `fireconnect login` + `fireconnect opencode on`, THEN
remove the `headers` block from the provider options in
`~/.config/opencode/opencode.json` — opencode leaks `options.headers` into the
request body and Fireworks 400s on it (report upstream; `apiKey` alone works).
Operational gotchas the adapter must design around:
- opencode's server process is named `opencode.exe` — match THAT for
  liveness/kill, never the launch command string.
- Runtime provider-SDK installs go through npm config; a broken ~/.npmrc
  (dead token / ignore-scripts) breaks providers invisibly — the adapter
  should spawn servers with a clean NPM_CONFIG_USERCONFIG and surface
  provider errors from the message `error` field (they are per-message and
  legible: 401/400 with upstream bodies).
- fireconnect alias models (minimax-latest etc.) route to a gateway that
  401s ("missing authorization") — use full `accounts/fireworks/models/...`
  ids.
- gpt-oss-120b leaks raw reasoning into text content via this path; the
  normalizer should check for separate reasoning parts vs inline.
- e2e default model: gpt-oss-120b (fireworks) now viable; free
  `ling-3.0-flash-free` remains the zero-key CI fallback.

## Model policy (Faraz, 2026-08-01)

**v1 supports exactly two models, both verified through `opencode serve` on
fireworks (chat + real tool execution + clean reasoning/text part separation):**
- `accounts/fireworks/models/kimi-k3` — default (correct self-ID, ~1.5s)
- `accounts/fireworks/models/glm-5p2`

The joy picker offers ONLY these (codex-style cycle chip works again — no
searchable-picker UI needed in v1). The daemon's joy-agent-models op for
opencode returns this curated list, not opencode's full /api/model firehose
(241 entries on a fully-keyed machine). The provider-blind architecture stays:
the curation is a joy-side allowlist over whatever opencode serves, not a
Fireworks dependency — widening later is config, not code.

Verified matrix + test-design consequences:
- kimi-k3 ✅ / glm-5p2 ✅ / deepseek-v4-pro ✅ (not in v1 set) /
  gpt-oss-120b ✅ but leaks reasoning into text / fireconnect alias ids ❌
  (gateway 401 — always use full accounts/fireworks/models/... ids).
- glm-5p2 and deepseek self-report as "Claude by Anthropic" — e2e identity
  assertions MUST use the assistant message's authoritative `model` metadata
  field, never the model's self-description.
- Reasoning arrives as a separate 'reasoning' part (kimi/glm/deepseek) — the
  normalizer maps it to thinking presentation (or drops it), never chat text.
- e2e default model: kimi-k3.

## ChatGPT-subscription auth (tested 2026-08-01, opencode 1.18.10)

Connected via `opencode auth login` → OpenAI → "ChatGPT Pro/Plus (headless)"
(device-code flow — works fine on a headless box; credential = type:oauth in
auth.json). Results:
- `opencode run -m openai/gpt-5.6-sol` keyless: ✅ works on the subscription.
- `opencode serve`: ❌ 401 "Missing bearer" — server mode does not attach the
  oauth credential (latest version; file upstream). Until fixed, subscription
  OpenAI is unusable through the adapter (which is serve-based). Not blocking:
  v1 models are fireworks kimi-k3/glm-5p2, both serve-verified.
- Codex auth does NOT carry over — opencode never reads ~/.codex/auth.json;
  stores are siloed per tool.
- Second upstream bug seen here: turn failures in serve can be logged as
  "Failed to drain Session" WITHOUT landing an error on the assistant message
  (the silent-drop) — the adapter must treat "prompt admitted but no assistant
  message within a deadline" as a failure and surface it, not wait forever.

## Turn-end detection (build finding, 2026-08-01)

`POST /api/session/{id}/wait` is unusable on 1.18.10: it answers 503
`"Session wait is not available yet"` permanently (not just right after a
prompt), and NO `session.idle` event ever flows on `/api/event` or `/event`
(verified live — a full turn ends at `session.next.step.ended` with nothing
after it). The working signal is the step finish reason:

- `session.next.step.ended` carries `data.finish`: `"tool-calls"` = the turn
  continues with another LLM call; anything else (`"stop"`, `"length"`, …)
  ends the joy turn (completed).
- `session.next.step.failed` / `session.error` end the turn as failed, with
  the provider error message surfaced to the user.
- The silent-drop guard is an inactivity deadline (10 min) armed at
  prompt-admission and re-armed by every session event.

Also config gotcha: an `opencode.jsonc` next to `opencode.json` in
`~/.config/opencode/` can shadow the real config — keep exactly one.

## Permissions are NOT enforced on the v2 serve path (verified 2026-08-03)

Third upstream issue: on 1.18.10, permission config has NO effect on turns
driven through `POST /api/session/{id}/prompt`:

- `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"deny"}}'` merges into the
  resolved config (GET /config shows it, provider config intact) — but the
  bash tool still executes. Same for agent-level
  (`agent.build.permission.bash: deny`) and for sessions created with an
  explicit `{"agent":"build"}`.
- No `permission.ask` is emitted and `GET /api/permission/request` stays
  empty — so a serve-based client cannot even be asked.
- The full permission request/reply API surface exists
  (`/api/session/{id}/permission/{requestID}/reply` etc.) but nothing on the
  v2 prompt path produces requests. Enforcement appears to live only in the
  client flows that implement an asking UI (TUI / `run --auto` / ACP).

Consequences for joy: adapter sessions are unconditionally yolo on this
version — an explicit `permission: "allow"` config would be a placebo, and a
guarded mode / approval bar is blocked upstream until the serve path enforces
permissions (retest on upgrade; the deny-repro above is the test).
