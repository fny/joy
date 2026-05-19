# Happy — Resilient Message Queue & Client Catch‑Up

**Reliable message delivery, cancellation, and client resync — server implementation untouched — covering client‑can't‑reach‑CLI, CLI death, background tasks, the Claude SDK / ACP runtime contract, and a candid list of open problems.**

---

## 1. Symptoms we are solving

- Messages sometimes never reach the CLI; the session "gets stuck."
- Cancel/abort frequently does nothing: "abort sent but never received," forever spinner, or the agent keeps doing more tasks after cancel.
- We want to genuinely cancel an in‑progress action.
- A client that cannot communicate with the CLI must still get up to speed.
- **Hard constraint:** keep the relay server; **do not change the server implementation**. All new behavior is client + CLI.

---

## 2. Root‑cause diagnosis

- **2.1 Abort is ephemeral, messages are half‑durable.** User messages are POSTed and persisted with a monotonic `seq`; abort is a socket RPC with no client timeout, a ~15 s server grace, and no persistence/replay — lost if the daemon is briefly absent. That asymmetry is the core bug.
- **2.2 Queue not drained on cancel.** Remote Claude launcher's `while (!exitReason)` only fires the turn `AbortController`; never `session.queue.reset()`. Queued messages each become a new turn → "cancel keeps not working."
- **2.3 Wrong abort surface for Claude.** Only `AbortController` is used, not the SDK `Query.interrupt()` / force‑kill ladder Codex already has.
- **2.4 Outgoing‑queue races / no turn correlation.** Two uncoordinated queues, a 250 ms tool‑call delay, `flush()/destroy()` without locking, `processQueueInternal` drops `type==='system'`. No turn ID on the wire → dropped messages are undetectable.
- **2.5 Queue lives only in CLI memory.** `MessageQueue2` is in‑daemon; restart/crash loses work; offline daemon shows "sent" for work it never sees; nothing authoritative for a client to reconcile against.

---

## 3. Design goals

1. A message, once accepted, reaches the agent exactly once across reconnects and daemon restarts.
2. Cancel is as durable as a message, ordered relative to messages, idempotent, and actually stops the in‑progress action.
3. The UI never lies: no infinite spinner, no false "sent," no dead cancel button.
4. A client can fully resync from the server alone — independent of whether the CLI is reachable or alive.
5. **Zero server‑implementation changes.** Ship as client + CLI mods.

---

## 4. Mechanism: log‑as‑queue on the server's *existing* store

**One durable, ordered log per session is the source of truth. The server already *is* that log. We change what the encrypted payload *means*, not the server.** Queue and turn state are **projections** each peer folds from the shared, server‑persisted, E2E‑encrypted, `seq`‑ordered event log.

### 4.1 Unified intent + fact log (inside the existing message channel)

```
{ eventId,        // producer-generated UUID — idempotency key (inside encrypted payload)
  type,           // user-message | cancel | interrupt
                  // | turn-started | turn-completed | turn-failed | turn-cancelled | turn-interrupted
                  // | bg-started | bg-progress | bg-notification | bg-exited
                  // | heartbeat | cursor | snapshot | rejected
  v,              // event schema version (forward/back-compat across mixed peers)
  turnId, targetTurnId?,
  payload }       // E2E-encrypted; server stores/relays it opaquely
```

The server assigns the authoritative per‑session `seq` at persist time; `seq` is the total order all peers fold.

### 4.2 Verified — no server change required

