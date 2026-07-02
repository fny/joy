---
name: agent-e2e-tests
description: Run the joy end-to-end suite as an agent — drive joy-app in a browser against a freshly-built joy-tmux, asserting session artifacts (Claude log, happy-server seq, tmux window, UI) stay consistent and in order.
---

In `packages/joy-app` and `packages/joy-tmux` you'll find a React Native application and a tmux controller respectively. These both communicate via `packages/happy-server`, which must **never be modified**.

You will test these by launching `joy-app` as a web app via `/chrome-cli`, creating a new account + session, and running `joy-tmux` attached to an **isolated** home/tmux/port set (below). Run the whole flow end to end.

If anything breaks: make a note, attempt to fix it with a focused commit, and continue the suite. If state is ever contaminated, purge whatever data was created and continue from that point rather than rerunning the whole suite.

## Test account (create fresh, or reuse a saved one)

Run against a **throwaway account** on the test server `https://api.cluster-fluster.com` (NOT prod) — never point the harness at prod. Get an account one of two ways:

- **Create fresh (default):** follow Test 0 (Create Account) in the browser. Use this whenever you don't have a saved account key on hand.
- **Reuse a saved account:** if you already have the account's restore secret key, log in with Login → "Restore with Secret Key Instead" → paste key (on success the app `router.back()`s to the QR page, which LOOKS like a failure — check `/` for the session list). **Do NOT paste any restore key into this file** — it's committable; keep account secrets outside the repo (e.g. a local scratch note).

**Daemon credentials MUST be a dataKey account.** A legacy-credential account makes *every* machineRPC silently return `null` — `joy-create-session` fails with `Cannot use 'in' operator … in null`, and the same symptom appears if a machine's stored key drifts from the server's machine record (a machineKey mismatch after a re-auth). A fresh "Create Account" is dataKey; verify via the RPC health check (Setup step 5), don't assume. Standard daemon start once creds exist under `~/.joy-test`:
  `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux HAPPY_HOME_DIR=$HOME/.joy-test PORT=4999 TMUX_SESSION=joy-test pnpm -C packages/joy-tmux start`

**Mint fresh daemon creds non-interactively (~1 min):** run `HAPPY_HOME_DIR=$HOME/.joy-test HAPPY_SERVER_URL=https://api.cluster-fluster.com npx tsx joytest-auth.ts` from `packages/happy-cli`; it prints `APPROVE_KEY=<key>`; in a browser already logged into the target account open `http://localhost:8082/terminal/connect#key=<key>` and click "Accept Connection"; the script writes a fresh dataKey `access.key` + `settings.json` (with a new machineId) into `$HAPPY_HOME_DIR` and exits `WROTE_DATAKEY`. Then verify RPC health (Setup step 5) before testing.

`joytest-auth.ts` is an UNTRACKED file — recreate it at `packages/happy-cli/joytest-auth.ts` from this source if it's gone (it's the non-interactive daemon-auth helper: replicates happy-cli's `waitForAuthentication` without the Ink TUI):

```ts
// E2E test helper: non-interactive daemon auth. Replicates happy-cli's
// waitForAuthentication WITHOUT the Ink TUI — POST /v1/auth/request, then poll
// until the web app (driven separately) approves, then write a dataKey access.key.
import { configuration } from "@/configuration";
import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { decryptWithEphemeralKey } from "@/ui/auth";
import { writeCredentialsDataKey, writeCredentialsLegacy, updateSettings } from "@/persistence";
import { randomBytes, randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import axios from "axios";

async function main() {
  const secret = new Uint8Array(randomBytes(32));
  const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
  const pubB64 = encodeBase64(keypair.publicKey);
  const hdrs = { headers: { "X-Happy-Client": "cli/e2e" } };
  console.error("SERVER=" + configuration.serverUrl);
  console.error("HOME=" + configuration.happyHomeDir);
  console.error("APPROVE_KEY=" + encodeBase64Url(keypair.publicKey));
  await axios.post(`${configuration.serverUrl}/v1/auth/request`, { publicKey: pubB64, supportsV2: true }, hdrs);
  console.error("REQUEST_SENT");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await axios.post(`${configuration.serverUrl}/v1/auth/request`, { publicKey: pubB64, supportsV2: true }, hdrs);
    if (resp.data.state !== "authorized") continue;
    const token = resp.data.token as string;
    const decrypted = decryptWithEphemeralKey(decodeBase64(resp.data.response), keypair.secretKey);
    if (!decrypted) { console.error("DECRYPT_FAILED"); process.exit(1); }
    if (decrypted.length === 32) {
      await writeCredentialsLegacy({ secret: decrypted, token });
      console.error("WROTE_LEGACY (warning: machineRPC will not work)");
    } else if (decrypted[0] === 0) {
      await writeCredentialsDataKey({ publicKey: decrypted.slice(1, 33), machineKey: new Uint8Array(randomBytes(32)), token });
      console.error("WROTE_DATAKEY");
    } else { console.error("BAD_RESPONSE"); process.exit(1); }
    const s = await updateSettings(async (st: any) => ({ ...st, machineId: st.machineId || randomUUID() }));
    console.error("DONE machineId=" + (s as any).machineId);
    process.exit(0);
  }
  console.error("TIMEOUT — not approved within 180s");
  process.exit(1);
}
main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
```

