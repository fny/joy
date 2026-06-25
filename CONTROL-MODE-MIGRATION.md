# joy-tmux → tmux control mode (`tmux -C`) migration

**STATUS: COMPLETE** (Phases 0-4). Every steady-state tmux interaction goes over one
persistent `tmux -C` connection per server; spawn remains only as the disconnected
fallback and for four bootstrap/teardown ops that can't use the connection. See the
phased section below for the per-phase commits.

Designed + reviewed with codex (gpt-5.5 xhigh). Goal: replace the per-call `spawnSync`
`run("tmux", …)` invocations with **one persistent control-mode connection per
tmux server**, to kill the ~8ms-per-call spawn + event-loop blocking and replace
`#pollThinking`'s 3s poll with `%output` events. **UX is unchanged** (same app,
same attachable session) — this is a cost/scale/robustness change.

Verified on **tmux 3.4**: `%begin <ts> <command-number> <flags>` … output … `%end`
framing, monotonic command-number for correlation, async `%session-changed`/etc.
interleaved, `capture-pane -p` + `send-keys` work over the connection.

## Current surface (what we're migrating)
- `run()` = `spawnSync` (`src/tmux/shell.ts`).
- 33 call sites, 2 files: `session.ts` (8 capture-pane, 12 send-keys, 3 display-message)
  and `registry.ts` (new-session, new-window, resize-window, set-hook, has-session,
  list-windows, kill-window×2, kill-session).
- Sizing today: `resize-window` flips windows to `window-size manual`; a
  `client-attached` hook (`registry.ts:270`) sets `window-size latest` so a human
  attach reclaims the size. There is **no persistent client** today.