- **Incremental catch‑up already exists and is already the production resync path.** `GET /v3/sessions/:id/messages?after_seq=N` → `seq > N` ascending; `before_seq` → backward paging (`happy-server/.../v3SessionRoutes.ts`). Monotonic per‑session `seq` on each `db.sessionMessage`. The CLI already loops on `after_seq` (`happy-cli apiSession.ts`); the app already uses a `sessionLastSeq` map the same way (`happy-app sync.ts`).
- **History is retained for the session's lifetime — no pruning.** `sessionMessage` rows are deleted **only** by explicit user session‑delete (`happy-server sessionDelete.ts`, called from `sessionRoutes.ts:401`). There is no cron/TTL/retention sweep. So a long‑offline consumer can always catch up from its cursor while the session exists. *(This resolves what was previously a critical open risk.)*
- **Unknown record types are safe‑ignored.** `normalizeRawMessage()` (`happy-app typesRaw.ts:735‑740`) `safeParse`s and returns `null` for unrecognized records — never reaches the reducer, never renders.
- **They cannot pollute unread/notifications.** `unreadSessionIds` (`happy-app storage.ts:568‑588`) is set purely from session‑state transitions, never from inbound message type.
- **CLI won't mis‑queue them.** Unknown records fail `UserMessageSchema`/`FileEventMessageSchema` and go to a generic `'message'` event (`happy-cli apiSession.ts:364‑388`).

Legacy clients drop these records; new client/CLI logic intercepts them **at the raw decrypt boundary, before `normalizeRawMessage`**.

### 4.3 Idempotent producer

Client and CLI write events through the existing POST path with a persisted local outbox, retrying with backoff until they observe their own `eventId` echoed back carrying a server `seq`. Duplicates collapse on `eventId` at the consumer — no server upsert.

### 4.4 Cursor consumer + turn state machine — driven by *state signals*, not return values

Each peer keeps `lastAppliedSeq` and folds `after_seq` into:

```
Turn = { id, requestSeq, state }
state ∈ pending | running | cancelled | completed | failed | interrupted
```

**The turn boundary is an explicit runtime state signal, not a result/prompt return.** For Claude this is the SDK `session_state_changed: idle|running|requires_action` message (`sdk.d.ts:2702‑2705`; the d.ts itself calls `idle` the "authoritative turn‑over signal" — it fires *after* held‑back results flush and the background‑agent loop exits). For ACP it is `PromptResponse.stopReason` (`end_turn|max_tokens|max_turn_requests|refusal|cancelled`). `result`/prompt‑return is demoted to "a result arrived," **not** "the turn is over." This is the structural fix for the "completed lies while background tasks stream" bug.

`cancel` carries `targetTurnId` and is idempotent: applied to the current turn if running; **tombstoned and applied on start** if it arrives (lower `seq`) before its `turn-started` (pre‑emptive cancel — the "I mashed stop immediately" case); no‑op if the turn is already terminal.

### 4.5 Cancel is a ladder + task‑stop + reason‑record (CLI side)

On applying `cancel`: (1) `Query.interrupt()` (`sdk.d.ts:1674`, graceful) → (2) per‑turn `AbortController` (hard) → (3) `close()` (`sdk.d.ts:1853`, force; Happy never calls this today → subprocess leak) — plus **`stopTask(taskId)`** (`sdk.d.ts:~1841`) for live background tasks — plus drain the pending queue — plus record the terminal reason (`cancelled` vs the four `result` error subtypes vs abort) in the log.

---

## 5. Architecture diagram

```
                         ┌──────────────────────────────────────────────┐
                         │            happy-server (UNTOUCHED)           │
                         │  durable, per-session, monotonic `seq` log    │
                         │  • persists every E2E blob (opaque)           │
                         │  • GET /v3/.../messages?after_seq=N (exists)  │
                         │  • no TTL/cron prune; deleted only on session-delete │
                         │  • transient socket broadcast = "poke"        │
                         └───────────────▲───────────────▲──────────────┘
       append (POST, idempotent           │               │  append (POST, idempotent
       by eventId; retry until            │               │  by eventId)
       echoed back with seq)              │               │
   ┌──────────────────────────────────────┴──┐   ┌────────┴───────────────────────────────┐
   │              CLIENT (happy-app)          │   │      CLI daemon (happy-cli)            │
   │  outbox(persisted) ── writes ──▶         │   │  ◀── writes turn-*/bg-*/heartbeat/...   │
   │  cursor lastAppliedSeq ──┐               │   │  cursor lastAppliedSeq ──┐              │
   │   fold log → projection: │  after_seq=N  │   │   fold log → projection: │ after_seq=N │
   │     • message list       │   (replay)    │   │     • work queue (derived)│  (replay)   │
   │     • turn state machine ┘               │   │     • turn state machine ─┘             │
   │     • honest status (online/offline/     │   │   per-turn: idle-driven boundary;       │
   │       stalled/awaiting-permission)       │   │   interrupt→abort→close ladder          │
   └──────────────────────────────────────────┘   └─────────────────────────────────────────┘

   Truth = the server-persisted ordered log.  The socket "poke" is only latency.
   The queue is NOT stored in the CLI — it is a projection both peers recompute.
   Client resyncs from the server even when the CLI is offline or dead.
```

