# joy-tmux → tmux control mode (`tmux -C`) migration

Designed with codex (gpt-5.5 xhigh). Goal: replace the 33 per-call `spawnSync`
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
- **Phase 0** — Introduce `TmuxDriver` with the **spawn implementation only**. Route
  `session.ts` (and optionally `registry.ts`) through it. **No behavior change.**
  Verify: typecheck + 101 tests + daemon still drives the live harness.
- **Phase 1** — Add the control client behind `JOY_TMUX_CONTROL=1`. Update the
  sizing hook to ignore control clients. Migrate capture-pane reads: `#pollThinking`
  → cached snapshot; dispatch-gate/abort/clear → `captureFresh` (async pump).
- **Phase 2** — Migrate safe non-literal commands: `resize-window`, `display-message`,
  `kill-window`.
- **Phase 3** — Migrate `send-keys` after the command-quoting test suite passes; keep
  the raw `send-keys -l` spawn fallback until confident.
- **Phase 4** — Lifecycle ops (`new-session`/`new-window`/`has-session`/…). Rare; no
  rush; can stay on spawn indefinitely.

## Open coordination
- `registry.ts` carries **uncommitted slash-commands work**; Phase 1's hook change
  touches it. Either commit that first or seam the hook change carefully. (Phase 0
  can stay in `session.ts` to avoid the entanglement.)
- Keep the env flag default OFF until Phase 1 soaks on the harness.
