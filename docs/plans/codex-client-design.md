# Codex as a second agent in joy-server — design v2 (2026-07-17)

Inputs: the claude-coupling map of joy-server, happy-cli's production codex path,
a live spike against codex 0.144.1 proving the **app-server + `--remote` TUI
hybrid**, and a design review by codex gpt-5.6-sol that generated the
app-server schemas from the exact 0.144.1 binary and read the tagged Rust
source (rollout recorder/policy, turn processing). v2 supersedes v1's
durability path; the review transcript lives with the spike artifacts.

## Why hybrid (not pane-driving, not headless)

- Happy proves the app-server protocol in production but is headless — no
  terminal to attach to, which is joy's whole point.
- Driving the codex TUI the way we drive claude's would mean rebuilding the
  most fragile layers (pane parsers, input clearing, paste dances) against a
  faster-churning TUI.
- The hybrid keeps the tmux pane as a *pure attach view* and moves transport
  to a versioned RPC protocol. Spike-verified both ways: RPC-driven turns
  render live in an attached `--remote` TUI; TUI-typed turns stream to other
  clients as `turn/started → item/* → turn/completed`.

## Topology & transport

**One app-server per session**, spawned by the daemon. Per-session for blast
radius and lifecycle symmetry with claude sessions (one agent process each) —
but NOT for notification routing: a single codex session can spawn subagent
threads, forks, and replacement threads on the same server, so **all
notification handling filters by `threadId`** with an explicit root-thread
policy. (Review #8; per-session needs an RSS/FD/startup benchmark at 1/10/50
sessions before we let fleets grow.)

