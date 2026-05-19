# Happy Communication Layer — Working Specification v1

Normative. Keywords **MUST / MUST NOT / SHOULD / MAY** per RFC 2119. This document is self‑contained: it defines the system and every term before using it, then specifies the protocol completely. The relay server is **not modified**; every guarantee is achieved by client + CLI behavior over the server's existing primitives.

---

## 1. Purpose and audience

This specifies the communication layer between Happy's apps and the agent running on a developer's machine: how user input, agent output, and control actions (cancel, permissions, steering) are transported reliably, in order, exactly once, and how any app can fully recover state after a disconnect — even if the machine‑side process is unreachable or has died.

It is written for an engineer with no prior Happy context. §2–§4 give the background and vocabulary; §5 onward is the normative protocol.

---

## 2. Background: the Happy system

Happy lets you drive a coding agent (Claude Code, and others) on your computer from a phone/web app. Three components:

```
   ┌─────────────┐        ┌──────────────────────┐        ┌──────────────────────────┐
   │  App(s)     │  HTTPS │   Relay server       │  WS    │  CLI daemon (your machine)│
   │ phone / web │◀──────▶│  (happy-server)      │◀──────▶│  (happy-cli)              │
   │ (happy-app) │  + WS  │  store + relay only  │        │  runs the coding agent    │
   └─────────────┘        └──────────────────────┘        └──────────────────────────┘
        many                  one, unmodified                 one process, many sessions
```

- **App (`happy-app`)** — phone/web client. The user types here, watches the agent, approves tool permissions, hits Stop. There can be **several apps connected to the same session at once** (phone + laptop web, two phones, …).
- **Relay server (`happy-server`)** — a dumb, end‑to‑end‑encrypted **store‑and‑relay**. It persists every message of a session with a server‑assigned, ever‑increasing integer **`seq`**, lets clients fetch "everything since `seq` N", and broadcasts a lightweight "something new arrived" socket signal. It cannot read message contents (they are encrypted). **We do not change it.**
- **CLI (`happy-cli`)** — a multi‑purpose binary. Only a slice of it is relevant here. It plays two **unrelated roles**:
  - **Session host / agent writer (IN SCOPE):** for one live session it connects to the relay, talks to **the agent** (the actual model/tool loop), and is the sole writer of that session's agent events. This role can run inside the installed background daemon **or** as a foreground `happy <path>` invocation — this spec governs the *role*, not a particular process.
  - **Machine supervisor & everything else (OUT OF SCOPE):** installing/uninstalling the background service, `doctor`/health, spawning/stopping *other* sessions, `auth`/pairing/QR, the sandbox runtime, interactive local‑terminal mode, config/persistence/CLI arg parsing. None of this is part of the communication layer (see §25).

  Throughout this spec, **"daemon" denotes the agent‑writer role for one session**, not the `happy-cli` binary and not its supervisory/lifecycle features.

**Why a new layer.** Today user messages are durably stored but the agent is notified only by a transient broadcast; cancel is a fire‑and‑forget socket call with no persistence. Result: messages get lost, sessions wedge, Stop often does nothing, and an app that was offline can't reliably resync. This spec replaces that with a single durable, ordered, replayable event log that both sides reconstruct identically.

---

## 3. Core idea in one paragraph

The relay server already is a durable, ordered, append‑only log per session (every message has a monotonic `seq`, history is retained, and "give me everything since `seq` N" already exists and is already used). We stop inventing side‑channels. **Every** unit of communication — a user message, a cancel, an agent message, a tool call, a permission request, a heartbeat — becomes one **event** appended to that log. Each participant keeps a position (**cursor**) in the log and computes session state by a deterministic **fold** over events in `seq` order. The socket broadcast is demoted to a latency hint ("go read"); correctness never depends on it. Because the log is the single source of truth and the fold is pure, every app and the daemon converge to identical state, and anyone can rebuild everything from the log alone.

---

## 4. Glossary

