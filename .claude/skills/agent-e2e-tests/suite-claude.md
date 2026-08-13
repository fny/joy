# Claude suite — claude-CLI-specific e2e tests

Run AFTER the chat suite has passed for claude (it covers account/create/chat basics).
These tests exercise claude-only machinery: transcripts, background tasks, permission
prompts, slash commands, resume/continue/fork, and transcript-binding recovery.

## Test 3: Background processes and agents

- Status starts **online**.
- Send `run_in_background spawn a process that runs for 30s`.
- Status turns **blue**, then you get a response acknowledging the request and showing the command.
- Status goes **blue → teal (`#30B0C7`)** in both button and session; the session status shows **how many processes are working** ("N/M completed"). (The `joy__tasks` count is derived from the transcript: a task is *launched* on a tool result's `backgroundTaskId` and *completed* on the matching `<task-notification>` / `<task-id>`.)
- Visit settings — status stays **teal**.
- When the bg work finishes, the sidebar button goes teal → **green**.
- Back in the session: a "background process completed successfully" message appears; status **online/green**, sidebar **gray**.
- **The "N/M completed" indicator MUST disappear once every task finishes — no session may be left showing a stuck count (e.g. `0/1`).** This is the known failure mode: the launch sets the count but the completion never clears it. Confirm `joy__tasks` is actually gone from the session metadata (not just visually faded), in BOTH the list button and the session header.
- **Validate all session artifacts in correct order.**
- **Repeat** with `Spawn 5 agents that run sleep for 30s`: many agent-spawn messages appear, the **teal** status + "N/M" count behaves the same, counts up toward `5/5`, and then **clears** on completion. Validate artifacts.
- **Long-running process (`<joy-bg long-running>`):** send `start a tiny HTTP server with python3 -m http.server 8931 in the background — it should keep running until I say stop`. The agent should run it via run_in_background and emit the `<joy-bg … long-running … />` tag. Assert: the status shows the plain-text suffix (e.g. "ready, 1 background process", `joy__longRunning: 1`), it is NOT counted in any teal N/M, the raw `<joy-bg>` tag is NOT visible in the chat (own-line tags are stripped), and the suffix persists across turn end. Then send `stop the server` and assert the suffix clears. Validate artifacts.

## Test 4: Abort / interrupt (NEW)

- Send a long task, then press the abort/stop control mid-turn.
- The in-flight message is aborted; status returns to idle (online/green) promptly.
- A visible **"⏹ Interrupted"** message appears in the chat (the abort is acknowledged, not silent) — confirm it in the UI and in the artifacts.
- A message typed-but-not-yet-submitted at abort time is discarded, not silently re-sent.
- **Abort clears a running N/M count:** send `run_in_background spawn a process that runs for 60s` (or `Spawn 3 agents that sleep 60s`), wait until the status shows the teal **"N/M completed"** background count, then press abort mid-run. The count MUST clear immediately and the status return to **idle** — abort must not leave a stuck "N/M" (`joy__tasks` gone from metadata, on both the sidebar button and the session header). A **long-running** process (one tagged `<joy-bg long-running>`) is NOT cleared by abort — only finishing tasks are.
- **Validate artifacts** — no orphaned/duplicated partial turn; the "⏹ Interrupted" note appears once, in order.

## Test 4b: Rapid aborts — abort storm (NEW)

Stress the dispatch/abort/queue machinery with rapid fire: interrupt an agent mid-turn and immediately re-task it, repeatedly changing the ask, so each attempt produces a partial agent turn before it's cut. This is the "message → abort → message → pause → abort → message" pattern; it catches wedged queues, dropped/misrouted messages, missing or duplicated interrupt notes, and stuck state after a storm of aborts.

- Send a message that starts a long, multi-block turn: `Write a Lisp interpreter in JavaScript — full eval loop, be thorough`.
- As soon as status goes blue and the agent has emitted at least one block, press abort. Confirm a **"⏹ Interrupted"** note lands and status drops to idle.
- WITHOUT waiting for settle, immediately send `No — I meant in Python`; let it start; abort again mid-turn.
- Immediately send `Actually, Ruby`; abort again.
- **Exercise the queue+pause path:** while a turn is working, queue 2 messages (`and add tail-call optimization`, `and a REPL`), then abort the in-flight turn. Confirm the queue/pause banner behaves — if the abort pauses dispatch, the banner is accurate and **resumable**, and queued items are neither silently dropped nor misdelivered into the wrong turn.
- Finally send `ok, just do it in JavaScript` and let it run to completion.
- **Assertions:**
  - Each abort interrupts promptly and produces **exactly one** "⏹ Interrupted" note (none missing, none duplicated).
  - No message is lost, duplicated, or delivered to the wrong turn; the final `ok, just do it in JavaScript` actually runs and completes.
  - The dispatch queue never deadlocks — after the storm, a brand-new message sends normally (idle → blue → idle).
  - No stuck N/M count from any partial turn's background work; status ends **idle/green**.
- **Validate artifacts** — per abort, the ordered triple (user message → partial agent turn → "⏹ Interrupted") appears once each in **seq** order; the final completed turn is last; nothing interleaves wrong.

## Test 5: Queueing (NEW)

- While Claude is working, send 3 messages in quick succession.
- They queue in the daemon (`joy__queue`) and drain **in order**. NOTE the UI semantics: chat-originated sends are INVISIBLE queue items — they already render as chat bubbles, so the queue strip shows no chips for them (chips are only for explicitly-queued drafts). Assert via `joy__queue` metadata + delivery order, not chips.
- **No paused banner ever appears** during this normal-path test — a "message didn't send" banner here is a dispatch-confirmation failure (FAIL).
- **Validate artifacts** — the three appear once each, in send order.

## Test 6: Permission prompt (NEW)

- Send a request that triggers a tool needing approval.
- The session shows **permission_required** (yellow `#FFCC00`); approve it and confirm the turn proceeds; repeat with deny and confirm it's handled.
- **Validate artifacts.**

## Test 7: Slash commands (NEW)

- Send `/title My Test Title` and confirm the session title updates (sidebar + session view).
- Confirm project/personal Claude slash commands appear in the `/` autocomplete.

## Test 8: Stop and restart from the sidebar

- Sidebar secondary-click → Archive. Confirm the corresponding tmux window is closed.
- Find it in the archive area and restart it.
- You land on the session page; **all artifacts correct based on the prior Claude session id** (history preserved, in order).

## Test 9: Stop and restart via new session (continue)

- Archive the session; confirm its tmux window closed.
- New-session page → select the same folder → choose **continue** → submit an empty message.
- Land on the session page; **artifacts correct vs the prior Claude session id**.

## Test 10: Stop and restart from a Claude session id

- Archive the session; confirm its tmux window closed.
- New-session page → select the folder → enter the **Claude session id** for continuation → submit empty.
- Land on the session page; **artifacts correct vs that Claude session id**.
- **Repeat with a short unique PREFIX of the session id** (e.g. the first 8 chars) — the daemon resolves it to the full uuid; same artifact assertions.

## Test 11: Restart after Kill Session

- In the session, select **Kill**. Confirm the tmux window closed and the session no longer appears in the sidebar.
- Re-run Test 9 (continue) from new-session creation.
- Repeat using Test 10 (Claude session id) instead.

## Test 12: Kill → resume shows the FULL transcript immediately (NEW — history backfill on open)

Guards the "blank/partial chat until you send the first message" regression and the daemon `recover()` transcript-binding bug (a session re-adopted with `transcript=null` never re-binds, so the app shows an empty or truncated history).

- Start from a session with a **multi-turn history** — at least 3 user→agent exchanges (reuse the session from earlier tests, or build one: e.g. `What is 2+2?`, `Now multiply that by 10`, `Write one sentence about the ocean`). Before killing, **record the complete expected message set and order** from the server sequence (`GET /v1/sessions/<relay-id>/messages`) and the Claude session id.
- In the session, select **Kill**. Confirm the tmux window closed and the session no longer appears in the sidebar.
- Resume it: New-session page → select the same folder → **continue** (and separately, as a second pass, via the **Claude session id** path) → submit an empty message to land on the session page.
- **The critical assertion — do NOT send any message to "wake" the session first:** on landing, the chat must render the **ENTIRE prior conversation immediately** — every prior user AND agent message, in server `seq` order, nothing missing. Assert specifically:
  - the **first** prior message and the **last** prior message are both visible,
  - the rendered message **count matches** the recorded server set,
  - there are **no interior gaps** (order by `seq`, not `createdAt`).
- Poll-until-rendered with a timeout; the history must appear **without** a fresh send. A chat that is empty (or only shows the last turn) until you type is a FAIL — that is the exact bug this test exists to catch.
- Only after verifying the restored history, send one new message and confirm it appends **after** the full history, still in order.
- **Validate session artifacts** (Claude log, server seq, tmux window, UI) against the prior Claude session id.

## Test 13: Normal restart shows the FULL transcript immediately (NEW)

Same full-history-on-open guarantee as Test 12, but via the **non-kill restart** paths (the process was alive and re-adopted, or the daemon recovered it) rather than a hard Kill.

- **Archive → restart (sidebar, Test 8 style):** with a multi-turn session, sidebar secondary-click → Archive (confirm the tmux window closed), then restart it from the archive area. On landing, assert the **full transcript is visible immediately** — same first/last/count/no-gap checks as Test 12, and again **without sending a message to wake it**.
- **Daemon-recover variant:** with the same session live, restart `joy-cli` so `recover()` re-adopts it, then open the session in the app. The full prior history must still render on open (the daemon must bind the existing transcript and the app must backfill server history) — no empty-until-first-message state.
- In each variant, after confirming the restored history, send one new message and confirm it appends after it, in order.
- **Validate session artifacts** against the prior Claude session id.

## Test 14: Socket drop → reconnect mid-turn (NEW — order / missing-message)

- Start a long turn, then drop the browser's network mid-response and restore it after the turn completes server-side.
- On reconnect the app must backfill the missed turn and render it **in correct order with nothing missing** (forward-sync + interior-gap repair).
- **Validate artifacts** — the turn sits correctly between its bracketing user messages.

## Test 15: Daemon restart during work

- With a turn (and a background task) active, restart `joy-cli`.
- `recover()` re-adopts the session; status is correct, no messages are lost, and the background count does not get stuck.
- **Background-count orphan check (the `0/1`-stuck regression):** launch a background task so the session shows "N/M completed", then restart `joy-cli` **while it is still running** (so the launch was counted by the old process but the completion lands on the new one). After recovery, let the task finish and confirm the "N/M completed" indicator **clears** — it must not stay stuck at the pre-restart count (e.g. `0/1`). The rebuilt in-memory task set is empty after recovery, so the orphaned completion has nothing to decrement; recovery must reconcile `joy__tasks` (re-derive from the transcript or clear it on attach) rather than leave the server's stale count.
- **Validate artifacts.**

## Test 15b: Dotted project directory (transcript-encoding regression)

Guards the cwd-encoding bug: Claude sanitizes EVERY non-alphanumeric char in the cwd to `-` for its `~/.claude/projects/<dir>` name (`web.app` → `web-app`); a daemon that only replaced slashes looked in a directory that never exists and the transcript never bound (the agenttherapy.org blind-session bug).

- Create a session in `$HOME/joy-test/web.app` (note the DOT; a name with an underscore or space works too).
- Initial message: `What is 3+3?` — expect `6`.
- Assert the daemon bound the transcript: the reply is mirrored into the app chat (a blind session shows nothing), and the daemon's `/sessions` endpoint (`curl http://127.0.0.1:4999/sessions`) shows a non-null `claude_session_id` for it.
- Restart the daemon; after `recover()`, assert the log line shows `transcript=/…/-…web-app/<id>.jsonl` (NOT `transcript=null`) and a follow-up message round-trips.
- **Validate artifacts.**

## Test 15c: Blind recover — session with NO transcript yet

Guards the recovered-blind wedge: a session recovered before its transcript exists must bind it whenever Claude finally writes one, not go permanently deaf (which silently kills dispatch confirmation → every send times out → paused queue).

- Create a NEW session but send **no initial message** (or archive nothing — just land it at the ready prompt with an empty transcript dir for that cwd).
- Restart the daemon. The recover log will show `transcript=null` for it — expected at this point.
- NOW send the first message from the app. Assert: it delivers (types into the pane), the transcript gets created by Claude and BOUND by the daemon (non-null `claude_session_id` on `/sessions` within ~10s), the reply mirrors into the chat, and **no "didn't send" / paused banner** appears.
- **Validate artifacts.**

## Test 15d: Two sessions, one directory (no cross-adoption)

Since multi-session-per-cwd is supported, two sessions in the same folder must never tail each other's transcript (recover's newest-mtime fallback + claim guards).

