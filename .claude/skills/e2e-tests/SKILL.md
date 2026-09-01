---
name: e2e-tests
description: Run the joy end-to-end suite as an agent — drive joy-app in a browser against a freshly-built joy-daemon, asserting session artifacts (Claude log, relay seq, tmux window, UI) stay consistent and in order.
---

In `packages/joy-app` and `packages/joy-daemon` you'll find a React Native application and a tmux controller respectively. They communicate through `packages/joy-relay`, the one server: accounts, pairing, machines, push and the `/joy/v1` + `/joy/v2` session plane, all in one Node process on an embedded PGlite store.

You will test the EXACT prod topology, entirely on this box: `stack.sh` boots a local joy-relay, the app runs as a web build via `/chrome-cli` pointed at the relay, and a dedicated joy-daemon process is pinned to the relay's test port. No request leaves the machine; accounts are throwaway by construction (they live in the stack's own PGlite and die with `stack.sh reset`). Run the whole flow end to end.

If anything breaks: make a note, attempt to fix it with a focused commit, and continue the suite. If state is ever contaminated, purge whatever data was created and continue from that point rather than rerunning the whole suite.

## The prod-mirror stack

```bash
.claude/skills/e2e-tests/stack.sh start   # joy-relay :3105 (PGlite under ~/.joy-e2e/relay-data)
.claude/skills/e2e-tests/stack.sh status  # pid
.claude/skills/e2e-tests/stack.sh stop
.claude/skills/e2e-tests/stack.sh reset   # stop + WIPE all relay state (accounts, machines, sessions)
```

State and logs live under `~/.joy-e2e/` (`relay-data/`, `logs/`). The relay URL for EVERYTHING — app server URL, daemon `JOY_RELAY_URL`, curl checks — is **`http://127.0.0.1:3105`**. Never point any harness piece at a remote server; the deployed relays are out of bounds for tests.

## Test account (create fresh, or reuse a saved one)

Run against a **throwaway account on the local stack** — created through the app's normal "Create Account" flow, stored in the stack's own PGlite. Get an account one of two ways:

- **Create fresh (default):** follow Test 0 (Create Account) in the browser. After a `stack.sh reset` this is the ONLY way — the old account is gone with the database.
- **Reuse a saved account:** if you already have the account's restore secret key, log in with Login → "Restore with Secret Key Instead" → paste key (on success the app `router.back()`s to the QR page, which LOOKS like a failure — check `/` for the session list). **Do NOT paste any restore key into this file** — it's committable; keep account secrets outside the repo (e.g. a local scratch note).

**Daemon credentials** come from the app's terminal-pairing flow (so the daemon shares the account's data key and the app can decrypt its session cards) or, for daemon/relay-only suites, from `mint-daemon-creds.mjs` (a fresh account with random keys — the v2 lane needs only token + machineId). Standard daemon start once creds exist under `~/.joy-test`:
  `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux JOY_HOME_DIR=$HOME/.joy-test JOY_RELAY_URL=http://127.0.0.1:3105 PORT=4999 TMUX_SESSION=joy-test pnpm -C packages/joy-daemon start`

**Pair the daemon with the browser account (~1 min):** `JOY_HOME_DIR=$HOME/.joy-test JOY_RELAY_URL=http://127.0.0.1:3105 pnpm -C packages/joy-daemon cli auth http://127.0.0.1:3105` prints a pairing key / link; in a browser already logged into the target account open `http://localhost:8082/terminal/connect#key=<key>` and click "Accept Connection"; the daemon writes `access.key` + `settings.json` (with a new machineId) under `$JOY_HOME_DIR/relays/127.0.0.1_3105/`. Then verify RPC health (Setup step 5) before testing.

**Mint headless daemon creds (no browser, daemon/relay suites):** `TOKEN=$(node .claude/skills/e2e-tests/mint-daemon-creds.mjs --relay http://127.0.0.1:3105 --home $HOME/.joy-test --machine v2-live-e2e)` — prints the account bearer so the same account can drive the client side over HTTP.

## Isolation — never touch prod or the harness

There are usually OTHER joy daemons running on this machine. Do not clobber them. Use a dedicated set throughout:

- `JOY_HOME_DIR=$HOME/.joy-test` (daemon home — **not** `~/.joy` (the live daemon on this box))
- `TMUX_SESSION=joy-test`
- daemon `PORT=4999`, shut down any existing `joy-*` tmux sessions and processes, leave vanilla `joy` alone
- Metro on a DEDICATED **`:8082`** — never the user's dev server on `:8081`; kill any process already holding `:8082`
- chrome via `/chrome-cli` with a **dedicated `--user-data-dir`**, headless.
  **Chrome gotchas on this box (cost hours — do not rediscover):**
  (1) **`env -u DISPLAY` is MANDATORY.** The shell exports a dead SSH-forwarded
  X display (`DISPLAY=localhost:10.0`); every chromium — even `--headless` —
  connects to it at startup and hangs FOREVER with zero output (binds the CDP
  port but never answers HTTP/WS). (2) Snap chromium can't read profiles under
  `/tmp` or hidden `~/.*` dirs (snap confinement) — prefer the playwright
  build at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` with a
  VISIBLE profile dir like `~/joy-e2e-chrome`. Known-good launch:
  `env -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS <chrome> --headless=new
  --no-sandbox --disable-gpu --disable-dev-shm-usage
  --remote-debugging-port=9222 --user-data-dir=$HOME/joy-e2e-chrome`.
  (3) Never `pkill -f <pattern>` where the pattern also appears in your own
  compound command — it kills your shell; free ports with `fuser -k
  <port>/tcp` instead. (4) chrome-cli `eval` chokes on multi-statement
  scripts — wrap them in an IIFE.

### tmux: use a DEDICATED SERVER SOCKET (critical)

**You (the agent) run inside tmux session `0` on the default server** (`/tmp/tmux-1000/default`), alongside the user's other sessions (`joy-e2e`, `codex-e2e`). joy-daemon always shells out to bare `tmux` (default socket) — so if you run the daemon as-is, its windows, `client-attached` resize hooks, and session churn land on the **same server you're running in** and disrupt the user.

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

1. **Build gate.** `pnpm install`, then `pnpm -C packages/joy-daemon typecheck && pnpm -C packages/joy-daemon test` and `pnpm -C packages/joy-app typecheck`. tsx ships TS errors as *runtime* crashes, so never e2e-test code that doesn't typecheck.
1a. **Stack up.** `stack.sh start` and wait for "stack healthy". `stack.sh reset` first when you want a pristine database. Sanity: `curl -s http://127.0.0.1:3105/joy/v1/capabilities` and `curl -s http://127.0.0.1:3105/joy/v2/auth/request/status?publicKey=00` (→ 401 malformed key) both answer from the relay itself.
2. **Purge stale state.** Kill any `joy-test` tmux session, any process on `:4999` and `:8082`; `rm -rf $HOME/.joy-test $HOME/joy-test`.
3. **Fresh bundle.** Start Metro with `--clear` on `:8082`, with `EXPO_PUBLIC_JOY_SERVER_URL=http://127.0.0.1:3105` so the app targets the local relay (or set the custom server URL in the app UI). **Verify the served bundle is fresh** (Metro's file-watcher can silently serve a frozen bundle, and the browser caches modules) — grep the served bundle for a known-current string and hard-reload chrome (clear its cache) before trusting the UI.
4. **Start the daemon from latest source** (pinned to the test relay): `env -u TMUX -u TMUX_PANE TMUX_TMPDIR=/tmp/joy-test-tmux JOY_RELAY_URL=http://127.0.0.1:3105 PORT=4999 JOY_HOME_DIR=$HOME/.joy-test TMUX_SESSION=joy-test pnpm -C packages/joy-daemon start`. Confirm the process start-time is *after* HEAD's commit (a long-lived tsx daemon does NOT hot-reload).
5. **RPC health check (critical).** Once the daemon is paired, make one machine op through the relay tunnel (e.g. the app's machine page, or `joy-status` via `POST /joy/v2/machines/<id>/http`) and assert it returns **non-null**. A machineKey drift between the daemon's `access.key` and the app's copy of the machine record makes every op fail to decrypt — abort the suite with a clear message if so.

## Definitions — "session artifacts" and how to validate them

The same messages, in the same order, must appear in all four artifacts:

| Artifact | How to read it |
|---|---|
| Claude session log | `~/.claude/projects/<cwd-with-/-as->/<claude-session-id>.jsonl` |
| relay sequence | `GET <relayUrl>/joy/v2/sessions/<relay-id>/messages` (Authorization: Bearer `<token from access.key>`) |
| `joy-daemon` tmux window | `tmux capture-pane -t joy-test:<window> -p` |
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

# Tests — three suites

VERY IMPORTANT: the goal is for these to run in one shot, in order, from one account.
Do not parallelize. Walk each test yourself (chrome CLI + tmux panes + files + server),
fix bugs as you find them (focused commit), and continue from where you were.

The tests are split into three suite files in this directory:

| Suite | File | Scope |
|---|---|---|
| **Chat** (agent-agnostic) | `suite-chat.md` | The shared pipeline: create/send/receive, ordering, exactly-once, queueing, abort, restart-history, terminal view, multi-client. **Run once with AGENT=claude and once with AGENT=codex.** |
| **Claude** | `suite-claude.md` | claude-only: background tasks/agents (teal N/M), joy-bg long-running, permission prompts, slash commands, continue/fork/resume-by-id, transcript-binding recovery (dotted dirs, blind recover, two-sessions-one-dir), final integration. |
| **Codex** | `suite-codex.md` | codex-only: new-session codex options, model identity, attach TUI, thread resume, orphan rejoin, non-yolo approvals, settings persistence. |
| **v2** | `suite-v2.md` | the native /joy/v2 durable plane through the app's dev "Relay v2 Mode": queueing, delivery states, ephemeral streaming, retry, cancellation, attachments. Daemon side driven by the scripted actor; `suite-v2-daemon.md` runs the same plane with the real daemon. |

**Run order:** Setup + Test 0 (below) → chat suite (AGENT=claude) → claude suite →
chat suite (AGENT=codex) → codex suite → v2 suite → Teardown.

## Test 0: Create a new account

- Launch `joy-app` (web, `:8082`) in chrome.
- Click "Create Account".
- Visit `/settings/account`, click "Secret Key", copy and remember it.
- `rm -rf $HOME/.joy-test` and recreate it empty; stop any `joy-test` tmux session.
- Start the daemon (Setup step 4).
- Run the RPC health check (Setup step 5) — abort if it fails.

## Teardown

- Archive/kill any sessions created; confirm their tmux windows are gone.
- Stop the test daemon (`:4999`); kill the `joy-test` tmux session.
- `rm -rf $HOME/.joy-test $HOME/joy-test` and the chrome `--user-data-dir`.
- `stack.sh stop` (or `stack.sh reset` to also wipe accounts/sessions for the next run).
- Leave the LIVE daemon on this box and the deployed relays untouched.
