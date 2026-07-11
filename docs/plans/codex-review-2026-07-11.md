# Codex joint review — 2026-07-11 (agreed findings + designs)

Interactive review of joy-app + joy-tmux with codex (gpt-5.5 xhigh), server
(happy-*) treated as fixed contract. All 8 findings debated one at a time;
everything below is AGREED design, not open questions.

## 1. Outbound mirror loss (severe) — receipts lie about delivery
`recordOutboundReceipt` fires at hand-off; `RelaySession.drain()` drops after
MAX_SEND_ATTEMPTS or any permanent 4xx; outbound queue is memory-only.
**Agreed:** persisted outbound queue of PRE-ENCODED WireRecords with stable
localIds + attempt state; deliver via the idempotent v3 POST (server dedupes
by localId — proven by the app outbox); receipts recorded POST-ACK at the
transcript-entry GROUP boundary (one entry → many rows; early receipt loses
the tail on replay); park-don't-drop for retryables; permanent 4xx → marked
failed + surfaced, never receipted. Net: effectively exactly-once.

## 2. Inbound cursor advances before durable handoff (severe, riskiest to build)
`pull()` advances lastSeq at decrypt, catches onMessage failures, persists the
cursor anyway. Three holes: attachment write throws pre-enqueue; saveQueue()
swallows write failures (spool "ack" can be a lie); /steer//btw//login-code
bypass fires `void` async work with no spool entry.
**Agreed:** confirmed-cursor advances only after durable handoff; pull loop
HALTS on delivery failure (contiguity); saveQueue propagates failure; spool
dedupes by relay seq (covers spool-written/cursor-unwritten crash). Steer
family must spool-first or hold the cursor. Codex's required tests:
spool-written/cursor-not replay; delivery-fails/no-advance; attachment
failure halts pull; steer no longer fire-and-forget-acks.

## 3. Draft auto-release can vaporize drafts (app)
remove(head) before send(); promise discarded; sendMessage can fail before
the persisted outbox (missing encryption, throw building optimistic row).
**Agreed:** lease-based two-phase — draft states queued|releasing with
releaseLocalId (persisted, STABLE across retries, passed INTO sendMessage →
idempotent at reducer + server), leaseUntil, attempt, lastError. sendMessage
gets a real contract ({ok, localId} only after optimistic row + outbox
enqueue). On ok → remove; failure → revert with backoff; surface after N
attempts (stays editable). Lease expiry retries with the SAME releaseLocalId.

## 4. SessionStart hook doesn't bind (policy-constrained)
Hooks must tighten, never carry. But if upstream drops entry.sessionId, the
session sticks in "starting" and recovery can bind the wrong transcript.
**Agreed:** staged binding — SessionStart stores pendingHookBinding
{sid, transcriptPath, at} + rebinds tailer; any transcript ACTIVITY on that
exact path confirms it (persist sid + mark active, with diagnostic); later
conflicting entry.sessionId = hard mismatch, loud log. No activity → no
binding, so hooks stay non-load-bearing.

## 5. updateQueue hides held sends (one-liner, conceded)
`empty` = queue.length===0 && !inFlight && !paused — ignores pendingCount and
hidden[]. A hidden app-send held mid-turn with cur==null early-returns; the
app never sees the pending count. **Fix:** fold pendingCount===0 &&
hidden.length===0 into `empty`.

## 6. Transcript tail swallows format death (visibility, not retention)
Skip-and-advance stays (liveness). **Agreed additions:** per-tailer parse
health (consecutive + total counters, reset on success), first-failure log
with offset + redacted prefix, rate-limited follow-ups, threshold → agent
note + session health flag; read/stat errors tracked SEPARATELY (tailer
health ≠ schema health); PLUS a semantic layer — many valid-JSON entries with
unrecognized type/shape raises a format diagnostic (the system/local_command
class). No skipped-byte journal (transcript file is the durable record).

## 7. TUI-string busy inference (downgraded to hardening)
**Agreed:** the LEASE rule — after a hook-driven submit, pane polling may SET
thinking but may NOT CLEAR hook-set thinking until a trusted negative edge
(Stop hook, transcript turn-end, abort) or lease expiry (~3 min, aligned with
the draft TTL). Kills the "broken matcher clears thinking in 6s during long
pre-output" path. Keep captured-pane matcher tests; CLI-version canary cut.

## 8. Receipt growth — pruning BLOCKED until replay is bounded
My 10k/14d prune bound was WRONG: recovery constructs Sessions with no
transcriptStartOffset (registry.ts:632) and tails from 0, explicitly relying
on forwardedUuids for full-replay dedup (registry.ts:647); SessionStart
forced rebind also resets the offset. **Agreed order:** first bound replay
with a persisted transcript offset checkpoint; THEN receipts only need the
intentional overlap window and pruning becomes a correctness bound instead of
a gamble.

## Implementation order (agreed)
5 (one-liner) → 3 (app, self-contained) → 1 (outbound exactly-once) →
2 (inbound cursor contract; riskiest — land with the crash-window tests) →
6 (parser health) → 7 (thinking lease) → 8 (offset checkpoint, then prune).
