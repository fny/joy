# joy-relay — Native Protocol Design

**Server-owned durable queue, real cancellation, and honest state for joy
sessions — designed for the relay we now own.** Supersedes the server-untouched
contortions of `resilient-queue-design.md` (kept as the problem-statement
record; its §2 root causes and §12 open problems are all resolved here).
Problem statement: `joy-relay-design-brief.md`. Design developed in a
three-round consultation with GPT (codex, xhigh), grounded in the actual
joy-daemon/joy-relay/joy-app code.

## Executive summary

1. joy-relay is a strangler beside the legacy proxy; native sessions are
   selected explicitly by negotiated capability — never dual-active.
2. Only joy-relay creates native session rows: app spawns create provisional
   rows plus a daemon spawn command; `joy new` announces a confirmed local
   runtime after the fact.
3. PostgreSQL is the durable authority for session state, ordered commands,
   turns, deliveries, leases, and completed runtime facts. Clients fetch a
   small authoritative projection; nobody folds an opaque log for correctness.
4. Every client mutation carries a stable `clientIntentId`; the server
   atomically assigns the canonical command/turn/event/sequence in one
   transaction (own-send seq race gone by construction).
5. Each daemon holds a fenced lease (epoch) and parks two account-level
   long-polls: an urgent control lane (cancel/steer/permission decisions) and
   a multiplexed work lane (prompts).
6. joy-daemon reports staged → submitted → started → receipted evidence using
   its real seams (dispatch gate, `UserPromptSubmit` hook, JSONL transcript
   receipts), and recovers after crashes from transcript offsets without
   unsafe retyping.
7. Cancellation is an ordered barrier: suppress queued work, clear unsubmitted
   text, Escape running work, and claim `cancelled` only after evidence.
8. Presence, runtime state, permissions, failures, and indeterminate delivery
   are represented honestly; permission requests have **no default expiry**.
9. Content stays E2E-encrypted with per-session derived secretbox keys
   (existing crypto stack); minimal visible headers support routing, fencing,
   and reconciliation, bound to the ciphertext by an inner header hash.
10. Migration proceeds by capability negotiation, native session discovery, a
    backend-keyed read adapter in the app, and cohort rollout — native
    commands are never dual-written into legacy messages.

## 0. The honest delivery contract

Literal exactly-once agent execution is impossible: the daemon can always die
between the runtime accepting a prompt and recording that fact. The contract
is instead:

- **Exactly-once server acceptance** by idempotency key (`clientIntentId`).
- **At-least-once delivery** to a durable daemon inbox.
- **At-most-once automatic runtime start** (server-side CAS on `turn.start`).
- **Recovery when the runtime can prove the execution** (for joy-daemon: the
  JSONL transcript — see §3), which in practice makes most crash windows
  auto-recoverable.
- **Otherwise `indeterminate` / `orphaned`, surfaced — never silent replay.**

We sacrifice occasional automatic re-execution rather than ever repeating
arbitrary tool side effects.

## 1. Architecture and invariants

One Node 22 process under systemd on the relay box; SQL migrations, no ORM;
HTTP long-poll for daemon work, SSE for app pokes; an in-process periodic
worker for lease expiry and deadlines. No Redis/Kafka/socket.io. The phase-0
passthrough (`proxy.mjs`) remains the legacy edge and is not evolved into the
native protocol.

*Implementation note (phase 1, deliberate deviation):* the dev nucleus runs
on **embedded PGlite** rather than the provisioned Postgres 16 quadlet — one
process, one writer, transactions serialized by construction, dev == test
storage. The correctness model leans on that serialization; a move to real
Postgres requires adding `FOR UPDATE` row locks before multi-connection use.
The quadlet stays reserved for that promotion.

```
Incoming request
├─ /joy/v2/* account plane (login, pairing, machines, push — accounts.mjs)
└─ /joy/v1/* + /joy/v2/* session plane (native)
   ├─ auth (EdDSA tokens minted and verified by the relay — tokens.mjs)
   ├─ session coordinator: serializes intents per session; every mutation
   │  locks the session row, takes one seq, mutates state, appends the
   │  event — one transaction
   ├─ daemon lease + delivery service (long-poll claims, receipts, fencing)
   ├─ projection API (state) + encrypted event/history API + SSE pokes
   └─ PostgreSQL (authoritative state + immutable encrypted events)
```

Invariants:

1. One queue authority per session: `legacy | shadow | native`, never two.
2. Server mints `turnId` at prompt acceptance; ≤1 executing foreground turn
   per session; terminal turn states are immutable.