## Key design decisions
1. **Sync→async = hybrid (C).** Cached snapshot for cheap/frequent reads; a **fresh
   awaited capture for the decisions where staleness causes data loss** (the
   dispatch gate's pre-type empty-box check, abort, clear). Don't trust the cache
   there — that's the class of bug we just fixed.
2. **`TmuxDriver` abstraction.** Session/Registry depend on a driver, never on
   `run("tmux")` directly and never on `if (control)` at call sites. The driver
   holds both the spawn impl and (later) the control impl + spawn fallback.
   ```
   TmuxDriver
     captureCached(target): { ok, out, ageMs }   // sync, cache only
     captureFresh(target): Promise<{ ok, out }>  // control command, awaited
     sendKeys(target, …): Promise<Result>
     resizeWindow / displayMessage / …: Promise<Result>
     runRareSync(...args): { ok, out }            // spawn fallback for rare lifecycle ops
   ```
3. **Async pumps with re-check.** `#maybeDrainQueue → void #kickDrain()`;
   `#kickDrain` guards on `#drainActive`, `await captureFresh`, then **re-checks all
   state** (`status`/`#turn`/`#dispatchInFlight`/`#queuePaused`/queue length) before
   dispatching. The re-check after every await preserves the synchronous-tick
   safety we built.
4. **`%output` = invalidation only.** On `%output <pane>`: mark dirty, debounce
   ~50–100ms, `capture-pane -p`, store the latest full text. No virtual-terminal
   model (tmux owns wrapping/scrollback/alt-screen). Keep a slow periodic fallback
   capture as a backstop.
5. **Protocol.** One client per session: `tmux -CC attach-session -t <session>`
   (`-CC` disables command echo). Serial command queue; parse `%end`/`%error` by the
   exact active **command-number** (pane content can contain `%`-looking lines).
   `%output`/`%window-*`/`%layout-change`/`%exit` are notifications (never inside an
   output block, per the man page). **tmux command quoting** (spaces, quotes,
   backslashes, `;`, leading `-`, unicode, newlines) is the sharp edge — leave
   `send-keys -l` on spawn until quoting is proven with tests.
6. **Sizing.** Update the hook to ignore control-mode clients **before** attaching:
   `set-hook client-attached 'if -F "#{client_control_mode}" "" "setw window-size latest"'`.
   App keeps `resize-window -x -y` (manual) as the authority; optionally
   `refresh-client -C` the control client to keep its view coherent (not
   authoritative); a human attach (non-control) still reclaims via the hook.
7. **Reconnect = inside the client.** On EOF/`%exit`/parse-fail: mark disconnected,
   reject pending command promises, keep snapshots but mark stale, reconnect with
   backoff 250ms→500ms→1s→2s→max 5s + jitter; on reconnect reapply the hook,
   `refresh-client -C` last size, re-snapshot windows, resume. **While disconnected,
   critical ops fall back to spawnSync** rather than stall dispatch.

## Phased rollout (incremental, behind one abstraction)
- **Phase 0 — DONE** (`2dd11538`). `TmuxDriver` seam, spawn impl, `session.ts` routed.
  No behavior change.
- **Phase 1 — DONE + verified flag-on** (`db92c25d` client, `7e82758b` driver+pump,
  `e84ce8ef` hook):
  - **1a** `TmuxControlClient` — `tmux -C attach-session` (pipes; `-CC` needs a TTY),
    `%begin/%end/%error` framing keyed on the command-number, FIFO command queue with
    ready-gating, `%output` invalidation, reconnect w/ backoff. Pure parser unit-tested.
  - **1b** driver `captureCached` (snapshot, spawn-filled once, refreshed by a 1s timer
    + debounced `%output`) / `captureFresh` (awaited command, spawn fallback) behind
    `JOY_TMUX_CONTROL`; `tmuxArg()` target quoting. `session.ts`: destructive reads →
    `captureFresh`; watchers → `captureCached`; the dispatch gate → an async pump
    (`#kickDrain`/`#drainOnce`) with `#draining`+`#drainRequested`, re-check-after-await,
    dispatch only on `paneInputText === ""` (null → retry); `abort()` async with a
    stale-abort submit guard.
  - **1c** `client-attached` hook filtered for control clients (set by the client before
    it attaches); `registry.ts` uses the same constant on new-session.
  - **1d — hardening** (codex xhigh review): the control client now keeps **one command
    on the wire at a time** (true FIFO — writes the next only after the current `%end`,
    so a single lost/extra block can't mis-pair every later response); the driver's
    snapshot refresh **coalesces** (`#refreshInFlight`/`#refreshRequested` — an
    `%output`/1s-tick mid-sweep collapses to one trailing sweep instead of overlapping
    2N captures); and the clear/abort paths re-check **after** every awaited capture: an
    `#inputEpoch` (bumped on each type) abandons a guarded `C-c` if a fresh message
    landed mid-capture, the dispatch-gate guards (`#turn`/`#dispatchInFlight`) are
    re-evaluated post-await, and a stale `abort()` returns before Escape if a genuinely
    new send appeared during its capture (a fired submit still interrupts). A codex
    re-review caught the same await-window race on the **drain's empty-box→type gate**
    (`#drainOnce`): it now snapshots the epoch before its capture and re-drains if it
    changed, so a `sendRawKeys` intervention typed mid-capture isn't wiped by the
    racing dispatch's `C-u`.
  - Verified flag-on: window stayed manual-sized; dispatch / send-during-busy /
    abort+clear / status all round-trip over control mode; no client errors. Re-verified
    flag-on after 1d end-to-end (dispatch → reply, abort → clean box, fresh-window
    capture; zero control errors). Flag-off = spawn path unchanged, covered by tests.
- **Phases 2-4 — DONE** (`3c01b3ce` port, `2e02d1e2` hardening). Every steady-state tmux
  op now goes over control mode; spawn remains only as the disconnected fallback and for
  the bootstrap/teardown that can't use the connection.
  - **Serializer** (`src/tmux/serialize.ts`) — `tmuxCommand(args)` quotes argv→command
    line: single-quote (`'\''`) everything that isn't a safe bareword, reject raw
    `\n`/`\r`/NUL, callers insert `--` before user positionals (quoting doesn't stop
    option parsing). 22 unit tests + an empirical round-trip through a real `tmux -C` into
    a `cat` pane (`$HOME`/`;`/backtick/`#{}`/quotes/unicode land verbatim, none executed).
  - **Phase 3 — send-keys.** Driver `key()`/`literal()` are async via `commandOnce()` (the
    NON-IDEMPOTENT no-retry policy: control only when connected at entry, never a spawn
    retry after a control attempt — replaying a keystroke could double-type). `#typeIntoTmux`
    /`sendRawKeys`/`resize` are async with awaited writes + rollback; the submit timer awaits
    the Enter (then re-validates) before mirroring; fire-and-forget writes are `void`-ed.
  - **Phase 2 — resize/display/kill.** Generic idempotent `command(args)` (control when
    connected, spawn fallback on any failure).
  - **Phase 4 — lifecycle.** `new-window` (via `commandOnce` — non-idempotent), `set-hook`,
    `list-windows`, `display-message` routed through the driver. `has-session`/`new-session`/
    `kill-session`/`recover()`'s startup scan stay spawn (`runSync`) — they bracket the
    connection's lifetime (create/destroy the very session it attaches to, or run before
    attach), so they inherently can't use it.
  - **Control client** is now RESOLVE-ONLY: `#pump` try/catch + a stdin `error` listener
    funnel to `#onExit` (guarded against double-reconnect), so a fire-and-forget
    `void tmux.key(...)` can't crash or leak clients.
  - Verified flag-on live: session creation (the heavy-quote claude launch typed over
    control), dispatch→reply, special-char raw keys verbatim, abort, resize, kill — one
    stable control client, zero errors. Flag-off spawn path verified end-to-end.

### Scope outcome
The port is **complete** — control mode is the path for all steady-state interaction. The
only spawns left are (a) the disconnected fallback inside the driver and (b) the four
bootstrap/teardown ops above, which can't go through a connection to the session they
create or destroy. Non-idempotent writes (keystrokes, `new-window`) never spawn-retry
after a control attempt; idempotent ops (capture/resize/display/kill/hook) do.

## Status / notes
- Flag default OFF; turn on with `JOY_TMUX_CONTROL=1`. Soaking on the harness.
- The `registry.ts` slash-commands entanglement is resolved — that feature is committed,
  so the hook change landed clean.
- Deferred within Phase 1: pane→window targeting for `%output` (the coalesced sweep still
  refreshes ALL tracked windows on any output — correct, just not minimal); snapshot
  max-age eviction; a per-command watchdog timeout in the control client (a lost `%end`
  can't wedge the queue in practice — `capture-pane` always answers, and a dead proc →
  `%exit`/EOF → reconnect fails everything — but a timeout would be belt-and-suspenders).