**Transport is an authenticated-or-filesystem-protected socket, not bare
loopback TCP** (review #1): the app-server fronts `danger-full-access`
execution, and a bare `ws://127.0.0.1:<port>` is dialable by *other UIDs* on a
shared host — an escalation the 0700 tmux socket never had. On our
single-user boxes the practical risk is low (any same-user process can already
drive the tmux socket), so this is hardening, not a blocker — but the fix is
cheap:

- Preferred: `--listen unix://<joy-state-dir>/cx-<id>.sock` in a 0700 dir.
  The unix listener speaks WebSocket (spike-verified); the daemon dials it
  with the `ws` library (Node's built-in client can't do unix sockets). Mind
  SUN_LEN (~108 chars) — sockets live under `~/.happy/joy-tmux-state/`.
- Where TCP is unavoidable: `--ws-auth capability-token --ws-token-file`, TUI
  gets the token via `--remote-auth-token-env`.

Both server and TUI launch with `-c check_for_update_on_startup=false` (the
update prompt blocked the TUI during the spike).

**Versioning posture** (review #9, trimmed to joy's weight): everything below
uses the **stable** schema — thread start/resume/read, turn
start/steer/interrupt, `clientUserMessageId`, `developerInstructions`, status,
token usage. Do NOT send `capabilities.experimentalApi` until a named feature
needs it. `codex --version` is checked against a supported-version allowlist
at session create; outside the range → loud health fail, not a silent launch.
(No per-binary schema/fixture CI harness in v1 — allowlist + health alarms +
fast fixes is how we survived claude 2.1.198.) Two v1 bugs the review caught:
`persistExtendedHistory` does not exist in 0.144.1, and the per-turn sandbox
param is `sandboxPolicy`.

## Session lifecycle

**Create** (operations `create` gains `agent: 'claude' | 'codex'`; persisted
on the windowRecord):
1. Spawn `codex app-server --listen unix://<sock>`; connect, `initialize`
   (stable capabilities only), `initialized`.
2. `thread/start { cwd, approvalPolicy, sandboxPolicy, developerInstructions }`
   — **`developerInstructions` is stable and carries the joy tags/options
   prompt** (review #10; no first-turn preamble hack, which would render as
   user content, break receipt matching, and vanish if the TUI ever creates
   the thread).
3. Persist `codexThreadId`, socket path, rollout path (diagnostic only), a
   **server-generation id, and lifecycle phase** (review #5) on the
   windowRecord.
4. tmux window (`j-<id>`) runs a **supervised wrapper loop** (not `exec` —
   v1's wrapper exec'd codex and then claimed to loop; nothing remains to
   loop after exec): poll until the rollout file exists, run
   `codex --remote unix://<sock> resume <threadId>`, and on exit re-check
   server generation and retry with backoff.

**v1 codex sessions are app-first** (review #6, accepted deliberately): the
TUI cannot attach until the first turn flushes the rollout, so the first
prompt comes from the app. This also keeps thread creation with the daemon,
which is what carries `developerInstructions`. TUI-creates-thread adoption
(daemon captures `thread/started` and adopts the root id) is an M2 option.

**Kill/archive**: `turn/interrupt` if active, close socket, SIGTERM the
server, kill the window, archive via the existing path.

## Source of truth: typed notifications, reconciled by thread/read

**v2 reverses v1 here.** The rollout JSONL is NOT the outbound source of
truth. What kills rollout-tailing is not primarily content gaps — for the
narrow set joy mirrors (turn boundaries, assistant text, tool calls+outputs,
usage) the rollout is largely sufficient — but its mechanics (review #2/#3):

- No per-line identity (no UUIDs) → nothing for receipts to key on across
  "server acked, daemon crashed before receipt".
- Rollouts auto-compress to `.jsonl.zst` after 7 days; resume materializes a
  new file; `Thread.path` is documented unstable; our tailer detects none of
  rename/inode-swap/shrink.
- `historyMode: "legacy"` signals a format migration in progress; the
  persistence policy also writes compat duplicates (raw response items AND
  legacy `agent_message`) whose dedupe rule would quietly reimplement codex's
  internal history reducer.
- Upstream docs themselves say `item/*` notifications are the canonical item
  list.

**The pipeline**: typed `item/*` / `turn/*` notifications → normalize to wire
records → **immediately persist into the existing durable outbound queue**
(pre-encoded WireRecords, stable localIds, idempotent v3 POST — machinery
unchanged) → server ack → receipt. Notifications remain "edges" in one sense:
none of them are treated as delivered until the durable outbound store holds
them.

**Reconciliation** (the load-bearing recovery piece): on any
reconnect/restart, call stable `thread/read { includeTurns: true }` and
reconcile against the outbound store + receipts by
`threadId + turnId + itemId` BEFORE resuming live processing or draining the
inbound spool. Amendment to the review: stable `thread/read` is
**unpaginated** — a long thread returns everything, every reconnect; the
paginated listings are experimental-only. Verification item: benchmark
reconciliation on large threads and design a "reconcile only turns newer than
the last receipted turn" cut; if that's insufficient we revisit the
experimental pagination APIs as the named feature justifying opt-in.

The rollout file is kept as a **version-pinned diagnostic/repair feed** —
useful precisely because it IS adequate for what joy mirrors — never as the
live path.

Ephemeral edges (unchanged from v1): `thread/status/changed` → thinking
(authoritative, no leases); `turn/started` → active turnId; `tokenUsage` →
`joy__context`; deltas ignored in v1.

Normalization keeps happy's tool names (`CodexBash`, `CodexPatch`, `McpTool`)
so joy-app's existing codex renderers work unchanged.

## Input path & receipts

App draft queue is unchanged. Delivery of a released message:

1. Spool persists it (existing machinery).
2. `turn/start { threadId, clientUserMessageId: <spool uuid>, input: [...] }`
   — **`clientUserMessageId` is stable, top-level, and echoed back as
   `userMessage.clientId`** (review #4 resolved verification item 1). Exact
   correlation, no text matching.
3. **It is correlation, not idempotency**: resending the same id can create a
   second turn. So the spool entry runs a state machine
   `queued → sent/unknown → echoed`:
   - Receipt ONLY on the echo carrying the matching clientId, from the
     reconciled/durable view — not whichever live notification races first.
   - On recovery, reconcile outstanding clientIds via `thread/read` BEFORE
     draining the spool (a "sent/unknown" entry may already have its echo).
   - A turn that terminates with no echo for its clientId → dead-letter the
     spool entry and surface a delivery failure (an accepted `turn/start` can
     legally produce no userMessage: empty post-processing input, a
     user-configured `UserPromptSubmit` hook stopping it, or a crash window).
   - Two echoes with one clientId → health fault.
   - Validate input is non-empty before sending.
4. **Steer**: `turn/steer { threadId, expectedTurnId, clientUserMessageId }` —
   stable, genuine same-turn injection (review #10; v1's queued-`turn/start`
   downgrade retracted). On rejection/no-active-turn, fall back to queued
   `turn/start`. The `expectedTurnId` race (turn completes between our read
   and the call) resolves via the fallback.
5. **Interrupt**: `turn/interrupt { threadId, turnId: <active> }`; on the
   "expected active turn id X" error, retry once with X.
6. **Attachments**: port happy's `imageInput.ts` (upstream 645b5aa5) for
   image input items; joy's staged-refs flow unchanged upstream of delivery.

## Server→client requests: answer everything (review #7)

`approvalPolicy: never` does not silence all server-initiated requests.
Unanswered requests leave the thread active forever — which also wedges the
app-side draft queue's busy gate. v1 policy table:

| request | v1 behavior |
|---|---|
| command/patch approvals | shouldn't occur under `never`; auto-approve + health note if seen |
| `item/tool/requestUserInput` | reject/cancel with a note row in chat ("codex asked for input the app can't provide yet") |
| MCP elicitations | reject/cancel |
| auth refresh | surface as a login notice (existing joy__login plumbing) |
| unknown methods | JSON-RPC error response + health fault — never silence |

## Recovery state machine (review #5)

Persisted per session: threadId, socket path, server-generation id, lifecycle
phase, spool + outbound stores. On daemon restart, per codex session:

1. **Probe the persisted socket.** If a live app-server answers and
   authenticates as ours: **rejoin, don't kill** — in the hybrid topology the
   server and TUI survive a daemon crash, and the user may be mid-conversation
   in the pane; killing the orphan yanks a live session out from under them.
   Verify identity (our socket path + handshake), resubscribe, reconcile.
2. Socket dead/foreign → new generation: spawn a fresh server,
   `thread/resume(threadId)`, bump generation (the pane wrapper notices and
   re-attaches).
3. **Empty thread** (no rollout yet): `thread/resume` fails — create a
   replacement thread with the same `developerInstructions`, atomically swap
   the persisted threadId, then deliver the pending spool.
4. **Accepted-but-dead turn**: if the previous generation died with a turn in
   flight, reconciliation won't find its completion — synthesize a
   deterministic interrupted turn-end so the app never holds an open turn
   forever, and reset thinking.
5. Only after reconciliation completes: drain the spool (per the receipt
   state machine above).

Socket drop without process death: reconnect with backoff, reconcile on
re-attach; outbound never depended on the socket staying up (durable store),
so nothing is lost — at most delayed.

## Code layout & the interface seam

Unchanged from v1: extract a minimal structural `AgentSession` interface from
the actual call sites in `registry.ts`/`operations.ts`/relay attach; the
claude `Session` satisfies it implicitly (zero behavior change).

```
src/codex/
  appServerClient.ts   ws-over-unix JSON-RPC: handshake, request/notify,
                       typed stable-schema events, reconnect/backoff,
                       generation-aware restart
  codexSession.ts      AgentSession impl: lifecycle + recovery state machine,
                       notification pipeline -> outbound store, receipts,
                       spool delivery via turn/start + turn/steer
  normalize.ts         item/turn notifications + thread/read items -> wire
                       records (CodexBash/CodexPatch/McpTool)
  attach.ts            supervised pane wrapper (poll, run --remote resume,
                       re-check generation, backoff loop)
```

**joy-app**: agent picker on joy/new; daemon sends `flavor: 'codex'` and
`SessionView.tsx` stops hardcoding `'claude'`; per-agent immediate-commands
set (`/model`/`/effort` intercepted into per-turn params; `/btw`, `/compact`
claude-only in v1).

## Model / effort / permission

Per-turn params on `turn/start` (`model`, `effort`, `approvalPolicy`,
`sandboxPolicy`), omitted unless explicitly set so TUI-side changes aren't
silently overridden. Permission table from happy's `executionPolicy.ts`;
**v1 defaults to yolo** (`never` + `danger-full-access`), matching joy's
claude default. Non-yolo approval routing with two attached clients stays
deferred (the TUI answers in the meantime).

## Status

**M2 — BUILT & PROVEN (2026-07-24), latest-codex only.** All items from the
gpt-5.6-sol M1 review resolved, each with a live proof against 0.144.6:
- Inbound durability state machine (persist-before-send, confirm-on-echo).
- Restart reconciliation via thread/read + a TURN-level delivery checkpoint —
  LIVE FINDING: per-item ids differ between live (msg_/call_) and thread/read
  history (item-N), so item-id dedup fails across a restart; turn ids are
  stable, so delivered turns are skipped wholesale. Proof: a restart does not
  double-show a delivered turn and a new message continues the thread.
- Recovery hardening: orphan-app-server rejoin, persisted model/effort/
  permission/developerInstructions + server pid.
- model/list picker: fetchCodexModels + machine RPC joy-codex-models; app
  codex model+effort picker. Proof: gpt-5.5 create → thread on gpt-5.5.
- Non-yolo approval surfacing: daemon holds command/patch approvals, app
  Allow/Deny bar via joy-codex-approve RPC. Proof: codex escalated a command →
  surfaced with its reason → answer resolved it.
- Deterministic output localIds; correctness fixes (valid AskForApproval,
  turn-id from codex, tokenUsage.last, thread/settings model, open-tool cleanup).
- Proofs in src/codex/__fixtures__/*.mjs. 223 daemon tests; both packages typecheck.

**M1 — BUILT & PROVEN (2026-07-24).** Live against codex 0.144.6:
- Transport: `ws+unix://…:/` + `perMessageDeflate:false` (appServerClient.ts).
- Normalizer: codex notifications → the exact claude-shaped wire sequence
  (turn-start/tool-call/text/turn-end) + thinking/receipt/model/context;
  10 fixture-driven parity tests off a real capture.
- CodexSession (AgentSession impl): spawn app-server → thread/start → deliver
  via turn/start → mirror to relay. Two integration proofs pass: transport-
  level and full-CodexSession-level (enqueue → codex → relay wire sequence,
  clientId dispatch-confirm, thinking cycle).
- Registry create+recover branch on agent; app flavor + agent picker.
- 213 daemon tests green (zero claude regression); daemon + app typecheck clean.

Operational requirements: codex ≥0.144 on the daemon's PATH (or `JOY_CODEX_BIN`)
— clientUserMessageId receipts need it; a stale 0.130 workspace copy silently
drops the echo. Deferred to M2: thread/read reconciliation on reconnect, full
receipt-checkpoint machinery (M1 leans on append-layer localId dedup), non-yolo
approvals, codex model/effort picker, attach-TUI hardening.

## Phasing

- **M1 — text loop**: appServerClient (unix ws, stable schema),
  CodexSession + recovery state machine, normalize (turns/text only),
  notification→outbound pipeline with thread/read reconciliation, receipts
  via clientUserMessageId, create-op agent param, pane wrapper, thinking,
  steer, interrupt, kill. App: picker + flavor. Exit: chat with a codex
  session from the app; TUI attach; daemon restart (incl. orphan rejoin)
  recovers with no loss and no duplicates.
- **M2 — parity**: tool-call mapping, attachments, context/usage metadata,
  server-request table hardening, model/effort switching, reconciliation
  benchmark + large-thread cut, e2e coverage, TUI-thread-adoption option.
- **M3 — extras**: non-yolo approvals surfaced to the app, turn diffs
  (`CodexDiff`), usage/cost, fork/rewind, auth-expiry notice.

## Open verification items

1. Reconciliation cost of unpaginated `thread/read` on long threads; design
   the newer-than-last-receipt cut (amendment to review #2's proposal).
2. Subagent/fork `thread/started` shapes on a per-session server — confirm
   the root-thread filter policy against real subagent traffic.
3. ~~`ws` library over unix socket against the app-server listener.~~
   **RESOLVED (2026-07-24 spike, codex 0.144.6):** dial with
   `new WebSocket("ws+unix://<socketPath>:/", { perMessageDeflate: false })`.
   The `perMessageDeflate: false` is REQUIRED — the app-server hangs up
   (closes the connection mid-handshake) when the client advertises the
   `permessage-deflate` extension, which `ws` sends by default; that was the
   "socket hang up". Dead ends: the `ws+unix://…` scheme WITH deflate hangs;
   the http `socketPath` option is silently IGNORED by `ws` (it dials TCP to
   localhost instead). So `ws+unix` + no-deflate is the only working combo.
4. Orphan rejoin: confirm a daemon-respawned connection can resubscribe to a
   surviving server's live turn mid-stream and reconcile cleanly.
5. Per-session server footprint benchmark (RSS/FD/startup at 1/10/50).