- Create TWO sessions in the same directory (`$HOME/joy-test`), A then B.
- Send `Say APPLE only` to A and `Say BANANA only` to B. Assert each chat shows only its own exchange (A: APPLE, no BANANA; B vice versa).
- Restart the daemon (both recovered). Send `Say APPLE2 only` to A and `Say BANANA2 only` to B. Assert again: no cross-wiring — each session's chat, tmux pane, and Claude JSONL contain only its own messages, and `/sessions` shows two DISTINCT `claude_session_id`s.
- **Validate artifacts for both sessions.**

## Test 16: Session input from multiple clients

- Open a second browser (no session data); restore via `/restore` with the saved secret key; visit `/` to refresh. The previous session appears in the sidebar.
- From browser two: `Hi my name is Browser Two. Repeat my name to acknowledge you understood.` — expect a response containing "Browser Two"; the message appears in all artifacts.
- Then from each channel send: `Hi my name is Browser One` (original browser) and `Tmux Pane` (direct tmux input). Validate that every message **propagates to every artifact** in order.

## Test 17: Advanced message content

- Send a multiline message; confirm it appears in all artifacts with proper newlines.
- Upload an image of the word "hello" and ask what the word is; confirm the image and the answer appear in all artifacts.

## Test 18: Final

 - Create a new session
 - Make sure its green
 - Ask it to build a lisp interpreter in JavaScript
 - Make sure its blue thinking
 - Wait for it to say finished
 - State should be green
 - Ask to start a process that spins up a process for 15s
 - Status should be teal (N/M count)
 - Status should be green when finished
 - Ask to spin up 3 agents that sleep for 15s
 - Monitor the status to see teal 0/3, 1/3, 2/3
 - Status should be green when finished

