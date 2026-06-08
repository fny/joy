# joy-tmux message-passing review

Trace of each message path through joy-tmux, with notes on correctness.

## Path A: App → Claude (inbound via relay)

1. App POSTs `{ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web' } }` to `/v3/sessions/{relaySessionId}/messages`
2. Server assigns seq=N, stores the encrypted message
3. Joy-tmux's `RelaySession.pull()` (3s poll) calls `readSince(sessionId, lastSeq)`, gets message at seq=N
4. `pull()` decrypts:
   - If decrypt fails → log and skip, do not advance lastSeq
   - Check `dec.role === 'user'` ✓
   - Check `meta.sentFrom !== 'joy'` ✓ (it's 'web' so passes)
   - Call `onMessage(text, seq)`
5. `onMessage` handler:
   - `getOrInitDeliveryState(sessionId, relaySessionId)` — loads receipts from disk on first access
   - Push to pending: `{ seq, text, source: 'relay', at }`
   - `tmux send-keys -l ... text`
   - If `!ok` → pop pending, throw → pull() doesn't advance lastSeq, retries next poll
   - `tmux send-keys ... Enter`
   - `setThinking(true)`
6. Claude processes input, writes user entry to JSONL
7. Transcript watcher fires:
   - `handleTranscriptEntry`, role === 'user', content === text
   - Pending queue front matches → pop, record receipt `{ seq, uuid, text, source: 'relay', at }` → persist
   - Return (don't add as 'cli')
8. Claude generates response, writes assistant entry
9. Transcript watcher fires:
   - role === 'assistant', forwardedUuids doesn't have this UUID
   - Send turn-start, text events, tool-call events to relay
   - Record outbound receipt `{ uuid, turn, at }` → persist
   - If stop_reason === 'end_turn', send turn-end

**Status: ✅ Correct.** Receipts pair seq↔uuid; tmux failure backs out the pending push.

## Path B: App → Claude (inbound via /send HTTP endpoint)

1. Local web client POSTs `{ text, session_id }` to `http://localhost:4997/send` with `X-Joy-Token` header
2. Token verified
3. `nextChatId++`, addMessage to local store as `source: 'web'`
4. `getOrInitDeliveryState`, push `{ text, source: 'web', at }` (no seq — this didn't come from the relay)
5. `tmux send-keys -l ... text` + Enter
6. `rs.send(encodeUserMessage(text))` — echoes to relay so app sees it
7. `rs.setThinking(true)`
8. Claude processes, writes transcript entry; watcher matches pending, records receipt
9. Joy-tmux's own relay echo at step 6 comes back via pull() at some future seq, but `meta.sentFrom === 'joy'` filter in pull() drops it

**Status: ✅ Correct.** The self-author filter prevents the relay echo from re-injecting.

## Path C: App → Claude (inbound via joy-send RPC)

Identical to Path B but invoked through the relay's RPC channel. Same receipt flow with `source: 'rpc'`.

**Status: ✅ Correct.**

## Path D: Direct typing into tmux

1. User types text into the `dd-{id}` tmux pane and presses Enter
2. Claude processes input, writes user entry to JSONL
3. Transcript watcher fires:
   - role === 'user', content === typed text
   - Pending queue is empty (or front doesn't match) → no receipt match
   - If `!forwardedUuids.has(uuid)`:
     - `rs.send(encodeUserMessage(content))` → relay/app see the user message
     - `recordOutboundReceipt({ uuid, turn: '', at })` → mark as forwarded
   - addMessage local as `source: 'cli'`
4. Claude responds; standard assistant-entry path forwards to relay

**Status: ✅ Correct after the gap fix.** The app sees direct-typed messages.

## Path E: Outbound (Claude response → relay)

1. Claude writes assistant entry to JSONL (text blocks, tool_use blocks)
2. Transcript watcher fires:
   - role === 'assistant', entryUuid present
   - Check `forwardedUuids.has(entryUuid)` → if so, skip (recovery dedup)
   - Open turn if needed (`turnStates`), send turn-start
   - For each block:
     - `text` → `encodeTextEvent(text, opts)` via `rs.send`
     - `tool_use` → `encodeToolCallStart`
   - Record outbound receipt → persist
   - If stop_reason === 'end_turn' / 'max_tokens' → encodeTurnEnd, delete turn state, setThinking(false)
3. For tool results in subsequent user entries:
   - role === 'user', content is array
   - For each tool_result block → `encodeToolCallEnd` via `rs.send`

**Status: ✅ Correct.** Streaming at per-block granularity; turn boundaries explicit.

## Path F: Recovery after restart

1. Joy-tmux starts
2. `recoverDirectSessions` finds existing `dd-{id}` tmux windows
3. For each: create SessionRecord, attach `startTranscriptWatcher` synchronously
4. **Async**: `createRelaySession(...).then(rs => { ... relaySessions.set(id, rs) })`

**Issue identified — race condition.** The transcript watcher attaches synchronously and the initial `readNew()` runs *before* the relay session is created. During this initial scan:
- `relaySessions.get(sess.id)` returns undefined
- The `if (rs && uuid)` block is skipped for user entries → no receipts recorded, no forwarding
- For assistant entries, the same gate fails → no forwarding

Consequences:
- New assistant entries that arrived during downtime won't be forwarded to the relay (they're added to local store but `rs.send` is gated)
- New user entries from direct typing during downtime won't be forwarded either

Existing receipts on disk *would* prevent re-forwarding of already-forwarded entries once the relay session arrives (forwardedUuids set is loaded lazily). But the initial scan happens before that load. So both directions are broken until the next file modification triggers `readNew` after the relay session is up.

**Severity:** Medium. Triggered by restart during active session use. New messages during downtime are silently lost from the app's view.

**Suggested fix:** Move `startTranscriptWatcher` into the `.then(rs => ...)` callback (with a fallback when `relayClient` is null). OR: buffer transcript entries when `rs` isn't available and replay them when it arrives.

## Path G: Decrypt failure on inbound

1. `pull()` reads message at seq=N
2. `decryptMessage` returns null (key mismatch)
3. Log `DECRYPT_FAILED`, `continue` to next message
4. `lastSeq` is NOT advanced for this message
5. **But:** if the next message in the batch decrypts fine, `lastSeq` advances past the failed one

**Issue identified.** A single bad message in a batch can be orphaned — server still has it, joy-tmux never re-fetches.

**Severity:** Low in practice (decryption shouldn't fail with stable keys). Worth noting.

## Path H: send-keys failure

1. `pull()` receives valid message, calls `onMessage(text, seq)`
2. `onMessage` pushes pending, runs `tmux send-keys`
3. `send-keys` returns `{ ok: false }` (window dead, tmux gone, etc.)
4. `onMessage` pops the pending entry, throws
5. `pull()` catches the throw, doesn't advance lastSeq → message will retry on next poll

**Status: ✅ Correct.** Backpressure works.

## Summary

| Path | Status |
|------|--------|
| A. Relay → Claude | ✅ |
| B. /send HTTP → Claude | ✅ |
| C. joy-send RPC → Claude | ✅ |
| D. Direct typing → relay | ✅ (after gap fix) |
| E. Claude response → relay | ✅ |
| F. Recovery after restart | ⚠️ **race condition** |
| G. Decrypt failure | ⚠️ low-severity orphan |
| H. send-keys failure | ✅ |