| Term | Meaning |
|---|---|
| **Session** | One conversation with one agent on the machine. Has its own event log. |
| **Event** | One atomic record appended to a session's log (see catalog, §9). Carries an encrypted payload. |
| **`seq`** | Server‑assigned, strictly increasing integer per session. **The** canonical order of events. Assigned at persist time. |
| **Log** | The ordered sequence of all events for a session, as stored by the relay server. Source of truth. |
| **Cursor (`lastAppliedSeq`)** | A participant's "I have processed up to here" position in the log. |
| **Fold** | A pure function `state' = fold(state, event)` applied in `seq` order to derive **projection** from the log. |
| **Projection** | The derived session state (turns, their states, open permissions, background tasks, config). |
| **Poke** | The relay's transient "new event exists" socket signal. A latency hint only; loss‑tolerant. |
| **Producer** | Anything that appends events. **Input producers** = apps. **Agent writer** = the one daemon currently leased to the session. |
| **Turn** | One unit of agent work triggered by user input: from "user asked" to "agent finished/cancelled/failed". |
| **Agent** | The actual model/tool loop for the session (e.g. the Claude Agent SDK child process). |
| **Daemon** | *In this spec:* the agent‑writer role for one session (mediates between the log and the agent). NOT the `happy-cli` binary, and NOT its machine‑supervisor/lifecycle features. May run inside the installed service or as a foreground `happy <path>`. |
| **E2E** | End‑to‑end encrypted: payloads are opaque to the relay server. |
| **Lease / epoch** | The mechanism (§13) ensuring exactly one daemon acts as agent writer at a time. |
| **Steer** | Extra user input delivered into an **already‑running** turn ("by the way, also …") without starting a new turn (§12). |
| **Snapshot** | A periodic event containing the full projection, so new readers don't replay all history (§11.3). |
| **Partial** | A streaming delta of an in‑progress agent message. Ephemeral, never logged (§11.4). |

---

## 5. Design model and invariants

- A **session** has exactly one append‑only, totally‑ordered event log. `seq` order **is** the order; nothing else defines order.
- The log is the single source of truth. The poke and partials are latency optimizations and are never authoritative.
- Producers: any number of **input producers** (apps), and exactly one **agent writer** (the leased daemon, §13).
- Every consumer computes state by a **pure, total fold** over the log. Same log ⇒ identical projection, bit‑for‑bit (display‑only fields excepted).

Invariants:
- **I1 Durability:** an accepted input event reaches the agent exactly once across reconnects/restarts.
- **I2 Cancel parity:** cancel is an ordinary durable event with the same delivery guarantee as a message.
- **I3 No lying UI:** session status is a deterministic function of the folded log + the consumer's own connection state; never of an unacked RPC.
- **I4 Catch‑up:** a consumer reconstructs full state from the log alone, regardless of CLI reachability or liveness.
- **I5 Convergence:** all connected apps and the daemon, having folded the same prefix of the log, show the same session state.

---

## 6. Transport bindings (server untouched)

| Channel | Existing server primitive | Use |
|---|---|---|
| **Append** | `POST /v3/sessions/:id/messages` (E2E blob + `localId`) | One event = one message record. |
| **Read / replay** | `GET /v3/sessions/:id/messages?after_seq=N` (asc) / `before_seq=N` (desc) | Cursor catch‑up; `before_seq` to find the latest `snapshot`. |
| **Poke** | existing transient socket broadcast | "New `seq` available" → consumer pulls. Loss‑tolerant. |
| **Live partials** | same transient socket broadcast | Ephemeral streaming deltas (§11.4). Never persisted. |
| **Retention** | rows deleted only by explicit user session‑delete; no TTL/cron sweep | Log is durable for the session's lifetime. (Verified in `happy-server`.) |

Event payloads are E2E‑encrypted exactly as messages are today; the server stores/relays them opaquely. New event types are opaque records that **legacy apps already ignore** (verified: `happy-app typesRaw.ts:735‑740` drops unknown types; `storage.ts:568‑588` unread is not driven by message type; `happy-cli apiSession.ts:364‑388` routes unknown records to a generic handler, never mis‑queues them). New participants intercept events **at the raw decrypt boundary, before legacy normalization**.

---

## 7. Event envelope (frozen) and versioning

```
Envelope (v1 — SHAPE FROZEN, never changes):
{ eventId:   uuidv4         // producer-generated; global idempotency key
  type:      string         // see §9
  v:         int >= 1       // payload schema version for this type
  vmin:      int >= 1|null  // control events only: min consumer version required
  sessionId: string
  turnId:    string|null
  by:        string         // producer deviceId/daemonId (for audit)
  ts:        int            // producer epoch ms — ADVISORY; never used for ordering
  payload:   <type-specific, E2E-encrypted> }
seq is the server-assigned message-record sequence; it defines order.
```