## Isolation — never touch prod or the harness

There are usually OTHER joy daemons running on this machine. Do not clobber them. Use a dedicated set throughout:

- `HAPPY_HOME_DIR=$HOME/.joy-test` (happy data — **not** `~/.happy` (prod) or `~/.happy-e2e` (harness))
- `TMUX_SESSION=joy-test`
- daemon `PORT=4999`, shut down any existing `joy-*` tmux sessions and processes, leave vanilla `joy` alone
- Metro on a DEDICATED **`:8082`** — never the user's dev server on `:8081`; kill any process already holding `:8082`
- chrome via `/chrome-cli` with a **dedicated `--user-data-dir`**, headless

### tmux: use a DEDICATED SERVER SOCKET (critical)

**You (the agent) run inside tmux session `0` on the default server** (`/tmp/tmux-1000/default`), alongside the user's other sessions (`joy-e2e`, `codex-e2e`). joy-tmux always shells out to bare `tmux` (default socket) — so if you run the daemon as-is, its windows, `client-attached` resize hooks, and session churn land on the **same server you're running in** and disrupt the user.

Run the daemon — and every tmux command you issue for the test — on a **private tmux server** so it is physically incapable of touching the user's sessions:

```bash
# private socket dir; $TMUX must be UNSET or tmux targets the inherited (default) server
TT="env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux"
$TT tmux new-session -d -s joy-test    # create the isolated session
$TT tmux ls                            # inspect ONLY the private server
```

Launch the daemon with that same env (`env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux …`). **Never** run `tmux kill-session`, `resize`, or set global hooks against the default server (sessions `0`, `joy-e2e`, `codex-e2e`).

If a previous run left state, kill/remove it first (see Setup).

## Setup (run once, fail-fast — do not start tests until all pass)

