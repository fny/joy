# v2 dual-path — status & the optimistic-echo (B2) design

The app routes a session's WRITES over the v2 relay when its happy card
carries a `metadata.v2` link (stamped by the daemon's nucleus lane at bind).
Reads stay on the happy mirror, so display/history/files/git are unchanged.
Verified working end-to-end, sealed, over the deployed relay (2026-08-30).

## Seam points
- `sync.sendMessage` — v2 branch seals (`sealV2Content`) and POSTs to the
  relay queue. B1: a session with a key envelope REFUSES to send if the key
  will not open (never downgrades to plaintext).
- `ops.sessionAbort` — v2 branch cancels via the relay control lane only
  (turn terminalizes CANCELLED); no happy-abort fallback (no double-abort).
- Content codec: `sources/sync/v2/crypto.ts` (app) ↔ daemon
  `nucleusLane.ts` (`sealSessionKey`/`encodeContent`). Interop pinned in
  `crypto.interop.test.ts`.

## B2 — optimistic echo (DEFERRED, by decision)

Goal: show the user's own message instantly instead of waiting for the
daemon's mirror round-trip.

Why the obvious approach fails: an optimistic local row and the daemon's
mirror row describe the same user turn but live in DIFFERENT id spaces (our
localId vs Claude's transcript uuid), so they cannot reconcile by id. Text-
match dedup was tried and is fragile: it fights (a) the order-dependent
message reducer's id assignment for optimistic rows, and (b) the daemon's
own transcript re-echo suppression (`received`-receipts), which currently
does NOT cover the nucleus-lane path — so the mirror user row appears even
though `#typeIntoTmux` records a received twin for socket-delivered prompts.
Net: every text-match attempt left a duplicate. Shipping a duplicate is
worse than a small online latency, so the optimistic row is not applied.

Correct fix (daemon-side, deliberate): when the nucleus lane delivers a v2
prompt to a session, record the prompt in that session's `received` receipts
(the same mechanism that suppresses the transcript self-echo for socket
sends) so the transcript tailer does NOT mirror the user row to the happy
card. Then the app's optimistic row becomes the SOLE user row — no dedup
needed — and it should be persisted (outbox-style) so it survives a restart
before delivery. This is the same shape v1 uses for happy-socket sends.

Until then: the mirror is the single source of the user row (one row, small
online latency). This is correct, just not instant.