Versioning rules:
- Consumers **MUST** ignore unknown `type` and unknown payload fields (forward‑compat).
- For a known `type`, a consumer **MUST** process `v ≤ itsMax(type)` and **MUST** ignore (not error) `v > itsMax(type)` — except control events.
- **Control events** (`cancel`, `interrupt`, `steer`, `permission-response`, `mode-change`, `writer-claim`) carry `vmin`. If `itsMax(type) < vmin`, the consumer **MUST NOT** act on it and **MUST** surface status `client-too-old` (§17). This is the only class where a silent mis‑fold would be unsafe; it is hard‑gated.

---

## 8. Multiple simultaneous clients

This is first‑class, not an afterthought:

- **N input producers.** Any number of apps may be connected to one session at once. All append input events (`user-message`, `steer`, `cancel`, `interrupt`, `mode-change`, `permission-response`) to the same log. There is still exactly one **agent writer** (the daemon, §13) — many typists, one worker.
- **Convergence (I5).** Every app pulls the same log from its own cursor and folds it with the same pure function ⇒ all apps display identical turn/permission/background state. No app is "primary."
- **Concurrent prompts.** Two apps prompting at once produce two `user-message` events; their order is whatever `seq` the server assigned; they become queued turns run FIFO by `seq`. Deterministic, never lost.
- **Permissions across devices.** A `permission-request` may be answered from any app. The **first** `permission-response` for that `reqId` by `seq` wins; later ones are no‑ops (§15). Every app sees the resolved state.
- **Cancel / steer from any device.** Any app may cancel or steer; effect is defined by `seq` order relative to other events (§12, §14).
- **`mode-change` races.** Concurrent `mode-change` events resolve last‑writer‑by‑`seq`; the projection's config reflects the highest‑`seq` `mode-change`.
- **Per‑consumer status.** "Connected / stalled / offline / unknown" is computed per app from *its own* connection state plus the shared projection (§17). Two apps can correctly show different liveness (one online, one offline) for the same session state.
- **Drafts and typing indicators are out of scope (see §25):** they are ephemeral, per‑device UI, never written to the durable log.

---

## 9. Event catalog

`idem` = idempotency class: **K** = dedupe by `eventId`; **T** = turn‑scoped, fold idempotent by `turnId`+state; **R** = request/response keyed by `reqId`.

| type | producer | payload | idem | notes |
|---|---|---|---|---|
| `user-message` | app | `{messageId, content, attachments[]}` | K | starts a new turn; `content` is opaque (incl. slash commands, §12) |
| `steer` | app | `{targetTurnId, content}` | K/T | input into an already‑running turn (§12) |
| `cancel` | app | `{targetTurnId \| "*"}` | K/T | `"*"`/null = cancel current + drain pending |
| `interrupt` | app | `{targetTurnId}` | K/T | graceful stop only (no drain) |
| `mode-change` | app | `{permissionMode?, model?}` | K | folded into session config (last‑by‑`seq`) |
| `writer-claim` | daemon | `{daemonId, epoch}` | K | single‑writer lease (§13) |
| `turn-started` | daemon | `{turnId, requestEventId}` | T | turn enters `running` |
| `turn-output` | daemon | `{turnId, messageId, content}` | K | committed agent message (NOT a partial) |
| `tool-call` | daemon | `{turnId, toolCallId, name, input, state:'pending'\|'running'}` | T | |
| `tool-result` | daemon | `{turnId, toolCallId, ok, result\|error, parts?}` | T | large results chunked (§10.4) |
| `turn-completed` | daemon | `{turnId, usage, costUsd}` | T | driven by the §11 state signal |
| `turn-failed` | daemon | `{turnId, errorSubtype, detail}` | T | one of the 4 SDK error subtypes / ACP failure |
| `turn-cancelled` | daemon | `{turnId, by}` | T | cancel applied to a running/pending turn |
| `turn-interrupted` | daemon | `{turnId, reason:'crash'\|'interrupt'}` | T | crash‑detected or graceful interrupt |
| `bg-started` | daemon | `{taskId, turnId, label}` | K | background task (§16) |
| `bg-progress` | daemon | `{taskId, usage}` | K | coalesced |
| `bg-notification` | daemon | `{taskId, status:'completed'\|'failed'\|'stopped'}` | K | task terminal |
| `bg-exited` | daemon | `{taskId, reason}` | K | task gone (incl. crash report) |
| `permission-request` | daemon | `{reqId, turnId, toolCall, options[]}` | R | blocks the tool (§15) |
| `permission-response` | app | `{reqId, optionId, auto?}` | R | replayed by `reqId`; never re‑prompts |
| `agent-metadata` | daemon | `{tools[], slashCommands[], models[], mcpServers[], skills[]}` | K | advisory; powers UI (§12) |
| `heartbeat` | daemon | `{turnId, hbCounter}` | — | liveness only; never in a snapshot |
| `cursor` | daemon | `{appliedSeq}` | — | daemon's consumed watermark (advisory) |
| `snapshot` | daemon | `{uptoSeq, projection}` | K | fold fast‑path (§11.3) |
| `rejected` | daemon | `{refEventId, reason}` | K | dead‑letter (§11.5) |
| `projection-digest` | any | `{uptoSeq, hash}` | — | conformance (§22); rate‑limited |

