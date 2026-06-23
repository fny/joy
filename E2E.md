# Joy E2E test plan

End-to-end tests against the **running web app** at `https://faraz-vip.taile4b21.ts.net:8081`,
driven by an **isolated daemon + account** so we never touch real sessions. The goal is to
reproduce and instrument the real-world flakiness — lost messages, stale status, delays —
by running real, slow, complex chats and comparing what the tmux pane shows vs. what the app
renders, with timings.

---

## 1. Harness (isolated, parallel to the real daemon)

Everything is parametrized so the E2E instance coexists with the production daemon:

| Knob | Real | E2E |
|---|---|---|
| `HAPPY_HOME_DIR` | `~/.happy` | `~/.happy-e2e` |
| `TMUX_SESSION` | `joy` | `joy-e2e` |
| `PORT` | `4997` | `4998` |
| relay account | personal | TTIY6… test key |

**Daemon (from source, so it includes local changes):**
```bash
cd ~/Workspace/joy/packages/joy-tmux
HAPPY_HOME_DIR="$HOME/.happy-e2e" TMUX_SESSION=joy-e2e PORT=4998 \
  node --import tsx src/server.ts        # backgrounded
```
Auth is minted once via `/tmp/joy-e2e-login.cjs` (decode backup key → `/v1/auth` → legacy
`access.key`), plus `~/.happy-e2e/settings.json` with a stable `machineId`.

**App (chrome-cli, headless Playwright chromium):**
```bash
CH=/home/claude/.claude/skills/chrome-cli
sh $CH/chrome.sh start --headless --no-sandbox \
  --executable /home/claude/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome
# log in by injecting credentials, then reload:
sh $CH/chrome.sh eval "localStorage.setItem('auth_credentials', '<{token,secret(base64url)}>')"
sh $CH/chrome.sh navigate https://faraz-vip.taile4b21.ts.net:8081
```

**Drive the daemon (HTTP control API on :4998):**
- `POST /sessions {cwd,yolo,model,...}` → create
- `POST /send {session_id,text}` → dispatch a message (types into pane + mirrors to relay)
- `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id` for status/binding
- machine RPCs the app uses also reachable over the relay

**Drive the app:** navigate to `…/session/<relaySessionId>`, read with
`eval "document.body.innerText"`, `screenshot`. (RN-Web exposes few a11y refs; URL nav + eval
is the reliable lever. App-side *sending* is via the composer input — see §3.)

---

## 2. Observability — the three views to compare

For every scenario, line up these and **timestamp each**:

1. **Pane** — `tmux capture-pane -t joy-e2e:j-<id> -p` (ground truth: what Claude's TUI shows).
2. **Transcript** — `~/.claude/projects/<enc-cwd>/<claudeSessionId>.jsonl` (what the daemon tails).
3. **Relay/server stream** — what the daemon appended (`/v3/sessions/<relayId>/messages`), i.e. what the app *can* fetch.
4. **App render** — `eval document.body.innerText` on the session route (what the user sees).

**Latency probes** (the core of "where are the delays?"):
- `t_pane`   — first byte of the response visible in the pane
- `t_xscript`— entry written to the JSONL
- `t_relay`  — daemon appended it to the relay
- `t_app`    — app renders it
- Report `t_relay - t_xscript` (daemon tail+mirror lag) and `t_app - t_relay` (app pull/render lag).

---

## 3. Open harness gaps (to wire up before/while running)

- **App-side send**: need a reliable way to type+submit in the RN-Web composer (find the
  `<textarea>`/contenteditable, set value, dispatch input + Enter, or CDP type). Several
  bugs (#4/#5/#6) are specifically about the *app→daemon* send path, so sending from the
  app — not just `/send` on the daemon — matters.
- **Parametrization leak**: `optionsPrompt.ts` reads `~/.happy/.../options-system-prompt.txt`
  hardcoded (not `HAPPY_HOME_DIR`). Harmless cross-read today; fix for true isolation.

---

## 4. Scenarios

Each: **targets** (the symptom), **setup**, **steps**, **expect**, **observe**, **status**.

### S1 — Basic round-trip (smoke)
- **targets:** baseline; message delivery (#1)
- **steps:** create session; send "Reply with exactly: PONG"; wait.
- **expect:** pane shows `PONG`; app renders user msg + `PONG`.
- **status:** ✅ PASS (verified during harness bring-up — pane `● PONG`, app shows both).

### S2 — In-chat status (thinking → working → done)
- **targets:** #2 status updates, #9 delay
- **steps:** send a prompt that takes ~30–60s (e.g. "think step by step then write a 40-line file"). Poll the app's status indicator + the pane footer (`esc to interrupt` / spinner) every ~1s.
- **expect:** app flips to thinking within ~1–2s of the pane starting; flips to done within ~1–2s of `turn-end`.
- **observe:** time-align app-status transitions vs pane spinner vs transcript turn-start/turn-end. Note any stuck "thinking" after done, or no-thinking-shown.

### S3 — Machine name / presence
- **targets:** #3 machine names
- **steps:** fresh app load; observe the machine row (name vs raw `machineId`), online/last-seen. Restart the E2E daemon; observe how fast the app reflects online→offline→online and the name.
- **expect:** machine shows a human name promptly; presence flips within the heartbeat window.
- **observe:** how long the raw UUID shows before the name resolves; whether presence is stale.

### S4 — Long agent turn, message integrity
- **targets:** #1 lost messages, #9 delay
- **steps:** ask for a long, multi-block response (lots of text + several tool calls), e.g. "explore this repo and summarize each package in a paragraph." Let it run 1–3 min.
- **expect:** every text block + tool call that appears in the pane also appears in the app, in order, exactly once.
- **observe:** diff pane vs app block-by-block; flag any block missing in the app, any dup, any out-of-order, and the per-block `t_app - t_relay`.

### S5 — Abort, then send again
- **targets:** #4 abort-then-send
- **steps:** send a long task; mid-turn, abort (app stop button / Esc); then immediately send a new message.
- **expect:** turn ends cleanly; the new message dispatches and gets a fresh response; no lost/merged messages; status returns to idle then thinking.
- **observe:** does the abort reach the pane (Esc)? does the next send land (or get eaten by the dialog/cleanup)? is the 5xx-retry or queue state left dangling?

### S6 — Multiple messages at once
- **targets:** #5 burst send, #6 queue
- **steps:** send 3–4 messages in <2s (before the first turn finishes).
- **expect:** daemon queues them; they dispatch one per turn in order; the app shows all 4 user messages + 4 responses, none lost, correct order.
- **observe:** the daemon queue (`/queue-list`), the order they hit the pane, whether any are dropped/coalesced, and how the app renders the queued/pending ones.

### S7 — Queue interaction
- **targets:** #6 queued messages
- **steps:** with messages queued (from S6), use the app to view/edit/cancel/reorder a queued message; also test "resume".
- **expect:** queue ops reflect in both the app and the daemon; cancelled ones never dispatch; edits dispatch the edited text.
- **observe:** app queue UI vs daemon `/queue-list`; any desync.

### S8 — Subagents (Task tool)
- **targets:** #7 subagents
- **steps:** prompt something that spawns subagents (e.g. "use the Task tool / fan out 2 explorers to summarize two dirs in parallel").
- **expect:** subagent activity + their tool calls render in the app (nested/sidechain), and the final synthesis appears; status reflects the work.
- **observe:** sidechain rendering in the app vs pane; any lost subagent output; timing.

### S9 — Background task (long bash)
- **targets:** #8 background tasks, #2 status
- **steps:** prompt a long-running shell command (e.g. a 60s build or `sleep 60 &` style background task) so the turn stays "working" a while.
- **expect:** status stays "working" until done; tool-call start/end + result render; no premature "done".
- **observe:** does the app show running→completed for the tool? any stuck state?

### S10 — Concurrent sessions (real-dev load)
- **targets:** #1/#9 under load
- **steps:** run 2–3 sessions in different cwds doing real, slow tasks simultaneously; interleave messages.
- **expect:** no cross-talk; each session's messages/status are correct; delays don't balloon.
- **observe:** per-session integrity + latency under concurrency.

### S11 — Reconnect / leave-and-return recovery
- **targets:** #1 ("doesn't show until you leave and come back")
- **steps:** during a live turn, navigate away from the session and back (and/or drop+restore the app's socket); also background/foreground.
- **expect:** on return, the chat is complete and current (no gap that only a full reload fixes).
- **observe:** whether a gap persists, and whether forward-sync vs full reload is what heals it.

---

## 5. Findings log

- **S1:** PASS — basic round-trip works end to end.
- **S4 (long multi-tool turn, baseline):** PASS — single turn, app open throughout, no concurrent
  sends: **all blocks delivered intact**. 5 Bash tool-calls + 5 comments + intro + 3-sentence
  summary all rendered in the app, correct content, none lost or duplicated (turn "Baked for 22s";
  app showed the complete result within ~18s of the check — continuous per-block latency probe
  still TODO). ⇒ The **happy path is healthy**; the reported flakiness is in the edge cases below,
  matching codex's suspects (burst / abort / queue / reconnect / relay-gap), not simple flow.
- **S6 (burst: 3 app-sends ~0.5s apart, msg1 a slow count):** no loss this run — all three got
  responses (BURST-1 counted; BURST-2→Paris; BURST-3→Tokyo). The pane showed only BURST-1 in-flight
  while 2 & 3 were held, then drained (`queue:[]`, `inFlight:null` afterward). A *moderate* burst
  is queued correctly; suspect #1's loss needs the 2nd send inside the pre-`thinking` window —
  intermittent, needs tighter timing / repeats to catch. (App-side send is now wired: composer
  `<textarea>` → relay → daemon pane, verified.)
- **S5 (abort-then-send): 🔴 BUG REPRODUCED — lost + concatenated + duplicated + status desync.**
  A long msg sent right after a turn-end was typed into the pane but **never submitted** (sat ~36s
  in the input box, no turn started). Abort (Esc) on no active turn = no-op. The next msg was typed
  **appended** to the stuck one and submitted as **one combined turn** (Ctrl+U clear-before-send did
  NOT clear it) → Claude answered only the last instruction; the first request was lost. The relay
  got a **duplicate** of the first msg (seq 41 + 43 — a resend after the 2nd) and the daemon
  reported **`thinking:None` while the pane was actively generating**. This is the exact "messages
  get lost / can't tell what was sent" symptom — suspect #1 (sendText with no `#turn`/pane-readiness
  gate) + #2 (cursor) + an app-side resend. Codex root-cause + fixes → §7.
- **S8 (subagents): 🔴 SAME bug, ESCALATED — the input silently accumulates unsent messages.**
  Sent right after a turn-end → stuck in the input (2nd repro of S5). Re-sending via daemon `/send`
  (Ctrl+U-clear → type → Enter) did NOT recover: the **Ctrl+U did not clear** the stuck text, the
  new prompt **appended** (two concatenated prompts in the input), and **Enter did not submit**
  (dirty multi-line input → newline, not submit). The subagent task never ran (no RESULT-RECAP),
  yet the app shows all sends as "sent." Reliable repro — the purest "can't tell what was actually
  sent / what work was done."
- **S11PROBE2 (send during a busy turn): 🔴 lost entirely** — sent while a turn streamed; **0 in
  the transcript**, never submitted. Second loss mode (during-busy vs after-turn-end), same
  dispatch gap (codex #1/#2: app routes off a stale `thinking`; daemon `sendText` has no
  `#turn`/empty-input gate).
- **S11 (reconnect/#3): inconclusive** — the streaming task collapsed into one bash loop (single
  tool-result), so no per-row gap existed to lose; reload didn't change the app. #3 (`flushOutbox`
  cursor jump) is real in code but needs a sync-layer unit test, not UI timing, to confirm.
- _S2 (status timing), S7 (queue edit/cancel), S9 (background), S10 (concurrency): not run — the
  dispatch bug above dominates; re-run them after it's fixed._

## 7. Diagnosis + proposed fixes (with codex)

(Per confirmed bug: root cause → file:line → the fix → priority. Filled as codex weighs in.)

### S5 / lost-on-send-after-turn-end + concatenation + duplicate (codex root-cause)
- **Lost/stuck:** the daemon records a prompt as "sent to tmux / received" *before* any proof
  Claude accepted it, and persists relay `lastSeq` as handled at that point. A long send right
  after a turn-end gets typed but not submitted — yet is treated as delivered. (suspects #1/#2)
- **Concatenation:** `paneShowsReadyPrompt` returns true even when the input box holds stuck text,
  so the next dispatch types into a non-empty prompt and the two messages merge. Ctrl+U clear
  didn't save it because the readiness gate never required an *empty* input.
- **Duplicate (seq 43):** the user-echo receipt matcher (`session.ts:1322`) can't pair the
  *combined* transcript echo with seq 41 or 42, assumes "user typed in the pane directly," and
  re-mirrors it to the relay (`session.ts:1360`) with a fresh localId (`relay.ts:968`) → new seq.
- **Status caveat:** `GET /sessions/:id` (`toJSON`, `session.ts:288`) does NOT expose `thinking`;
  real status is volatile `session-alive` (`relay.ts:1010`) + 3s pane poll (`session.ts:1124`) +
  the app's 2s activity accumulator (`sync.ts:183`). So my `thinking:None` was a measurement
  artifact — test the *status pipeline* (S2), not toJSON.

**Codex fix order (highest impact first):**
1. **One verified dispatch queue** for all app→Claude text — no direct `#onRelayMessage()→sendText()`;
   a dispatch counts as "accepted" only after transcript echo/turn-start proof, and relay `lastSeq`
   isn't persisted as handled until then. *(kills lost + premature-cursor)*
2. `clearInputAndVerify()` + `paneInputText()`/`paneShowsEmptyReadyPrompt()` — if the input has
   stuck text that can't be cleared, **pause** dispatch + surface `joy__queue.paused` / a new
   `joy__input_dirty` status instead of appending. *(kills concatenation)*
3. Stop auto-mirroring unmatched transcript user entries while a dispatch is pending. *(kills the
   seq-43 duplicate even if concat still occurs)*
4. Move delivery receipts later — don't `recordReceived()` as handled until the transcript echo
   confirms the prompt (persist as pending otherwise).
5. App: for joy sessions stop choosing queue-vs-direct from `session.thinking` (stale/volatile) —
   always route through the daemon's serialized dispatch, or require an authoritative daemon ack.

### S3 / machine shows raw UUID instead of a name
The session list renders the machine as `a561aa62-…` (raw machineId), not `faraz.vip`. The daemon's
machine-metadata upsert sets `host` but no `displayName`, and the session-list label doesn't fall
back to `host`. Fix: daemon set `displayName` (e.g. host) in the machine upsert, and/or the app use
`displayName || host || id` consistently in the session-list grouping (not just `JoyMachineView`).

## 8. Summary — confirmed bugs + fix order

**Headline (your "messages get lost / messiness"): the daemon's app→Claude dispatch is not
robust.** Reproduced reliably across triggers:
- 🔴 **Send right after a turn-end → typed but not submitted** (stuck in input). (S5/ABORTTEST, S8 ×2)
- 🔴 **Dirty input compounds:** once stuck, further sends **append** (Ctrl+U clear is ineffective on
  multi-line) and **Enter doesn't submit** → the pane input silently accumulates several lost
  messages. (S8)
- 🔴 **Send during a busy turn → lost entirely** (not in the transcript). (S11PROBE2)
- In every case **the app shows the message as sent** while Claude never received it → the exact
  "can't tell what was sent / what work was done" feeling.
- 🟠 **S3:** machine shows the raw UUID, not a friendly name.
- Note: `toJSON` doesn't expose `thinking` (status-measurement caveat); the real status pipeline
  (S2) is untested.

**Fix order (from codex §7, by impact):**
1. **One verified dispatch queue** — a send counts as "accepted" only after transcript/turn-start
   proof; don't advance relay `lastSeq` until then. *(kills lost + premature-cursor)*
2. **Readiness gate must require an empty input box** + a `clearInputAndVerify()` that truly clears
   multi-line input (a single Ctrl+U does NOT — **verified `Ctrl+C` does clear it**, so use that or
   loop Ctrl+U); if it still can't clear, pause + surface `joy__input_dirty` instead of appending.
   *(kills concatenation + dirty-input accumulation)*
3. Don't auto-mirror unmatched transcript user entries while a dispatch is pending. *(kills the dup)*
4. Defer delivery receipts until the transcript echo confirms the prompt.
5. App: stop choosing queue-vs-direct from the stale/volatile `session.thinking`.

**Coverage:** S1/S4/S6 = clean baselines; S5/S8/S11PROBE2 = core bug reproduced 3 ways; S3 found;
S11 inconclusive (test-method flaw); S2/S7/S9/S10 deferred to a post-fix re-test.

## 6. Codex hypotheses (top suspects, with refs)

**Primary latency root:** the app never scrapes pane text — it waits for a COMPLETE transcript
JSONL entry, then relay append → socket update → decrypt → reducer → render. So the pane *leads*
the app by (transcript-flush time) + (relay/app processing). Not a bug, but the floor on lag.

1. **Quick successive sends bypass the daemon queue.** The app only queues a send when
   `session.thinking` is already true; a 2nd immediate send takes the normal relay path before the
   volatile thinking flag lands, and the daemon's `#onRelayMessage()` calls `sendText()` without
   checking `#turn`/pane readiness. → "multiple messages at once", "abort then send".
   `SessionView.tsx:623`, `session.ts:822/553/961`.
2. **Daemon inbound cursor advances before tmux delivery is proven.** `RelaySession.pull()` bumps
   `lastSeq` before `onMessage()` finishes; if tmux injection fails it logs but keeps the advanced
   seq → that app message is never retried (LOST send). `relay.ts:917/923/952/963`.
3. **App `sessionLastSeq` jumps past unseen server rows.** `flushOutbox()` sets `sessionLastSeq` to
   the max seq from the user's POST; if the app had already missed assistant/session rows, forward
   fetches start after the send and skip them → "lost until cold reload / latest-page fetch".
   `sync.ts:1847/1881/1920/2028`.
4. **Mirrored assistant output isn't durable across relay gaps.** If relay attach fails, recovery
   still watches the transcript, so entries are consumed while `#relay` is null; and
   `RelaySession.drain()` drops outbound records after permanent/maxed errors with no durable local
   queue. `registry.ts:613`, `session.ts:1057/1387`, `relay.ts:975/993`.
5. **Status is split across volatile activity, durable lifecycle, pane polling, and display
   grouping.** Thinking lags by pane-poll + app debounce; abort sets volatile `thinking=false` but
   doesn't clear `#turn` or append a durable cancelled turn-end; subagent output can look lost via
   tracer orphaning / collapsed work-groups. `session.ts:733/1094/1119`, `sync.ts:183/2708`,
   `reducerTracer.ts:294`, `useGroupedMessages.ts:243`.

**Repro priority** (which scenario tests which suspect): S6/S5 → #1, #2; S11/S6 → #3;
induced relay errors → #4; S2/S5/S8 → #5.

---

## 9. Fix implementation + live verification (2026-06-23)

Implemented with codex (xhigh) consulted on the plan, each refinement, and the final review.

### Root cause (the real "typed but not submitted")
The headline bug was **NOT** only the queue routing — it was the **submit keystroke**.
`#typeIntoTmux` typed the message and pressed `Enter` **back-to-back**. `send-keys -l`
delivers the whole message as one fast char burst, which claude's TUI treats as a **paste**;
an `Enter` that lands inside claude's paste-detection window is absorbed as a literal newline
instead of submitting, so the message **sits unsent in the box**. Verified live:
short+Enter submits; long+Enter (no C-u) submits; **C-u + long + immediate Enter does NOT
submit**; **C-u + long + ~350ms delay + Enter DOES**. Fix: **delay the Enter** (`#armSubmit`,
`ENTER_SUBMIT_DELAY_MS=350`), behind a cancellable `#submitTimer`, mirroring + thinking moved
*after* the Enter actually fires.

### The eight changes (all in joy-tmux unless noted)
1. **One verified dispatch queue** — `#onRelayMessage`, `/send`, `sendText` shim, and 5xx retry
   all `enqueue()`; nothing types straight into the pane. `QueuedItem` carries
   `source/mirrorToRelay/seq/visible`; `queueState()` hides relay/retry items (they already have
   a chat bubble).
2. **Empty-input gate** — `paneInputText`/`paneShowsEmptyReadyPrompt`; drain requires an EMPTY
   box, else clears it (`C-u`×4 → one guarded `C-c` → pause `input_dirty`). Kills concatenation.
3. **No auto-mirror of unmatched echoes while a dispatch is pending** — kills the seq-43 dup;
   pauses `dispatch_mismatch` + clears stale `delivery.pending`.
4. **B1 cursor honesty** — relay `lastSeq` = "accepted into the in-memory queue" (comment fixed;
   durable B2 replay deferred).
5. **App (joy-app)** — `handleSend` always uses durable `sync.sendMessage` for joy; dropped the
   stale-`session.thinking`→`joyQueue.add` branch (daemon serializes). `pauseReason` wired to the
   queue schema + a reason-specific paused banner.
6. **Delayed Enter** (`#armSubmit` + `#submitTimer`) — the root-cause fix above; timer cancelled
   on abort/end/confirm/timeout/mismatch; callback guarded (live, no `#turn`, same in-flight).
7. **Generating gate** — `#maybeDrainQueue` also gates on `paneShowsGenerating` (`esc to
   interrupt`), not just the lagging `#turn`, so a during-turn send is HELD in the daemon queue
   instead of typed into a live turn (no double-queue). Background shells don't block.
8. **Stale-pending neutralization** on timeout/mismatch so a requeue/re-type can't double or
   self-suppress.

### Live results (isolated harness, daemon from source)
- **A — send during a BUSY turn:** busy task submits; during-send HELD in the daemon queue (live
  box stayed empty) ~24s, then dispatched one-per-turn into a clean box → answered. ✅ (was: lost)
- **B/S6 — burst of 3 long msgs:** one-per-turn, in order — BURSTONE→ALPHA, TWO→BRAVO,
  THREE→CHARLIE; zero loss, zero concatenation. ✅
- **C — dirty box:** injected stuck text; daemon cleared it and sent the real msg; stuck text in
  0 transcript user entries. ✅ (was: concatenated)
- **D — abort-then-send (S5):** long task → abort (clean idle) → next send → answered RESUMED. ✅
  (was: typed-but-not-submitted + concatenated + duplicated)

typecheck clean (joy-tmux + joy-app); 99 joy-tmux unit tests pass (added pane-helper + queue
visibility + generating-gate tests).

### Deferred (noted, not blocking)
- B2 durable replay (re-pull from a confirmed-seq watermark across daemon restarts).
- 5xx-retry duplicate-bubble edge (mirror happens at dispatch; a timed-out+resumed retry could
  show a dup) — pre-existing, low.
- The deployed app is still old code (fix #5 lands on the user's next app rebuild); the daemon
  fixes are live now and cover both the relay and `/send` paths.

---

## 10. Post-fix scenario sweep (2026-06-23, after the dispatch + status commits)

Re-ran the deferred scenarios against the harness now that dispatch is solid. Daemon
fixes are live; the deployed app is still origin/main (app-side bits land on its next rebuild).

- **S2 — status timing:** PASS. App shows `mulling…/cogitating…` within ~1-2s of the pane
  starting; clears to `online` within ~3s of turn-end. No stuck thinking on a normal turn.
- **S5 — abort-then-send:** PASS (Test D). Long task → abort (clean idle) → next send → answered.
- **S6 — burst:** PASS (Test B). 3 long msgs → 3 turns in order, distinct replies, no concat/loss.
- **S7 — queue edit/cancel:** PASS. Edited a queued item (its NEW text dispatched), cancelled
  another (never dispatched); reorder covered by unit test.
- **S8 — subagents (Task tool):** PASS (rendering). App renders each subagent as a "Background
  task completed" card + the final synthesis. ⚠️ Found+fixed a status bug (below).
- **S9 — background/long bash:** PASS. Renders as a live `Terminal` card (elapsed + spinner →
  done); status stays "working" through it, then clears.
- **S10 — concurrency:** PASS. 2 sessions in different cwds, simultaneous sends → zero cross-talk
  (each transcript has only its own msg+reply). 2nd session cold-booted and bootstrapped its first
  message through the queue (the starting-drain).

### Bug found + FIXED (committed eb936bb0): status stuck "working" after subagents/bg
`paneShowsWorking` matched the `· N shells · ↓ to manage` footer ANYWHERE in the pane; after a
subagent/bg run that footer lingers in SCROLLBACK above the idle box → stuck "working". Fix: scope
the scan to the LIVE footer (below the input box). See §9 / the commit.

### Bug found, NOT fixed (belongs in the in-progress slash-commands/machine work): S3 machine name
The session list shows the machine as its raw UUID (`a561aa62-…`) instead of `faraz.vip`.
- The app is NOT at fault: SessionsList.tsx:288 and JoyMachineView.tsx:66 already use
  `metadata.displayName || metadata.host || id` (in origin/main).
- Root cause: joy-tmux never sends `host`. `getOrCreateMachine(...)` (the only call that upserts the
  machine row's metadata, incl. `host`) is invoked from EXACTLY one place — `commands.ts:181`
  (`pushMachineIfChanged`) — and that method early-returns when the slash-command union is empty
  (`union().join("\n") === #lastPushed`, both `""`). A machine with no project/personal/plugin
  commands (the common case) therefore never upserts `host`, so the app has no name to show.
- Recommended fix (in the machine work, not done here): upsert the base machine metadata (with
  `host`) UNCONDITIONALLY on relay-connect/startup, independent of the slash-commands push — e.g. a
  one-time `relayClient.getOrCreateMachine(baseMachineMetadata)` on connect, or don't skip the first
  push in `pushMachineIfChanged` even when the union is empty.

### Still deferred
- **S11 (reconnect / "doesn't show until you leave & return"):** app sync-layer (forward-sync
  cursor / `flushOutbox`), not the daemon dispatch path. Needs a sync-layer unit test + the new app
  build to verify; out of scope for this daemon-focused pass.
