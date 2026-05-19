# joy-agent — Package Specification

Normative (RFC 2119). Companion to **`comm-layer-spec.md`** (protocol authority) and **`joy-daemon-spec.md`**. This document specifies the **joy-agent** package only. "§N" unqualified = a section of `comm-layer-spec.md`.

Owned core, not a mod. Regular commit history; does not track upstream.

---

## 1. Role

joy-agent runs the actual **model/tool loop for exactly one session**. It is spawned and supervised by joy-daemon, **one joy-agent process per session, 1:1**. It is the place where backend specifics live (Claude Agent SDK first; Codex, ACP, Gemini behind the agent‑agnostic seam). It knows **nothing about the relay server** and owns **no durable state** — it talks only to joy-daemon over the local agent channel (joy-daemon spec §4.3).

joy-agent is where "different agents" is realized: each backend is an adapter behind one internal interface. **Wrap, do not rewrite** existing backend integrations (Codex app‑server client, ACP, Gemini) — only the comm/turn/cancel behavior is owned and reimplemented; the backend glue is vendored/adapted.

---

## 2. Owns (responsibilities)

1. **The agent‑agnostic seam.** One internal interface — `start(turn)`, `steer(content)`, `interrupt()`, `abort()`, `close()`, `stopTask(taskId)`, plus an event stream out — implemented per backend. joy-daemon and the protocol never see backend types.
2. **The turn state machine (§17), driven by runtime state signals — never by `result`/prompt return.** Claude: SDK `session_state_changed: idle|running|requires_action` (`sdk.d.ts:2702‑2705`) is the authoritative turn boundary. ACP: `PromptResponse.stopReason`. A `result` is advisory; the turn terminalizes on the state signal. Emits exactly one terminal turn fact per turn.
3. **The cancel/interrupt ladder (§14):** `Query.interrupt()` → `AbortController.abort()` → `Query.close()`, plus `stopTask()` for live background tasks; ACP `session/cancel` → `StopReason.cancelled`. joy-agent *executes* the ladder; joy-daemon *sequences and records* it.
4. **Mid‑turn steering (§12):** apply `steer` input to a running turn via the backend's live input (Claude streaming‑input push; ACP follow‑up). If the backend cannot accept mid‑turn input, signal joy-daemon to reify as the next turn per §12.
5. **Background tasks (§16):** surface `bg-*` lifecycle as turn‑independent facts; `stopTask` on cancel.
6. **Partial vs committed (§11.4):** emit streaming deltas as ephemeral partials and the final assembled message as the committed fact, so the daemon logs only committed, idempotent content.
7. **Agent metadata (§12):** surface available slash commands / tools / models / MCP status from the backend init (`supportedCommands()`, system‑init `slash_commands`, ACP `available_commands_update`). Slash commands (incl. `/btw`) are opaque content — joy-agent forwards verbatim, never parses them.
8. **Agent‑internal recovery on (re)spawn (§18):** on restart, rebuild backend memory via SDK `resume` / ACP `session/load` using the **anchor‑then‑emit suppress** rule so replayed history is never re‑emitted; if the backend cannot reload, report `degraded:agent-memory-lost` and continue from fresh context. **Never auto‑replay prompts** (no side‑effect re‑execution).

---

## 3. Does NOT do (out of scope)

- No relay connection, no event persistence, no cursor/outbox/lease — joy-daemon owns all of that.
- No durable state of its own; if joy-agent dies, the daemon detects it (missing heartbeat/terminal) and applies §18. joy-agent holds only in‑flight, reconstructible state.
- No session multiplexing — exactly one session per process.
- No app/cli contact — it speaks only to joy-daemon (joy-daemon spec §4.3).
- No backend rewrites — backend glue is wrapped, not owned.

---

## 4. Boundaries

### 4.1 joy-agent ↔ joy-daemon (the only channel)
Per joy-daemon spec §4.3. **Down:** input events in `seq` order (`user-message`, `steer`, `cancel`, `interrupt`, `mode-change`). **Up:** agent facts (`turn-*`, `tool-*`, `bg-*`, `permission-request`, ephemeral partials, `agent-metadata`). joy-agent reports facts; joy-daemon decides ordering, idempotency, persistence, and the legacy facade. Heartbeats: joy-agent **MUST** signal liveness while a turn is `running` so the daemon can emit `heartbeat` (§17) and detect a crashed agent.

### 4.2 joy-agent ↔ backend (Claude SDK / Codex / ACP / Gemini)
Behind the seam (§2.1). Each adapter maps backend events to the internal turn/tool/bg/partial vocabulary and maps the internal control verbs to backend calls. The adapter is the only backend‑aware code in the system.

### 4.3 Permission/elicitation (§15)
joy-agent raises a permission/elicitation request as an up‑channel fact and **awaits** the daemon delivering the resolved answer (the daemon sourced it from the log; first response by `seq` wins; timeout auto‑denies). On respawn, the daemon replays the recorded answer by `reqId`; joy-agent **MUST NOT** re‑prompt (non‑idempotent).

---

## 5. Invariants joy-agent must uphold

- Exactly one terminal turn fact per turn; turn boundary = the §17 state signal, never `result`.
- Cancel actually stops the agent (ladder run to completion before the daemon emits the terminal).
- Backend memory recovery never re‑emits replayed history and never auto‑re‑runs prompts (§18).
- Backend specifics never leak past the seam.

---

## 6. Internal structure (informative)

`seam.ts` — the agent‑agnostic interface + event vocabulary. `backends/claude.ts` — Claude Agent SDK adapter (first). `backends/{codex,acp,gemini}.ts` — wrap existing integrations. `turnMachine.ts` — §17. `cancelLadder.ts` — §14. `link.ts` — the joy-daemon channel client. `recovery.ts` — §18 anchor‑then‑emit. `index.ts` — process entry (one session).

---

*joy-agent is one session's brain: backend‑specific, daemon‑supervised, relay‑oblivious, durable‑state‑free. It produces facts; joy-daemon makes them durable and ordered.*