Streaming deltas are **not** in this catalog — they ride the ephemeral poke channel only (§11.4) and are never logged.

---

## 10. Producer

**10.1 Append + idempotency.** Each event gets a fresh `eventId` (uuidv4). The producer writes to a **persisted local outbox**, then POSTs. It **MUST** retry with exponential backoff (base 500 ms, cap 15 s, full jitter) across reconnects/app‑resume until it observes its own `eventId` echoed in the `after_seq` stream carrying a server `seq`. That echo is the only ack. Re‑sends are safe: consumers dedupe by `eventId` (K) or fold idempotently (T/R).

**10.2 Producer ordering.** Within one producer, events **MUST** be appended in production order (FIFO outbox; one in‑flight POST per session). Cross‑producer order is defined solely by server `seq`.

**10.3 Backpressure (agent writer).** Bounded outbox: **2000 events or 32 MB**, whichever first. Coalescible events (`bg-progress`, `heartbeat`, `cursor`) collapse to the latest unsent instance. Non‑coalescible events are never dropped; if the bound is hit by them the daemon **MUST** apply flow control to the agent (stop consuming the next agent message; for ACP, withhold the next turn pull) until the outbox drains. Flow control propagates to the agent; the layer never drops or buffers unboundedly.

**10.4 Large‑payload chunking.** Any `tool-result`/`turn-output` whose plaintext exceeds **64 KB MUST** be split into ordered chunks sharing `messageId`/`toolCallId` with `parts:{partIdx,last}`. Chunk plaintext **MUST** be ≤ 64 KB to bound synchronous‑encryption stalls. Consumers reassemble by `(messageId, partIdx)`; the item is renderable only once `last` is folded.

---

## 11. Consumer

**11.1 Cursor & fold.** A consumer holds `lastAppliedSeq` (persisted). On startup/reconnect/poke it pulls `after_seq=lastAppliedSeq` to exhaustion, folding each event in `seq` order, then live‑tails via poke‑triggered pulls. The fold is **pure and total**: every type (including unknown) maps to a deterministic transition; unknown ⇒ identity.

**11.2 Projection.**
```
Projection = {
  config: {permissionMode, model},          // last-by-seq mode-change
  turns:  Map<turnId, {state, requestEventId, usage, costUsd}>,
  order:  turnId[]  (by turn-started seq),
  openPermissions: Map<reqId, {turnId, options}>,
  bgTasks: Map<taskId, {turnId, status}>,
  agentMeta: {tools, slashCommands, models, mcpServers, skills},
  writerEpoch: int,
  lastEventSeq, lastHeartbeat:{turnId,hbCounter,atSeq} }
```

**11.3 Snapshot fast‑path.** A fresh consumer (no/old cursor) **MUST** first locate the latest `snapshot` via `before_seq` backward paging, set `projection := snapshot.projection`, `lastAppliedSeq := snapshot.uptoSeq`, then tail forward. Fold cost is bounded to events since the last snapshot regardless of session age. Display *content* is paged lazily as today; the *state machine* never requires full history.

**11.4 Live partials (ephemeral).** Streaming deltas (SDK `includePartialMessages`/`SDKPartialAssistantMessage`; ACP `agent_message_chunk`) are emitted **only** on the poke socket as `{messageId, deltaText}` and **MUST NOT** be persisted. Consumers MAY render them live by `messageId`; the authoritative `turn-output` for that `messageId` **MUST** replace any partial on fold. Partial loss never affects correctness.

**11.5 Dead‑letter (no silent stuck).** If the agent writer folds an input event it cannot process, it **MUST** emit `rejected{refEventId, reason}` and, if that input would have created a turn, `turn-failed{errorSubtype:'rejected'}`. A turn **MUST NOT** stay non‑terminal due to an unhandled event.

---