1. **Build gate.** `pnpm install`, then `pnpm -C packages/joy-tmux typecheck && pnpm -C packages/joy-tmux test` and `pnpm -C packages/joy-app typecheck`. tsx ships TS errors as *runtime* crashes, so never e2e-test code that doesn't typecheck.
2. **Purge stale state.** Kill any `joy-test` tmux session, any process on `:4999` and `:8082`; `rm -rf $HOME/.joy-test $HOME/joy-test`.
3. **Fresh bundle.** Start Metro with `--clear` on `:8082`. **Verify the served bundle is fresh** (Metro's file-watcher can silently serve a frozen bundle, and the browser caches modules) — grep the served bundle for a known-current string and hard-reload chrome (clear its cache) before trusting the UI.
4. **Start the daemon from latest source:** `PORT=4999 HAPPY_HOME_DIR=$HOME/.joy-test TMUX_SESSION=joy-test pnpm -C packages/joy-tmux start`. Confirm the process start-time is *after* HEAD's commit (a long-lived tsx daemon does NOT hot-reload).
5. **RPC health check (critical).** Once an account + session exist, make one `machineRPC` call (e.g. list sessions) and assert it returns **non-null**. A legacy-credential account makes *every* RPC silently return `null` — abort the suite with a clear message if so. A fresh "Create Account" should be a **dataKey** account; verify, don't assume.

## Definitions — "session artifacts" and how to validate them

The same messages, in the same order, must appear in all four artifacts:

| Artifact | How to read it |
|---|---|
| Claude session log | `~/.claude/projects/<cwd-with-/-as->/<claude-session-id>.jsonl` |
| happy-server sequence | `GET <serverUrl>/v1/sessions/<relay-id>/messages` (Authorization: Bearer `<token from access.key>`) |
| `joy-tmux` tmux window | `tmux capture-pane -t joy-test:<window> -p` |
| UI | `/chrome-cli` snapshot / eval against the session view |

For **every** "validate artifacts" step assert:
- **Same set** of messages present in each.
- **Same order = server `seq`** (monotonic, gap-free), NOT `createdAt` — agent envelopes carry Claude transcript-time, user messages carry relay-time, so a late-relayed turn sorts wrong under createdAt. (This is the exact class of bug that hides a response between two user messages.)
- **Exactly once** — a sent message appears once per artifact (no duplicate from the receipt/echo path).
- **Status color** — read it via computed style / the status text, not a screenshot guess.
- **Wait correctly** — poll-until-condition with a timeout; never a fixed `sleep`.

## Status taxonomy (prerequisite)

The final palette (do NOT assert the old orange/yellow-for-bg scheme):
- **gray** = idle / disconnected sidebar dot
- **blue** = working (a normal turn)
- **teal `#30B0C7`** = FINISHING background tasks in flight (bg processes / agents), shown with the "N/M completed" count (`joy__tasks`)
- **yellow `#FFCC00`** = permission required
- **green** = online / just finished
- **Long-running** processes the agent tagged `<joy-bg … long-running />` (dev servers, watchers) are NOT in the N/M and get no color of their own — they render as plain text appended to the status, e.g. "ready, 3 background processes" (`joy__longRunning`).

**Why this suite is non-optional after daemon changes:** the unit tests run with `VITEST=true`, which DISABLES tmux control mode entirely — this suite is the ONLY coverage of the control-mode pane-capture path (`src/tmux/driver.ts`: %output-scoped snapshot refresh, pane→window mapping, the slow backstop sweep). Any driver/capture change is unverified until this suite runs.

# Tests

VERY IMPORTANT YOUR JOB: Remember the goal is for these tests to be able to run in one shot from start to finish from an account. They should not be parallelized.

The goal is for you to walk through each of these test yourself and perform the verification your self in order. If anything breaks, you fix the bug, commit, and then continue testing from where you were, or cleaning up enough to continue.

The final veification is that everything should pass in order.

You should drive chrome CLI to perform this and look at the tmux panes to gather info as needed as well as look at files on disk and investigate the server.

You should do this directly and not through another agent.

## Test 0: Create a new account

- Launch `joy-app` (web, `:8082`) in chrome.
- Click "Create Account".
- Visit `/settings/account`, click "Secret Key", copy and remember it.
- `rm -rf $HOME/.joy-test` and recreate it empty; stop any `joy-test` tmux session.
- Start the daemon (Setup step 4).
- Run the RPC health check (Setup step 5) — abort if it fails.

## Test 1: Create the first session

- `rm -rf $HOME/joy-test` (the session's working directory).
- Visit the new-session page; create a session in `$HOME/joy-test` with default settings.
- Initial message: `What is 4+4?`. When prompted to create the directory, say yes.
- You're moved to the session page; the response should be `8` / "eight" / similar.
- Chat status: **online / green**. Sidebar button: **gray**.
- The sidebar title should NOT say "New Chat" — it should reflect the conversation.
- **Validate session artifacts** for both messages.

## Test 2: Basic session states

- Status starts **online**.
- Send `write me a long paragraph of lorem ipsum`.
- Status turns **blue** (working) in both the session view and the sidebar button.
- Navigate to the settings page; when work finishes the sidebar button goes blue → **green**.
- Back in the session: a long block of text is returned; session status **online/green**, sidebar **gray**.
- **Validate session artifacts** (order by seq).

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
- **Daemon-recover variant:** with the same session live, restart `joy-tmux` so `recover()` re-adopts it, then open the session in the app. The full prior history must still render on open (the daemon must bind the existing transcript and the app must backfill server history) — no empty-until-first-message state.
- In each variant, after confirming the restored history, send one new message and confirm it appends after it, in order.
- **Validate session artifacts** against the prior Claude session id.

## Test 14: Socket drop → reconnect mid-turn (NEW — order / missing-message)

- Start a long turn, then drop the browser's network mid-response and restore it after the turn completes server-side.
- On reconnect the app must backfill the missed turn and render it **in correct order with nothing missing** (forward-sync + interior-gap repair).
- **Validate artifacts** — the turn sits correctly between its bracketing user messages.

## Test 15: Daemon restart during work

- With a turn (and a background task) active, restart `joy-tmux`.
- `recover()` re-adopts the session; status is correct, no messages are lost, and the background count does not get stuck.
- **Background-count orphan check (the `0/1`-stuck regression):** launch a background task so the session shows "N/M completed", then restart `joy-tmux` **while it is still running** (so the launch was counted by the old process but the completion lands on the new one). After recovery, let the task finish and confirm the "N/M completed" indicator **clears** — it must not stay stuck at the pre-restart count (e.g. `0/1`). The rebuilt in-memory task set is empty after recovery, so the orphaned completion has nothing to decrement; recovery must reconcile `joy__tasks` (re-derive from the transcript or clear it on attach) rather than leave the server's stale count.
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

## Teardown

- Archive/kill any sessions created; confirm their tmux windows are gone.
- Stop the test daemon (`:4999`); kill the `joy-test` tmux session.
- `rm -rf $HOME/.joy-test $HOME/joy-test` and the chrome `--user-data-dir`.
- Leave prod (`:4997`/`~/.happy`) and the harness (`:4998`/`~/.happy-e2e`) untouched.