---

## 6. Client catch‑up when it cannot reach the CLI

No server change. The client folds the same `after_seq` stream it already fetches; the CLI is just another peer that also folds it. From the log + heartbeat gap the client renders honest status — *reachable* / *offline, N queued* / *turn stalled* / *awaiting your permission answer* — never a spinner bound to an unacked RPC. On reconnect it reconciles optimistic local state against the folded log (a turn it thought "running" that the log shows terminal becomes a clear retryable state). `seq` is the linearization point, so multiple devices converge from their own cursors; a new device is instantly correct.

---

## 7. CLI / daemon death

The CLI is **not a single Claude process** — it's a multi‑agent, multi‑session machine **daemon** (Claude, Codex, OpenClaw, Gemini, ACP; machine RPCs `spawn/stop/fork/duplicate/stop-daemon`; file/shell RPCs `bash/readFile/writeFile/listDirectory/getDirectoryTree/ripgrep/difftastic`). So "CLI death" = all hosted sessions, in‑flight file/shell RPCs, pending spawns, and the control channel drop at once.

- **Queued work is non‑destructive by construction.** `user-message` records are durable in the server log; a restarted daemon does `after_seq=lastAppliedSeq` per session and resumes. (Contrast: today's in‑memory `MessageQueue2` dies with the daemon — the bug.)
- **The client stays up to speed** — it reads the same log + stale heartbeats and shows "agent offline, N queued."
- **In‑flight turn at the instant of death** (`turn-started`, no terminal): detect via missing terminal + stale heartbeat ⇒ `interrupted`; **at‑most‑once, no auto‑replay**, surface "interrupted by agent crash — resend?"; cursor advanced past a message only after that turn's terminal event is durable, and on restart guard by "does a terminal event for this `requestSeq` already exist?"
- **Background tasks are not in‑SDK‑recoverable.** They live in the SDK child; the daemon dying kills them. Their `bg-*` lifecycle events in the log let a catching‑up client at least *report* "background task interrupted" instead of silent loss — but the work itself is gone (see §9).
- **Daemon‑level reconciliation.** After restart the daemon may host a different set of sessions; the app must reconcile per‑session from cursors, not assume continuity. Non‑message RPCs (file/shell/machine‑control) are **not** in the log — see §8.

---

## 8. Scope: agent‑agnostic transport seam; non‑message RPCs

The durable‑log / turn / cancel / catch‑up **contract is defined at the agent‑agnostic session/transport seam** (`happy-cli src/agent/{core,transport}`), not inside `claudeRemoteLauncher` — otherwise Codex/OpenClaw/Gemini keep their divergent bugs. `happy-cli-next` remains the low‑risk **Claude‑first** vehicle, but the contract is agent‑neutral from day one.

**Non‑message RPC surface decision.** `bash/readFile/writeFile/listDirectory/getDirectoryTree/ripgrep/difftastic` and machine‑level `spawn/stop/fork/duplicate/stop-daemon` are transient request/response RPCs with the *same* fragility as abort, and are **not** rescued by the log. Phase plan treats them as **explicitly best‑effort with client‑side timeout + retry/idempotency keys** (Phase 0 style), *not* folded into the durable log, unless a specific one (e.g. `stop-session`) is promoted later. This is a deliberate, stated boundary, not an omission.

**Reuse unchanged:** the entire server, auth, encryption, socket transport, legacy passthrough wire, permission handler, Claude SDK, the existing `after_seq` resync path. **Replace:** `session.queue` + `OutgoingMessageQueue` + `claudeRemoteLauncher` + `SDKToLogConverter`. **Add (client+CLI only):** the event types, raw‑boundary interception, the state‑signal‑driven turn machine, the cancel ladder, queue‑drain, honest‑status UI.

---

## 9. Agent‑runtime contract (Claude SDK + ACP) — items a solid build must handle

Verified in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` unless noted.

| # | Item | Evidence | Why it matters |
|---|---|---|---|
| 1 | Turn boundary = `session_state_changed: idle` (not `result`) | `:2702‑2705` | Defines the turn state machine (§4.4); fixes "completed lies" |
| 2 | `result` is a 4‑way error union (`error_during_execution\|error_max_turns\|error_max_budget_usd\|error_max_structured_output_retries`) + `success` | `:2537` | Log records subtype; recovery differs (retry vs hard stop vs quota) |
| 3 | `interrupt()` / `AbortController` / `close()` / `stopTask(taskId)` | `:1674/:957/:1853/~:1841` | The cancel ladder; `close()` prevents subprocess leak; stop live bg tasks |
| 4 | Background‑task lifecycle `task_started/progress/notification` (status incl. `stopped`) | `:2807/:2772` | First‑class turn‑independent `bg-*` log events; honest status; crash reporting |
| 5 | Partial/stream events (`includePartialMessages`, `SDKPartialAssistantMessage`) | `:1157/:2469` | **Non‑idempotent — excluded from the durable log; never replayed** |
| 6 | `compact_boundary` w/ preserved‑segment anchors | `:1985` | Catch‑up/replay must start after last compaction; cost accounting |
| 7 | `resume` rewrites session IDs; `SDKUserMessageReplay` exists | CLAUDE.md / `:2467` | Log keyed on a stable *logical* session id we own; suppress resume‑replayed msgs from the log (double‑append hazard) |
| 8 | Mid‑session `setPermissionMode` / `setModel` | `:1681/:1688` | Must be log events so projection/catch‑up restore them |
| 9 | `onElicitation`, `mcpServerStatus()` | `:1134/:1749` | Elicitation non‑idempotent (record answer, replay it, don't re‑ask); surface MCP health |
| 10 | Replay‑relevant types: `SDKAPIRetryMessage`, `SDKRateLimitEvent`, `SDKAuthStatusMessage` | `:2467` | Surface as honest status ("rate‑limited / re‑auth"), not a dead spinner |

**ACP parallels** (line refs from audit; structurally consistent with `runAcp.ts`/`sessionUpdateHandlers.ts`, not individually line‑verified): `session/load` is the replay/catch‑up primitive and is **currently MISSING** (CLI‑restart catch‑up should use it, capability‑gated, else fall back to bounded prompt replay); `StopReason.cancelled` is **never emitted** (same "completed lies" bug); permission/mode/model state is **not durable**; tool‑call lifecycle ordering must be preserved; non‑text `ContentBlock`s are dropped; agent capabilities aren't negotiated.

**Two replay layers, coordinated:** the server log = client‑facing truth (cursor catch‑up); the agent runtime's own replay (SDK `resume` / ACP `session/load`) rebuilds agent‑side state after daemon death. The emitter must suppress agent‑replayed history from the durable log to avoid duplication.

---

## 10. Phased plan — client + CLI only, no server deploy

| Phase | Change | Payoff |
|---|---|---|
| 0 | Client abort timeout + real error surfacing + idempotent re‑send; same timeout/retry/idempotency for file/shell/machine RPCs (best‑effort tier) | Kills the lying/forever spinner; instant UX win |
| 1 | Drain pending queue on cancel + `interrupt → abort → close` ladder + `stopTask` | Cancel actually stops the agent and the queued‑turn parade |
| 2 | Tunnel `user-message/cancel/turn-*/bg-*/heartbeat/cursor` as opaque versioned records; intercept at the raw decrypt boundary; fold to projections; exclude partial/replay | Durable, ordered, replayable; abort as durable as a message |
| 3 | State‑signal‑driven turn machine (idle/`StopReason`) + heartbeat + daemon‑level crash recovery (§7) + pre‑emptive‑cancel tombstones + dead‑letter (`rejected`) | Survives daemon death; deterministic interrupted‑turn; no silent stuck |
| 4 | Client reconciliation + honest status (incl. awaiting‑permission, stalled) from the folded log | No lying UI; client up to speed even when CLI is dead |

Built at the agent‑agnostic seam (§8), Claude‑first via `happy-cli-next`. Scoped to the repo's mod convention; no coordinated server deploy.

---

## 11. Symptom → outcome

| Today | After |
|---|---|
| Message never reaches CLI | CLI resumes from `after_seq`; poke loss tolerated; producer retries until echoed |
| Stuck / forever spinner | Client timeout + log‑authoritative turn state + reconciliation; dead‑letter prevents silent hang |
| Abort sent, never received | Abort is a durable, ordered, idempotent log record — replayed on reconnect |
| Cancel doesn't work, more tasks run | Queue drained on cancel + interrupt/close ladder + `stopTask` |
| "Completed" then more output streams | Turn boundary = `idle`/`StopReason`, not `result`; `bg-*` events |
| Can't get up to speed when CLI down/dead | Client folds the retained server log via `after_seq` — never needs the CLI |

---

## 12. Open problems / not yet solved (candid)

**Resolved since review:** server message retention — confirmed *no* TTL/cron pruning; deleted only on user session‑delete (§4.2).

**Still open — must be closed before implementation past Phase 1:**

1. **`seq` vs causal order beyond pre‑emptive cancel.** Tombstoning handles cancel‑before‑start; concurrent multi‑writer intent ordering (two devices prompting/cancelling the same session) is defined by `seq` but may be *semantically* chaotic. Need an explicit dispatcher serialization rule.
2. **Agent‑side replay duplication.** SDK `resume` re‑emits history (`SDKUserMessageReplay`); ACP `session/load` may be unsupported → bounded prompt replay re‑runs side effects (whole‑session at‑most‑once problem). Suppression/coordination rule not fully specified.
3. **Permission/elicitation blocks the turn.** `canCallTool`/elicitation awaits a human; a dead client → indefinite block. Need timeout/escalation, honest "awaiting permission" status, and replay‑recorded answers (non‑idempotent — don't re‑ask).
4. **Log compaction/snapshot is load‑bearing but under‑specified.** Who writes `snapshot`, its contents, "latest snapshot + tail" discovery, and interaction with heartbeat/large‑output volume. (Retention being unbounded *helps* but doesn't remove the bloat/replay‑cost problem.)
5. **Producer backpressure.** Huge tool output (tens of MB) + slow/disconnected link → unbounded outbox, head‑of‑line blocking, sync‑encryption event‑loop stalls. Needs bounded buffering/coalescing.

**Significant, lower urgency:** schema versioning across mixed peers (the `v` field exists in the envelope but the compat rules aren't written); legacy dual‑truth (idle‑driven turn events vs the unchanged `closeClaudeSessionTurn('completed')` legacy clients still see); precise skew‑free stalled‑detection heuristic; security surface change (control‑via‑message lets any session‑writer inject cancel/mode‑change — same trust domain, but make it an explicit accepted decision); testing/observability (client↔CLI projection‑divergence detection, A/B against the same live log without corruption, metrics).

This document is **not** presented as complete. §1–§11 are sound and committable; §12 enumerates what remains, and items 1–5 there are correctness‑critical.