3. Every delivery/lifecycle write is fenced by the daemon's lease epoch.
4. Sockets/SSE are wake-up hints only; correctness lives in Postgres + HTTP
   replay.
5. Queue/turn/permission status is relational state, not a ciphertext
   projection.
6. Native seqs are decimal strings on the wire (no JS integer limits).

## 2. Data model

**v1 nucleus — six tables** (everything else deferred; see §12):

| Table | Purpose |
|---|---|
| `native_sessions` | id (relay-minted UUID), account, owner daemon, `localSessionId` (joy-daemon 8-hex, unique per daemon), creation intent identity, state `provisioning→starting→active/detached/failed/archived`, `next_seq`, revision, active turn, recovery flag, wrapped session key envelope |
| `daemon_leases` | daemon id, epoch, hashed token, renewed/expiry, capabilities |
| `commands` | id, session, seq, producer, `client_intent_id`, request hash, kind (`prompt\|cancel\|spawn_session`), target turn, barrier seq, ciphertext, delivery/application state |
| `turns` | server-minted id, prompt command, request seq, `queued\|dispatching\|running\|cancelling\|orphaned\|terminal`, lease epoch, run token, cancel seq, transcript UUID, terminal reason |
| `deliveries` | command, daemon, epoch, attempt, offered/received/submitted/receipted, disposition |
| `session_events` | (session, seq) PK, event id, kind, command/turn ids, encrypted body, server timestamp |

Key constraints: unique `(session, producer, client_intent_id)`; same intent
id with a different request hash → 409 `idempotency_mismatch`; unique daemon
fact ids `(turn, run_token, runtime_event_id)`; ≤1 execution-bearing turn per
session; first permission decision wins (CAS); one current lease epoch per
daemon.

The event stream stays valuable for transcript catch-up and audit, but it is
NOT the operational database.

## 3. Delivery on the real runtime (tmux TUI, not the SDK)

joy-daemon types into Claude Code's TUI and reads back via pane parsing +
hooks + the JSONL transcript. The delivery phases map to the existing seams
(`#drainOnce` idle+empty-box gate, `#typeIntoTmux`, 350 ms paste-settle,
`#armSubmit`, `UserPromptSubmit` hook, JSONL user-entry matching,
`receipts.ts` UUID mapping):

```
delivery.received    daemon fsyncs {commandId, turnId, promptHash,
                     transcriptPreOffset} in a local dispatch journal
dispatch.submitted   Enter left tmux control mode ("probably accepted")
turn.started         matching UserPromptSubmit hook (preferred) or matching
                     JSONL user entry (proof of acceptance)
turn.receipted       JSONL {uuid, transcriptOffset, promptHash} — the strong
                     durable runtime receipt
facts                assistant/tool facts from JSONL UUIDs; permission/retry
                     facts from pane+hooks; terminal fact from JSONL/Stop
```

There is no generic `command.applied`: prompt consumption is `turn.started`,
steering application is its hook/JSONL receipt, cancellation application is
confirmed interruption, permission application is confirmed dialog
disappearance. The server-minted `turnId` replaces the local random turn id.

**Crash recovery** — before typing, the daemon records the transcript path
and byte offset; on restart it scans from that offset:

| Evidence after restart | Action |
|---|---|
| Matching JSONL user entry | Safe: don't retype; report started/receipted, replay later facts |
| `turn.started` already stored server-side | Don't retype; reconcile |
| Pane generating, JSONL not yet appeared | Treat as started; await evidence |
| Exact prompt still in input box, Enter never sent | Finish the submit (unless cancel pending) |
| Typing never completed, pane empty, no evidence | Safe to restart dispatch |
| Enter sent; no hook/JSONL; pane idle and empty | `dispatch_indeterminate` — surface, never auto-retype |
| Transcript unhealthy / identity uncertain | `recovery_required` |

Safety invariant: one daemon dispatcher per pane, no simultaneous human
submission during recovery — violations are declared indeterminate. The local
dispatch journal must be atomic-replace + fsync (stronger than today's
debounced receipts).

**Consumer bookkeeping (server):** daemon identity + epoch, last
offered/contiguous received seq, per-command delivery attempts, active run
tokens. No authoritative app cursors — apps submit `after_seq` on reads.

## 4. Cancellation and steering

Cancellation is a dedicated transaction with two explicit scopes:
`turn` and `turn_and_pending_before_barrier` (Stop button default — drains
every queued turn with `requestSeq < C`; work accepted after the cancel gets
a higher seq and survives — the deterministic multi-device rule).

- Target queued/dispatching → marked cancelled, delivery suppressed, a late
  `turn.start` CAS fails (cancel-before-start is airtight).
