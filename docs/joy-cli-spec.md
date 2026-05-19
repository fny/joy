# joy-cli — Package Specification

Normative (RFC 2119). Companion to **`comm-layer-spec.md`**, **`joy-daemon-spec.md`**, **`joy-agent-spec.md`**. Specifies the **joy-cli** package only. "§N" unqualified = a section of `comm-layer-spec.md`.

Owned core, not a mod. The user‑facing command is **`joy`**.

---

## 1. Role

joy-cli is the thin user/operator entrypoint. It does **not** run agents and does **not** talk to the relay. Its job is: parse the command, **ensure a joy-daemon is up (launch it if not)**, connect to that daemon over the local control channel, issue the command, and render results. joy-cli is a **control client of joy-daemon** — not an agent, not a relay client, not a consumer the daemon fans out to.

---

## 2. Owns (responsibilities)

1. **Command surface (`joy …`):** session operations (`start`, `stop`, `list`, `status`, `attach`/send input, `tail`), daemon operations (`daemon status|start|stop|restart`), and pass‑through machine/file/shell ops that map to the §24 best‑effort tier.
2. **Daemon bootstrap & singleton handshake.** Detect a running daemon (pidfile/socket); if absent, launch joy-daemon and wait for readiness. Resolve concurrent launches and version skew via the **machine‑scope lease/epoch + protocol‑version handshake** (joy-daemon spec §4.4): if the running daemon is too old, deterministically request its replacement; never proceed against a mismatched daemon.
3. **The local control‑channel client** (joy-daemon spec §4.2): typed requests/responses, reconnect to the daemon, and a read‑only `tail` that renders the daemon's already‑folded projection for the operator (a control convenience for one cli — **not** session fan‑out).
4. **Foreground/ephemeral mode.** `joy <path>` for a one‑shot session **MUST** still work without a pre‑installed background service: joy-cli starts a **transient daemon instance** owned by that invocation (same joy-daemon code, not a special path), runs the session through it, and tears it down on exit. There is no separate "no‑daemon" code path — everything goes through a daemon; "foreground" just means the daemon's lifetime is bound to the cli invocation.
5. **Input authoring.** Turn user actions into the correct input events handed to the daemon to append: typing → `user-message` (or `steer` if a turn is `running` in the projection the daemon reports), Stop → `cancel`, permission answers → `permission-response`, mode/model changes → `mode-change`. joy-cli chooses `user-message` vs `steer` from the daemon‑reported state; the §12 reification rules make a wrong guess safe.

---

## 3. Does NOT do (out of scope)

- No relay connection, no event log, no cursor/outbox/lease ownership (joy-daemon).
- No model/tool loop, no backend code, no cancel ladder (joy-agent).
- No fan‑out, no serving apps (apps use the relay directly; see joy-daemon spec §3).
- Auth/pairing/QR, sandbox runtime, interactive local‑terminal mode: **out of the three‑package scope** unless explicitly pulled in later; not part of joy-cli's core mandate.

---

## 4. Boundaries

### 4.1 joy-cli ↔ joy-daemon
The local control channel only (joy-daemon spec §4.2). Every session effect is expressed as an input event the daemon appends and a projection the daemon folds and reports back. joy-cli holds no authoritative state; on reconnect it re‑reads the daemon's projection. Protocol‑version handshake mandatory.

### 4.2 joy-cli ↔ joy-agent
**None.** joy-cli never contacts joy-agent. All agent interaction is mediated by joy-daemon.

### 4.3 joy-cli ↔ relay / apps
**None.** joy-cli does not connect to the relay. Apps are unrelated readers of the relay log.

---

## 5. Invariants joy-cli must uphold

- Never act as an agent writer or relay client; all durable effects go through joy-daemon as input events (preserves I1/I2/single‑writer).
- Never proceed against a daemon failing the protocol‑version/epoch handshake (preserves §4.4 singleton correctness).
- Display state is always the daemon's reported projection, never a local guess (preserves I3 no‑lying‑status).
- Foreground mode uses the real daemon code with cli‑bound lifetime — no divergent path.

---

## 6. Internal structure (informative)

`index.ts` — arg parse, command dispatch. `ensureDaemon.ts` — detect/launch/handshake (§4.4). `control/` — local channel client + reconnect. `commands/` — `session*`, `daemon*`, best‑effort RPC pass‑through (§24). `foreground.ts` — transient‑daemon lifetime binding. `render/` — projection/`tail` rendering.

---

*joy-cli is a thin operator front‑end: ensure a daemon, speak its control channel, author input events, render its projection. It owns no protocol and no agent.*
