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

## Adapter shape (`packages/joy-tmux/src/opencode/`)

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