- Target running/awaiting-permission → `cancelling` + priority control-lane
  delivery; daemon ladder: cancel pending Enter → **Escape** → confirm via
  JSONL `[Request interrupted…]` / Stop hook + stable idle pane / process
  death → retry Escape once → kill the pane **process group** →
  `cancelled {mode: graceful|forced}`.
- `Session.abort()` stops claiming `cancelled` at Escape-send; it reports
  only after evidence. Natural completion racing Stop stays
  `completed {cancelHadNoEffect: true}`.
- Steering names a `turnId` (no implicit "current"): delivered in seq order
  while the turn runs; `rejected: turn_terminal_before_apply` if it ends
  first; cancelled with its target.

## 5. Permissions (no default expiry)

Overnight permission waits are healthy state, not timeouts. `expiresAt`
defaults to **null**; the UI shows "waiting for permission for 6h 12m".
The pane is the runtime source of truth; Postgres records the last fenced
observation:

Notification hook → fresh pane capture → permission-specific parser (generic
model/login dialogs become `awaiting_terminal_input`, not permission) →
fingerprint (title/options + turnId, survives daemon restart) → encrypted
details + visible lifecycle posted → app decision names `requestId` +
`optionId` → daemon re-verifies the fingerprint against a fresh capture
before keying the selection → `applied` only when that dialog demonstrably
resolves. A human answering in the terminal → `resolved_external` (never an
invented allow/deny). First committed decision wins; recovery re-serves the
recorded answer, never re-asks. Daemon offline → `awaiting_permission` +
`observationStale: true`.

## 6. Connection anatomy and latency

Per daemon (not per session): **one parked control claim** (cancel, steer,
permission decisions, fencing notices), **one parked work claim** (prompts
across all hosted sessions), heartbeat PUT every 5 s (lease TTL ~20 s).
Claims wait ~25 s and re-park before processing a batch. The server registers
the waiter before its final query (no lost-wake race); an in-process notifier
wakes waiters post-commit; relay restart loses only the notifier — reconnect
polls hit Postgres first. Apps hold one SSE connection per account.

Prompt latency budget ≈ 450–750 ms end-to-end — dominated by the TUI's own
350 ms paste-settle, so long-polling doesn't materially worsen perceived
latency vs socket.io push; cancel reaches Escape in ~100–300 ms. If control
p95 ever exceeds 500 ms, a WebSocket can replace the control poll without
touching durable semantics.

## 7. Events, SSE, and partials

Every completed JSONL entry (assistant text, tool start/end, retry, terminal)
is durable in `session_events` — stable UUIDs are exactly what makes restart
dedup work. Only finer-than-JSONL activity is ephemeral (pane
generating/thinking animation; future sub-entry token deltas).

SSE: `hello` (sessions + head seqs), `poke` (sessionId, headSeq, revision,
changed: events|state — no content; missed pokes harmless; fetch on poke),
`live` (connection-local, non-replayable activity frames). **v1 ships no
`text_delta` at all** — durable JSONL granularity plus state matches what the
daemon actually has today. A mid-turn connector renders the durable
transcript + authoritative state + an activity indicator.

## 8. Crypto

Reuse the shipped stack — no new native modules: `crypto_secretbox_easy`
(XSalsa20-Poly1305, tweetnacl on the daemon, libsodium on app/web) and the
existing HMAC-SHA512 derivation tree. Per-session keys:

```
Kbase  = session dataEncryptionKey (data-key sessions) | account master secret (legacy)
Kevent = deriveKey(Kbase, "Joy Relay", ["session", sessionId, "v1", "events", epoch])
Klive  = …["live", epoch]      Kblob = …["blobs", epoch]        (epoch "0" in v1)
keyId  = "jr1:event:e0" etc.
```

