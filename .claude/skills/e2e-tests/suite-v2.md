# Suite: v2 — the native /joy/v2 durable plane

Scope: the v2 relay surface end to end on the prod-mirror stack — sessions,
messages with delivery states, ephemeral streaming, orphan/retry, turn-
precondition cancellation, attachments — plus the app's dev **Relay v2 Mode**
screens on top of it. The daemon side is `v2-actor.mjs`, which speaks the
`/joy/v2` daemon lane exactly as the real daemon will once its nucleus lane
ships, with deterministic failure modes the real daemon can't produce on
demand (`normal` / `die-after-start` / `slow`).

Prereq: `stack.sh start` healthy (see SKILL.md).

## Tier 1 — headless protocol pass (run FIRST, ~2 min)

```bash
node .claude/skills/e2e-tests/v2-validate.mjs
```

Mints a throwaway account on the relay (`POST /joy/v2/auth`, the app's login
path), runs the actor, and asserts 20 checks:

1. account mint on the relay; 2. spawn-mode session create against the
actor's machine; 3. spawn claim + bind → session active; 4–5. message 202 →
`delivered`; 6. durable `echo:` block in the event log; 7. ephemeral deltas
absent from the log; 8–9. offline queueing (kill actor → `queued`; restart →
`delivered`); 10–12. orphan the REAL way (`die-after-start`, actual 20s lease
TTL + relay sweep → `failed` with `mayHaveDelivered`; retry 202; fresh lease
delivers); 13–14. cancel a running turn via the control lane →
`terminal(cancelled)`; 15–18. attachments (201, dedupe-200 same id, cite on
send, immutable fetch); 19–20. purge cascades everything.

All 20 must pass before the browser tier — a Tier 1 failure is a stack or
relay bug, not a UI bug.

**Sequencing rule the script encodes (and you must keep):** never kill the
actor mid-turn unless orphaning is the thing under test — a running turn
correctly BLOCKS the session's work lane until the sweep orphans it
(queue-head discipline), so "kill early" turns every later assertion into a
cascade failure that looks like a relay bug and is not.

## Tier 2 — browser pass (Relay v2 Mode)

App at `:8082` (server URL = `http://127.0.0.1:3105`), logged into the
suite's account. The actor must run with the SAME account's bearer token —
take it from the app (`localStorage` auth) or reuse Tier 1's mint.

Open **Dev Tools → Relay v2 Mode**:

1. **Session list** shows the Tier-1/actor sessions with state + queued
   counts; create a new session against the actor machine; it flips out of
   `provisioning` without a reload (SSE poke or poll).
2. **Conversation loop**: open the session, send a message; assert the queue
   strip shows `queued` → `delivering` → gone, the user bubble appears from
   the event feed, a STREAMING bubble paints from the ephemeral lane (web has
   SSE) and is replaced by the durable `echo:` block — the streaming text
   must never appear twice.
3. **Offline queueing**: stop the actor (after the last turn is terminal!),
   send two messages, assert both sit `queued`; Edit one (content updates),
   move the second to Top (order flips), Delete the first (gone). Restart
   the actor: the remaining message delivers.
4. **Orphan/retry**: actor `--mode die-after-start`, send, wait out the real
   lease TTL (~25 s): the queue row shows `failed · daemon lost mid-delivery
   (may have delivered)` with a Retry button. Restart the actor in `normal`,
   press Retry, assert delivery.
5. **Cancel**: actor `--mode slow`, send, wait for exec `running` in the
   status bar, press "Cancel turn"; assert the feed gains the cancellation
   event and the turn ends `cancelled`.
6. **Attachment**: "+file" sends with a cited attachment (202, no 422).
7. **Purge**: Delete from the status bar; back on the list the session is
   gone; a direct `GET /joy/v2/attachments/<id>` with the token is 404.

Cross-check each step against the server artifact (`curl` the v2 endpoints
with the account token) exactly like the chat suite checks the relay's message seq.
