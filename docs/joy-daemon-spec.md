# joy-daemon — Package Specification

Normative (RFC 2119). Companion to **`comm-layer-spec.md`**, which defines the wire protocol, event log, turn machine, lease, cancel, recovery, and guarantees. This document specifies the **joy-daemon** package only: its responsibilities, boundaries, and what it owns. Where this references "§N" without qualification it means a section of `comm-layer-spec.md`.

This is **owned core**, not a mod. It does not track upstream `slopus/happy`. It is committed as regular history. The mod/replay convention applies only to the UI (`happy-app`).

---

## 1. Role

joy-daemon is **the communication core**. It is the only component that connects to the relay server, the only writer of agent events for the sessions it hosts, and the owner of all durable‑log machinery. It hosts multiple sessions; **each session is bound to exactly one agent**. There is **no fan‑out**: the daemon never broadcasts a session to multiple local listeners, and a session never has more than one agent.

It is **agent‑type‑agnostic across sessions**: different sessions may run different backends (Claude, Codex, Gemini, ACP). It is **not** agent‑specific within a session.

One joy-daemon per machine/account, enforced as a singleton (§13 lease/epoch, extended to machine scope — see §4.4).

---

## 2. Owns (responsibilities)

1. **The single relay connection.** All traffic to/from `happy-server` for every hosted session. The server is unmodified; joy-daemon uses only the existing append (`POST …/messages`), incremental read (`after_seq`/`before_seq`), and the transient poke (§6 of the protocol spec).
2. **The durable event log machinery (§10, §11):** the persisted idempotent outbox, `eventId` echo‑ack, the per‑session cursor (`lastAppliedSeq`), the pure fold → `Projection`, and the snapshot fast‑path. The daemon is the sole **agent writer** (§13) for its sessions and the authority that emits `turn-*`, `tool-*`, `bg-*`, `permission-request`, `heartbeat`, `snapshot`, `cursor`, `rejected`.
3. **Session lifecycle.** Create, run, stop, and crash‑recover sessions per §18. One agent process per session (joy-agent), spawned and supervised by the daemon.
4. **The single‑writer lease (§13)** for each session, and the **machine‑level daemon singleton** election (§4.4).
5. **The legacy‑wire compatibility facade (§20).** The daemon continues to emit the existing legacy envelopes unchanged so an unmodified relay server and stock/old `happy-app` keep working; the new event‑log protocol is purely additive. This facade is a first‑class, conformance‑tested interface (§4.5), not best‑effort.
6. **The local control interface for joy-cli** (§4.2): list/start/stop sessions, attach input, report status. This is control, not session fan‑out.
7. **The §24 best‑effort RPC tier** (file/shell/machine‑control), with the bounded timeout/idempotency/retry rules defined there.

---

## 3. Does NOT do (explicitly out of scope)

- **No fan‑out / no serving apps.** Apps (phone/web) read the durable log from the **relay server directly**; they never connect to joy-daemon. The daemon neither sees nor serves app readers. "Multiple clients viewing a session" lives entirely at the relay/log layer.
- **No agent backend logic.** It does not run the model/tool loop, parse SDK/ACP streams, or implement the cancel ladder. That is joy-agent (§4.3). The daemon issues lifecycle/cancel *intents* to joy-agent and persists the resulting events.
- **No UI, auth/pairing/QR, sandbox runtime, interactive local‑terminal mode, config/CLI parsing.** Those are joy-cli or out of the three‑package scope entirely.
- **No multiple agents per session.** Structurally impossible by §1.

---

## 4. Boundaries

### 4.1 joy-daemon ↔ relay server
The protocol of `comm-layer-spec.md`. Server untouched. The daemon is one relay client per machine, multiplexing all hosted sessions over it. Catch‑up, ordering, idempotency, and retention guarantees are exactly §10/§11/§19.

### 4.2 joy-daemon ↔ joy-cli (local control channel)
A local IPC channel (OS‑appropriate: unix domain socket / named pipe). Surface: `daemon.status`, `session.list`, `session.start(spec)`, `session.stop(id)`, `session.attachInput(id, event)` (append a `user-message`/`steer`/`cancel`/`interrupt`/`permission-response`/`mode-change`), `session.tail(id)` (read‑only projection/event stream **for that one cli**, sourced from the daemon's already‑folded state — this is a control convenience, **not** session fan‑out; it is the same single agent's data, just surfaced to the operator). Protocol‑version handshake required (§4.4).

### 4.3 joy-daemon ↔ joy-agent (per‑session agent channel, 1:1)
Exactly one joy-agent process per session. Channel carries: **down** — input events the agent must act on (`user-message`, `steer`, `cancel`, `interrupt`, `mode-change`) in `seq` order; **up** — agent facts (`turn-*`, `tool-*`, `bg-*`, `permission-request`, partial deltas, `agent-metadata`). joy-agent is stateless with respect to the durable log; the daemon owns persistence, ordering, dedupe, lease, and recovery. The daemon translates between agent facts and log events and enforces §17 (turn boundary = runtime state signal) and §14 (cancel ladder is *executed in* joy-agent but *sequenced and recorded by* the daemon).

### 4.4 Daemon singleton (machine scope)
joy-cli launches a daemon if none is up. Concurrent launches and version skew are resolved with the **same lease/epoch mechanism as §13**, applied at machine scope, plus a pidfile/socket and a protocol‑version field: a newer cli that finds an older daemon **MUST** be able to deterministically request its replacement; only the highest‑epoch daemon serves. Exactly one daemon acts.

### 4.5 Conformance obligation
The daemon's fold **MUST** be the shared pure `fold` (§22) used identically by the app consumer; both run the golden corpus in CI and **MUST** produce identical projections. The legacy facade **MUST** pass a "stock server + stock/old app" conformance suite — this is the contract that protects correctness once the core stops tracking upstream.

---

## 5. Invariants joy-daemon must uphold

I1 durability, I2 cancel parity, I3 no‑lying‑status (the daemon supplies the authoritative projection; status itself is computed per‑consumer), I4 catch‑up, I5 convergence — all as defined in the protocol spec. Additionally: **one agent per session** (§1), **single agent writer per session** (§13), **single daemon per machine** (§4.4), **legacy facade always consistent** with the new turn machine (§20).

---

## 6. Internal structure (informative, not normative)

`protocol/` — envelope (frozen v1), event catalog (§9), pure fold + Projection (§11/§17), constants (§23). Pure, shared with the app consumer. `relay/` — relay client (server‑untouched transport), idempotent persisted outbox (§10), cursor + snapshot catch‑up (§11). `lease.ts` — per‑session + machine‑scope epochs (§13/§4.4). `agentHost.ts` — spawn/supervise one joy-agent per session; crash → §18 recovery. `control/` — the joy-cli local channel (§4.2). `legacy/` — the §20 dual‑emission facade. `daemon.ts` — wiring.

---

*joy-daemon is the comm core: one relay connection, one agent per session, many sessions, no fan‑out, legacy‑compatible. It implements the protocol of `comm-layer-spec.md`; it does not redefine it.*