secretbox has no AAD, so immutable envelope fields are bound *inside* the
ciphertext: plaintext = `{headerSha256, payload}` where `headerSha256` hashes
the canonical visible header (scope, sessionId, kind, intent/event/turn ids,
keyId). Recipients recompute and compare after decrypt. Server-assigned seq
is not bound (producer can't know it); sequence stays relay-authoritative.
The relay never holds `Kbase` or derived keys. Session keys are minted by the
daemon at session creation and wrapped to the account content key
(`sessionKeyEnvelope`).

## 9. Session creation

Only joy-relay creates `native_sessions` rows; the daemon remains the
authority that creates tmux/Claude resources and binds them.

**App-spawned:** app persists a `CreateSessionIntent` (stable
`creationIntentId`, spawn spec encrypted to the machine key) + optimistic
shell → `POST /joy/v1/session-creations` → relay dedupes, creates
`native_sessions(provisioning)` + a `spawn_session` command → daemon claims,
spawns via the existing registry path (cwd validation, tmux window, Claude
launch), mints the per-session data key, wraps it →
`POST /sessions/:id/bind {spawnCommandId, localSessionId, sessionKeyEnvelope,
metadata}` → fenced transaction flips `provisioning→starting` → SSE poke →
app replaces the shell. `active` comes later from runtime evidence.
"Create-and-send" = two durable ops (bind first; the initial prompt stays in
the app outbox until the session key arrives). Daemon offline → accepted,
shown as provisioning; incapable/revoked daemon → rejected. Local failure →
`failed` row with encrypted error, never silent deletion.

**`joy new` on the machine:** local-first (relay unavailability must never
block someone at the machine): daemon allocates `creationIntentId`, creates
tmux/Claude locally, then announces
`POST /session-creations {mode: "announce_existing", …}` → relay dedupes and
returns the canonical `sessionId` (state `starting`; no spawn command).
Unreachable relay → durable `unannounced_session` record, retried on
reconnect; transcript scanning backfills pre-attachment facts. Resume/
continue reuses the persisted creation intent — never a second native row.
`joy new -m` submits through the relay (stable `clientIntentId`) and consumes
via the normal claim path; direct terminal typing is imported as an
externally-originated turn from JSONL evidence — remotely-accepted commands
are server-ordered, terminal activity is an observed external fact.

## 10. Own-send and optimistic reconciliation

Before POSTing, the app atomically persists the outbox entry (stable
`clientIntentId`; the **already-encrypted** bundle incl. nonce — retries
never re-encrypt; request hash; status machine
`waiting_for_network→posting→accepted→awaiting_observation`) plus an
optimistic row keyed `intent:<clientIntentId>` with `seq: null` shown after
the canonical transcript as offline/sending — no speculative ordering.

`AcceptedIntent {clientIntentId, requestHash, commandId, eventId, seq,
turnId, sessionRevision, disposition}` updates that row in place (never
appends a duplicate). Every producer-originated event exposes
`origin {actorId, clientIntentId, requestHash}` (non-secret), so on reconnect
the app: pages `after_seq` matching `origin.clientIntentId` to its rows →
retries unresolved outbox entries verbatim (server replays the original
acceptance if it had committed) → applies canonical events and deletes
matched outbox entries. This covers every crash window: lost POST, lost
response, event-before-response, cursor-passed-event, other-device sends, and
payload tampering (409, surfaced as local corruption). Steers, cancels, and
permission decisions use the identical outbox protocol.

## 11. Honest state and presence

`GET /joy/v1/sessions/:id/state` returns revision, headSeq, daemon
{status, lastSeenAt, leaseExpiresAt, epoch}, queue {queuedTurns, queuedSteers,
oldestQueuedAt}, execution {idle|running|awaiting_permission|cancelling|
orphaned, turnId, lastProgressAt, suspectedStalled, cancelRequested},
permissions {openCount}, background {activeCount}. The app distinguishes
accepted-and-queued / delivered-not-started / running / awaiting-permission /
cancelling-unconfirmed / daemon-offline-N-queued / orphaned /
foreground-done-background-running.

Presence comes from **leases, never a shared boolean**: every daemon
installation (per relay) is its own row; online = current lease
by Postgres receive time (skew-free); `suspectedStalled` is a visible
heuristic ("online, running, no accepted progress for 120 s"), never a
fabricated terminal state. This fixes the shared `machine.active` stomping.

## 12. Backpressure; deferred subsystems

256 KiB max inline ciphertext; queue caps with 429 + Retry-After **before**
acceptance (never accept-then-drop); one outstanding prompt delivery per
session; separate small control lane so a huge upload can't head-of-line
block Stop; prompts and terminal facts never coalesced; background progress
last-value-wins.

Deferred from v1 (cut deliberately): native blobs (when added: Postgres
`bytea`, 16 MiB cap, ciphertext hashed; big attachments stay on the upstream
path), `machine_operations` (durable file/shell/spawn RPC — design exists:
same delivery machinery, `operationId` retry, serialization keys,
read-only-redeliverable, `indeterminate` for shell), `background_activities`
table (a count column suffices), token-delta streaming, consumer cursor
table, snapshot machinery, account/actor/machine tables (reuse upstream
auth), XChaCha/AAD migration. Not cut: per-command deliveries, server-minted
turns, cancellation barriers, lease epochs + orphan reconciliation, durable
JSONL events, the state projection. **Permissions follow immediately after
the nucleus** (one table, two endpoints) — invisible overnight waits are a
primary failure we're fixing.

## 13. Migration phases

- **P0 (now):** passthrough proxy, unchanged.
- **P1 — native nucleus:** route only `/joy/v1/*` locally; Joy Postgres up;
  verify existing tokens (shared master-secret verification — pairing
  unchanged); daemon registration/leases/capabilities/state; legacy clients
  100% upstream.
- **P2 — semantic shadow:** upgraded clients send visible intent/lifecycle
  metadata to Joy while legacy remains execution authority; compare accepted
  intents vs observed legacy messages, queue depth, presence, cancel latency.
  Native dispatcher disabled — observation, not dual execution.
- **P3 — per-session native ownership:** cut over idle sessions whose app and
  daemon both advertise v1: record upstream high-water mark, no active legacy
  turn, `backend=native`, dispatcher on, legacy consumption off. New joy
  sessions default native once confident. Rollback trivial before first
  native acceptance; automatic fallback afterwards is forbidden (duplicate
  execution). App reads native sessions via the backend-keyed adapter
  (`/joy/v1/.../events` keeps the familiar `{messages[], hasMore}` shell —
  one fetch branch, not two sync engines; no duplicate legacy-shaped rows).
  Stock clients get 426 `upgrade_required` on native-session mutations.
- **P4 — own core legacy endpoints** (exact response shapes over Joy
  Postgres, routed by backend).
- **P5 — own storage:** export PGlite → import preserving ids/seqs/
  timestamps, verify counts + ciphertext hashes, flip after a read-only
  comparison window; own auth last.

**Status (2026-09-01): all phases complete.** The relay is the only server —
the account plane (accounts, pairing, machines, push, EdDSA tokens) is native
(`src/accounts.mjs`, `src/tokens.mjs`, migration 005), the proxy is gone, and
unknown paths are 404. Account rows were imported id-for-id so existing
tokens keep verifying (`JOY_RELAY_TOKEN_ISSUERS` accepts the earlier issuer
label).

## 14. Build order (incremental PRs)

1. Router prefix, Postgres migration runner, token verification,
   capabilities endpoint.
2. Six tables, leases, two claim lanes, fake-daemon integration tests.
3. joy-daemon native prompt receipt/dispatch/transcript reconciliation.
4. Durable cancellation, barrier drain, Escape confirmation, forced kill.
5. Native events/state/SSE.
6. App feature flag + dual read/send path.
7. Enable on one dev-relay session (Joy Relay Dev :14997), then opt-in
   stable sessions.

## 15. Resolution of the old doc's §12 open problems

| Old problem | Server-side resolution |
|---|---|
| Multi-writer intent serialization | Session-row lock + one canonical seq per mutation; strict prompt queue; steering names turns; Stop is a seq barrier; optional revision preconditions |
| Agent replay duplication | Runtime replay never becomes new server events; facts carry stable runtime event ids; unprovable replay → `interrupted`, never re-typed |
| Permission blocking | Durable rows, server-visible awaiting state, first-decision CAS, **no default expiry**, cancellation cleanup, replay by requestId |
| Log compaction/snapshots | Folding removed from the correctness path — materialized relational state IS the snapshot; heartbeats/partials never enter the log |
| Producer backpressure | Admission quotas, bounded delivery windows, control lane, ephemeral progress, 429 before acceptance |
| Schema versioning | Versioned path, session-pinned major, daemon capability negotiation, 426 for unsupported control commands |
| Legacy dual truth | One backend authority per session; shadow never dispatches; idle-only cutover |
| Skew-free stalled detection | Server receive-time leases/progress; `suspectedStalled` is visible heuristic |
| Control-event security | Actor roles, per-daemon scoped creds, lease fencing, header-hash binding, immutable audit events |
| Testing/observability | Metrics: queue age/depth, redelivery, lease expiry, orphans, permission age, cancel latency, idempotency conflicts; invariant tests against real Postgres transactions |

## 16. Ideas from the old design explicitly rejected

- An opaque stored log is not a server-owned queue — it can't enforce
  consumption, barriers, fencing, or transitions.
- Consumer dedup by eventId ≠ exactly-once execution.
- One cursor can't mean both "read" and "executed" — reading and execution
  acknowledgement are separate (a blocked cursor must not hide a cancel).
- Client-authored snapshots: unsafe across mixed versions, unnecessary once
  the server materializes state.
- Heartbeats as permanent log records.
- "Daemon said completed" without a current fenced lease and a legal
  transition.
- Cancel *delivery* conflated with cancel *confirmation*.
