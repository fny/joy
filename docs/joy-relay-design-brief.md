# Brief: design consultation for joy-relay (our custom relay)

You are consulting on the server-side design for **joy-relay**, the custom relay
that will progressively replace the upstream happy-server relay (strangler
pattern). We want a solid design that RESOLVES, at the server, the whole class
of hacks the current ecosystem works around client-side.

## System today

- **joy-app** (React Native/web client) and **joy-tmux** (machine daemon
  driving Claude Code sessions inside tmux) talk through a relay.
- Relay today = upstream-pristine **happy-server** (Fastify + Prisma +
  socket.io, per-session `sessionMessage` rows with a server-assigned
  monotonic `seq`; payloads are E2E-encrypted blobs the server can't read;
  socket broadcast is a transient "poke"; REST `GET .../messages?after_seq=N`
  is the replay path). Auth: challenge-signed account keys; terminal pairing
  via ephemeral box keys.
- **joy-relay** is currently a phase-0 zero-dep node passthrough
  (`packages/joy-relay/proxy.mjs`) in front of happy-server on our own box
  (joy.voltai.party): stable instance :4997, dev instance :14997, direct
  happy-server :24997. Clients already pair against joy-relay's address, so
  the strangler can take over endpoints without anyone re-pointing. A
  reserved postgres quadlet exists for joy-relay's own phase-1 database.
- Multiple relays now coexist: per-relay app accounts and per-relay joy-tmux
  daemons (own state dir, tmux server, service unit) are shipped. "Joy Relay"
  (:4997) is the stable one; :14997 is where dev relay code iterates.

## The hacks/bugs we want the server design to dissolve

1. **Abort/cancel is an ephemeral socket RPC** while messages are persisted
   with seq — cancel is lost if the daemon blinks; no ordering between cancel
   and messages; no idempotency; "abort sent but never received", forever
   spinners, agent keeps going after cancel.
2. **The work queue lives only in daemon memory** — daemon restart/crash
   loses queued messages; clients show "sent" for work the daemon never saw.
   (We shipped a client-side persistence patch, but it's a patch.)
3. **No turn correlation on the wire** — no turnId; dropped messages are
   undetectable; "completed" lies while background tasks still stream.
4. **Own-send seq races** — the sender's own POSTed message gets its seq only
   via a POST ack; broadcasts omit the sender's rows; clients had null-seq
   ordering bugs.
5. **Fire-and-forget steering** (/steer) — mid-turn injections have no
   delivery guarantee at all.
6. **Presence is a shared per-host bool** (machine.active) — a joy daemon and
   happy daemon on one host stomp each other; live sessions show stale "last
   seen".
7. **Permission prompts block the turn invisibly** — a dead client leaves the
   agent parked on canCallTool forever with no server-visible state.
8. **File/shell/machine RPCs are transient request/response** with the same
   fragility as abort (no timeout/retry/idempotency contract).

## The existing client-only design (read `docs/resilient-queue-design.md`)

Written under a hard constraint that NO LONGER HOLDS: "do not change the
server". It tunnels a log-as-queue (intent+fact events: user-message, cancel,
turn-started/completed/…, bg-*, heartbeat, cursor) as opaque encrypted
records over the existing message channel, with client/CLI folding
projections from seq order. Its §12 lists open problems: multi-writer intent
serialization, agent-replay duplication, permission blocking, log
compaction/snapshots, producer backpressure, schema versioning.

## What we want from you

Given that we now OWN the relay server (and its own database), design the
joy-relay protocol/architecture that makes the clients simple and honest:

- Server-owned durable queue + delivery semantics (exactly-once to the agent
  across daemon restarts; acked consumption; what does the server track
  per-consumer?).
- Cancellation as a first-class, ordered, idempotent server primitive (incl.
  cancel-before-start, steering, and queue-drain semantics).
- Turn lifecycle as a server-visible state machine (turnId minted where? who
  writes terminal states? how do we avoid trusting a dead daemon?).
- Honest client state: what can the server itself answer (queued-count,
  turn-state, awaiting-permission, daemon liveness/lease) so the app never
  lies, even with E2E-encrypted payloads (the server sees envelopes, not
  content — keep it that way).
- Leases/heartbeats for daemon liveness; per-relay presence (fixing #6).
- The compatibility/migration story: strangler phases from passthrough →
  shadow (dual-write/observe) → owning the new endpoints → owning storage;
  happy-app/happy-cli clients must keep working against joy-relay throughout
  (upstream API stays served, by proxy or reimplementation).
- Address each §12 open problem from the old doc with a server-side answer.
- Keep it small: one box, podman, PGlite/postgres, zero-dep bias. No k8s, no
  kafka. This is a personal-infrastructure project with real reliability
  goals, not a hyperscaler cosplay.

Deliverable: your strongest design — components, data model, endpoint/socket
contract, delivery + cancellation semantics, migration phases, and explicit
answers to the §12 problems. Challenge anything in the old doc you think is
wrong. Be concrete and opinionated; we'll iterate together over several
rounds.