## 12. Mid‑turn input: steering and slash commands

**Slash commands (incl. `/btw` and project/custom commands) need no special handling.** A user message's `content` is opaque text the agent itself interprets; `/`‑prefixed commands are forwarded **verbatim** inside `user-message` or `steer`. The set of available commands/tools/models is advisory UI metadata: the daemon emits `agent-metadata` from the agent's init/`supportedCommands()` (Claude `sdk.d.ts:1731`, system‑init `slash_commands` `:2757`) and from ACP `available_commands_update`. Apps render it; the protocol does not parse commands.

**Steering = input into a running turn.** If the user sends input while a turn is `running` and intends it to influence that work ("by the way, also rename the file"), the app emits `steer{targetTurnId, content}` instead of `user-message`. Turn‑machine rules:

- target turn `running` → the daemon **MUST** inject `content` into the agent's live input stream (Claude: push onto the streaming‑input iterable the SDK already supports; ACP: deliver as a follow‑up prompt if the agent advertises it). Multiple `steer`s (from one or many apps) are injected in `seq` order.
- target turn already `completed`/`failed`/`interrupted` → the daemon **MUST** reify the `steer` as a new `user-message` turn (intent is never lost; it just becomes the next turn).
- target turn `cancelled`, or a `cancel` for that turn precedes this `steer` in `seq` → the `steer` is reified as a new `user-message` turn (the cancelled work is gone; the user's words are preserved as a fresh request).
- agent backend cannot accept mid‑turn input → the daemon **MUST** reify as the next `user-message` turn and emit `agent-metadata`/a note so the UI can explain "queued for next turn."

`steer` is idempotent (K by `eventId`; reification is deterministic from folded state). An app chooses `user-message` vs `steer` purely by whether a turn is `running` in its (converged) projection; if it guesses wrong, the reification rules above make it safe.

---

## 13. Single‑writer lease (epochs)

Exactly one agent writer per session.
- On taking a session a daemon folds the log, computes `epoch := writerEpoch + 1`, appends `writer-claim{daemonId, epoch}`, and **MUST** wait until it observes its own claim echoed by `seq` before emitting any `turn-*`.
- A daemon that folds a `writer-claim` with `epoch > itsEpoch` **MUST** immediately relinquish: stop the agent, stop emitting, become passive.
- Any agent event whose producing epoch is `< max folded writerEpoch` is **stale**; consumers **MUST** ignore stale agent events.
- Apps are never agent writers. This makes daemon restarts and accidental double‑spawn deterministic and non‑corrupting, and makes A/B of `happy-cli-next` vs prod safe (only the highest‑epoch writer acts).

---

## 14. Cancel / interrupt

`cancel{targetTurnId}`:
- `running` → run the ladder (below); emit `turn-cancelled`.
- `pending` → `→cancelled` (never executes); emit `turn-cancelled`.
- not yet seen → record in `cancelTombstones`; applied on its `turn-started` (turn goes straight to `cancelled`, agent never runs it).
- already terminal → no‑op.
- `targetTurnId="*"`/null → cancel the current `running` turn **and** mark all `pending` turns `cancelled` (drain). This is the Stop button.

`interrupt{targetTurnId}` = graceful stop of the running turn only; no drain.

**Ladder (daemon, Claude):** (1) `Query.interrupt()` (`sdk.d.ts:1674`) → wait `GRACE_INTERRUPT` (3 s) → (2) per‑turn `AbortController.abort()` → wait `GRACE_ABORT` (2 s) → (3) `Query.close()` (`sdk.d.ts:1853`). In parallel, `stopTask(taskId)` (`sdk.d.ts:~1841`) for every live bg task of the turn. **ACP:** `session/cancel`, map `StopReason.cancelled`. The terminal `turn-cancelled` **MUST** be emitted only after the agent has actually stopped, and pending **MUST** be drained per the `"*"` rule. Repeated cancel after terminal is a no‑op.

---

## 15. Permission / elicitation

The daemon's tool‑permission/elicitation hook emits `permission-request{reqId,turnId,toolCall,options[]}` and **awaits** the folded `permission-response{reqId,optionId}`. Any app MAY answer; first response by `seq` wins; later ones are no‑ops (R). Timeout `PERMISSION_TIMEOUT` (default 300 s, per‑session tunable): on expiry the daemon self‑emits `permission-response{reqId,optionId:'deny',auto:true}` and proceeds as denied with a clear tool error; the turn continues per agent semantics. While any `reqId` is open, session status is `awaiting-input` (§17). On agent‑side replay (§18) a recorded answer is **replayed by `reqId`; the user is never re‑prompted** (elicitation is non‑idempotent).

---

## 16. Background tasks

`bg-started/bg-progress/bg-notification/bg-exited` are **turn‑independent** first‑class events. They MAY arrive after their originating turn is `completed` — expected, not an error (turn boundary is the §11 idle signal, not "no more output"). A session with all turns terminal but a live bg task has status `running-background`. The cancel ladder also `stopTask`s live bg tasks of the targeted turn. On daemon death, bg tasks die; on restart the daemon emits `bg-exited{reason:'daemon-restart'}` for any `bg-started` lacking a terminal — the work is gone but **reported**, never silently pending.

---

## 17. Turn state machine, liveness & status

**States:** `pending → running → {completed | failed | cancelled | interrupted}`. Terminal except `pending`/`running`.

**The turn boundary is a runtime state signal, not a return value.** Claude: SDK `session_state_changed: idle|running|requires_action` (`sdk.d.ts:2702‑2705`; the SDK itself calls `idle` the authoritative turn‑over signal — it fires *after* held‑back results flush and the background‑agent loop exits). ACP: `PromptResponse.stopReason` (`end_turn`→completed; `cancelled`→cancelled; `max_*`/`refusal`→failed). A `result`/prompt‑return is **advisory only**; the turn terminalizes on the state signal, never on `result` alone. The daemon **MUST** emit exactly one terminal `turn-*` per turn; duplicates fold idempotently (T).

**Heartbeat:** the daemon emits `heartbeat` **only while a turn is `running`**, ≥ every `HEARTBEAT_INTERVAL` (5 s), coalesced.

**Status** (pure function of projection + the consumer's *own* connection state — no cross‑machine clock comparison):

| status | condition |
|---|---|
| `idle` | no `running` turn, no live bg task, no open permission |
| `running` | a turn is `running` and (consumer disconnected OR a higher `seq` was seen within `STALL_WINDOW`) |
| `running-background` | no `running` turn but ≥1 live bg task |
| `awaiting-input` | ≥1 open `permission-request` |
| `stalled` | a turn is `running`, the consumer **is currently connected**, and no higher‑`seq` event for this session has been seen for ≥ `STALL_WINDOW` (20 s), measured by the consumer's own connected wall‑clock |
| `offline` | writer lease present but no event/heartbeat progress while consumer connected (daemon presumed down) |
| `unknown` | the consumer itself is disconnected from the server |
| `client-too-old` | a control event with `vmin > itsMax` was folded (§7) |

Stalled/offline use only (a) server‑`seq` monotonicity and (b) the consumer's own local clock for its own connected duration. No timestamp from another machine is ever compared.

---

## 18. Crash / catch‑up recovery

**App catch‑up:** always `after_seq` from cursor (or snapshot fast‑path §11.3). Works identically whether the CLI is online, offline, or dead. Any locally‑optimistic state is overwritten by the folded authoritative state.

**Daemon restart:** the new daemon folds the log, takes the lease (§13), and per session rebuilds **agent‑internal** state:
- Find the last logged agent message anchor `A` for the session.
- Claude: start the SDK with `resume`; enter **suppress mode** — drop every replayed SDK message (incl. `SDKUserMessageReplay`, matched by `uuid`) until it re‑observes `A`; then switch to **emit mode**. Replayed history is **never** appended to the log (no duplication).
- ACP: if the agent advertises `loadSession`, call `session/load` and apply the same anchor‑then‑emit rule. If not, the session enters defined status `degraded:agent-memory-lost`: full conversation history remains intact for apps (from the log); the agent continues from a **fresh context**; prompts are **never auto‑replayed** (no side‑effect re‑execution).
- In‑flight turn at crash (`turn-started`, no terminal): the new daemon emits `turn-interrupted{reason:'crash'}`. **At‑most‑once: no auto‑re‑run.** The user resends if desired. Cursor discipline: the daemon advances its consumed watermark past a `user-message` only after that turn's terminal event is durably appended; on restart it guards by "terminal for this `requestEventId` already present? skip : it was the interrupted turn."
- Open `permission-request` without response at crash: re‑emitted with the same `reqId` (R) so any prior/future answer still matches; never double‑prompts.

---

## 19. Guarantees (provable from the rules)

- **Exactly‑once input delivery (I1):** producer retries until echoed (≥once) + consumer dedupe by `eventId` (≤once) ⇒ exactly once. Turn *execution* is at‑most‑once across crash by explicit policy.
- **Cancel parity (I2):** `cancel` is a class‑K log event with the same append/echo/fold path as `user-message`.
- **Deterministic order & convergence (I5):** `seq` is a total order; fold is pure; single agent writer per epoch ⇒ no cross‑writer interleaving.
- **No silent stuck:** every turn reaches a terminal `turn-*` — via the §17 signal, §14 cancel, §18 crash, or §11.5 dead‑letter.
- **Catch‑up (I4):** retained log + `after_seq` + snapshot ⇒ any consumer reconstructs full state with the CLI offline or dead.

---

## 20. Legacy compatibility

The daemon **continues to emit the existing legacy envelopes unchanged** (raw agent JSONL, `closeClaudeSessionTurn('completed')`). Legacy apps keep working exactly as today (their single authority = legacy envelopes). New apps derive truth solely from §9 events and treat legacy `completed` as advisory. No app mixes the two authorities, so there is no dual‑truth; the daemon keeps both consistent because both are projections of its one internal turn machine (§17).

---

## 21. Security & audit

Control events are authorized by the **same account/session write authorization** that already gates message append — an accepted, explicit decision: control‑via‑message has the identical trust domain as sending a message. Every event carries `by`; the daemon logs issuers. No new privilege boundary is introduced.

---

## 22. Conformance & observability

- **Pure‑fold conformance:** a shared golden event‑log corpus; the app fold and the CLI fold run it in CI and **MUST** produce identical projections.
- **Divergence detection:** any consumer MAY emit `projection-digest{uptoSeq,hash}` (rate‑limited, opaque). Two digests for the same `uptoSeq` with different `hash` is an invariant violation and **MUST** be alerted.
- **A/B safety:** by §13, only the highest‑epoch writer acts; `happy-cli-next` and prod cannot both write a session.

---

## 23. Constants

| Name | Default | Tunable |
|---|---|---|
| backoff base / cap | 500 ms / 15 s | yes |
| outbox bound | 2000 events / 32 MB | yes |
| chunk plaintext max | 64 KB | no (encryption‑stall bound) |
| `GRACE_INTERRUPT` / `GRACE_ABORT` | 3 s / 2 s | yes |
| `PERMISSION_TIMEOUT` | 300 s | per session |
| `HEARTBEAT_INTERVAL` | 5 s | yes |
| `STALL_WINDOW` | 20 s | yes |
| snapshot trigger | 500 events, or 10 min, or turn‑end if >100 since last | yes |

---

## 24. Non‑message RPCs (file/shell/machine control) — bounded best‑effort tier

`bash/readFile/writeFile/listDirectory/getDirectoryTree/ripgrep/difftastic` and machine‑level `spawn/stop/fork/duplicate/stop-daemon` are **not** in the durable log. They are a **best‑effort request/response tier**: client‑side timeout (default 15 s, per‑method override), an idempotency key per request, bounded retry (≤3, backoff) for idempotent methods (reads, `stop-*`, `spawn` with a client‑supplied id). `bash`/`writeFile` are **not** auto‑retried (side effects); a timeout surfaces a definite `failed`, never a spinner. `stop-session`/`stop-daemon` MAY also be mirrored as a `cancel`‑class log event when they target a logged session, inheriting durability. This boundary is intentional and complete.

---

## 25. Explicitly out of scope (with rationale)

- **Drafts / typing indicators / presence cursors** — ephemeral, per‑device UI. Putting them in the durable log would bloat history and add no recovery value. If desired they ride the existing transient poke channel as non‑logged hints; their loss is harmless. Not part of this layer.
- **Agent‑flavor switching mid‑session** (Claude↔Codex↔Gemini) — a new agent backend is a new session by design; this layer is agent‑agnostic but does not migrate a live conversation between backends.
- **Server‑side features** (server‑side queues, presence service, push fan‑out) — deliberately excluded; the constraint is zero server change.

These are scoped out by decision, not unsolved.

---

## 26. Consumer (happy‑app) integration plan

How this lands in the existing app without rewriting the UI or risking legacy clients.

**26.1 Seam — the raw decrypt boundary.** The app already decrypts inbound records then calls `normalizeRawMessage()` (`sources/sync/typesRaw.ts:735‑740`), which drops unrecognized records — exactly why legacy clients ignore our new events. The new consumer taps **after decrypt, before `normalizeRawMessage`**:

```
decrypt ─┬─▶ EventLog.ingest(rawEvent)   ← NEW: pure fold → Projection
         └─▶ normalizeRawMessage(...)    ← UNCHANGED: legacy content rendering
```

`EventLog` is a new module under `sources/sync/` (beside `reducer/`, not inside it). It owns the pure `fold` and the `Projection` (§11.2). The legacy path is untouched.

**26.2 Read path — reuse the existing cursor.** `sources/sync/sync.ts` already maintains a `sessionLastSeq` map and loops `GET /v3/.../messages?after_seq=…` on (re)connect (~`sync.ts:1816‑1957`), with `before_seq` backward paging. We add no transport: the same fetched records are fanned into `EventLog.fold` in `seq` order, advancing the same cursor. The snapshot fast‑path (§11.3) reuses `before_seq` to locate the latest `snapshot`. The socket poke is unchanged — it still just triggers a pull.

**26.3 Write path — generalize the existing outbox.** `sync.ts` already has `pendingOutbox`/`flushOutbox()` (~`sync.ts:1753`) posting messages with a `localId`. Generalize it from "messages" to typed **events** keyed by `eventId`, retry‑until‑echoed (§10.1): `sendMessage()`→append `user-message`; `sessionAbort()` (`sources/sync/ops.ts`)→append `cancel` (kills the lost‑abort bug); add `sendSteer()`, `respondPermission()`, `setMode()`. Optimistic UI is preserved; the only change is durability + echo‑based ack instead of an unacked socket call.

**26.4 Projection → existing state (no screen rewrite).** The Projection becomes the authority for turn/permission/status; the legacy reducer keeps rendering message bodies during transition. Re‑point a few selectors in `sources/sync/storage.ts`:
- `turns[*].state` → session running/`thinking` + the §17 status enum, replacing the inferred `thinking` and the unread heuristic at `storage.ts:568‑588` (now a deterministic function of turn terminalization).
- `openPermissions` → the existing permission UI (instead of the RPC‑driven prompt).
- honest status (`offline/stalled/awaiting-input/running-background/client-too-old`) → a new session field consumed by `SessionView`/list rows; the cancel button/spinner binds to projection state, not to an in‑flight `await` (fixes the forever‑spinner).
- message content still comes from the legacy reducer initially, so `ChatList`/`SessionView` are unchanged at first.

**26.5 Coexistence (per §20), phased.**
- **Phase A — shadow:** `EventLog` runs read‑only; folds, computes the projection, emits `projection-digest` (§22). UI 100% legacy. Compare app digest vs daemon digest for the same `uptoSeq` across real sessions to prove fold convergence. Zero user‑visible change. Gated by a mods‑page toggle (`useSettingMutable`).
- **Phase B — state cutover:** flip turn‑state/permission/status selectors to the projection behind the same flag. Content still legacy. The cancel/stuck/honest‑status wins land here.
- **Phase C — content cutover:** render from `turn-output`/`tool-*` projection items; retire the legacy reducer for new clients. Legacy clients keep working forever.

No dual‑truth at any phase: each concern has exactly one authority per client (§20); the flag only decides which.

**26.6 Correctness/perf specifics.** Fold cost is O(events since last snapshot) (§11.3), runs in the existing sync tick (no new thread). Large `tool-result` chunks reassemble by `(messageId, partIdx)` before hitting the store. Live partials stay ephemeral (§11.4): rendered by `messageId`, then *replaced* by the committed `turn-output` on fold (the reducer already keys by id). The `fold`/`Projection` module **MUST** be extracted to shared code consumed by both `happy-app` and `happy-cli` so the golden‑corpus conformance test (§22) is meaningful.

**26.7 Rollout.** Three independently revertible mods matching the repo convention: `mod: comm-layer shadow consumer` (A), `mod: comm-layer state cutover` (B), `mod: comm-layer content cutover` (C). Each is mods‑page‑gated and invisible to legacy clients. Phase A is production‑safe immediately — it changes nothing the user sees and produces real convergence data before any behavior depends on it. First concrete step: extract the shared `fold`/`Projection` module and wire the Phase‑A read‑path tap.

---

*Build §13 (lease), §14 (cancel), §11 (consumer/fold), §12 (steer), §17 (turn machine), §18 (recovery) at the agent‑agnostic seam `happy-cli src/agent/{core,transport}`, Claude‑first via `happy-cli-next`; integrate the consumer per §26. The relay server is not touched. This specification is complete; there are no deferred problems.*
