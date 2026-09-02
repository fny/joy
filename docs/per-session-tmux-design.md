# Per-session tmux servers

**Status: DESIGN — not implemented.** Motivated by a production incident
(2026-08-25): a 12-day shared tmux server reached 8.3GB of LIVE heap (zero
scrollback, `malloc_trim` no-op — a genuine leak, likely extended-cell
allocations under constant claude-TUI redraw). With one shared server the
only remedy kills every session at once.

## Principle

The leak cannot be prevented (it is inside tmux), so it must be **bounded**.
Bind each leak's lifetime to one session: give every agent session its OWN
tmux server. `kill-server` at session end returns every byte to the OS
unconditionally — process exit is the one memory reclaim that never fails.
A bloated session can be rotated (`joy restart`) without touching neighbors.

## Current topology → target

|  | today | target |
|---|---|---|
| tmux server | one per DAEMON (default socket; `-L joy-<relayKey>` off-default relays) | one per AGENT SESSION |
| tmux session/window | one session (`$TMUX_SESSION`), one window `j-<id>` per agent | one session `j-<id>`, one window, per server |
| control client | ONE `tmux -C attach` multiplexing %output for all panes | one per agent session |
| session end | `kill-window` (server keeps the leak) | `kill-server` (OS reclaims all) |
| recover() | `list-windows -t $TMUX_SESSION` on the shared server | iterate window records → probe each socket |

## Design

### 1. Socket naming & discovery
- Socket label: `joy-<sessionId>` (2026-09-02; was `joy-<relayKey>-s-<sessionId>` —
  records with the old label keep resolving via `tmuxNamesFor` until they end).
  Session name `joy-<sessionId>`, the agent in a window pinned to `agent`
  (`automatic-rename off`), so `joy-<id>:agent` is a stable target and other
  windows can live beside it. EVERY agent (claude, codex, opencode, pi) uses
  this; the shared server is legacy-only (`JOY_TMUX_PER_SESSION=0`).
  Lives in the standard `/tmp/tmux-$UID/` (or `$TMUX_TMPDIR` — e2e private
  tmpdirs compose unchanged), so a human can attach with plain
  `tmux -L joy-<id> attach`, no env required.
- `windowRecord` gains `socket: string | null` (null = legacy shared-server
  window). Discovery is record-driven, not server-driven: recovery no longer
  depends on one server knowing every window.

### 2. Driver becomes a per-session handle
`tmuxArgv()`/the module-level driver assume one socket per process. Replace
with a `TmuxHandle { socketArgs, session }` owned by each `AgentSession`,
produced by a small pool keyed on socket label (so registry-level ops reuse
the session's handle). The driver code itself is unchanged — it is already
parameterized through `tmuxArgv()`; the change is plumbing WHICH argv prefix
each call site uses. Control-mode: one `ControlClient` per handle, attached
to that server. Cost per session: one `tmux -C` child + pipes (~1-3MB) on
top of the server itself (~3-6MB) — tens of sessions ≈ tens of MB, noise
against an 8GB failure mode.

The **fallback ladder is per-session now**: a control-client wedge degrades
one session to spawn-mode instead of degrading every session (today a sick
control client is a daemon-wide event). Same for the client-attached /
window-size hooks: installed per server, so one human attach can never
interact with another session's sizing.

### 3. Lifecycle
- **create**: first command on a fresh `-L` label auto-spawns the server;
  `new-session -d -s j-<id>` + hooks + agent launch. Record socket in the
  window record BEFORE launch (crash between server-spawn and record leaves
  an empty server — see sweeps below).
- **end / kill / killAll**: `kill-server` on the session's socket. killAll
  iterates records; legacy windows still get `kill-window` on the shared
  server.
- **recover()**: for each window record with a socket — `has-session` probe;
  alive → adopt (unchanged adoption path, scoped to that handle); dead →
  stale socket file unlinked, record archived. Records with `socket: null`
  go through the legacy shared-server path until that population ages out.
- **sweeps**: an alive server whose record is gone (crash window above, or
  manual mischief) is an orphan — enumerate `/tmp/tmux-$UID/joy-*s-*`
  sockets, probe, kill servers with no matching record and no attached
  human client. Conservative: never touch sockets outside our label scheme.

### 4. Attach & operator UX
- `joy attach <id>` (CLI) → `exec tmux -L joy-<id> attach` — becomes the
  documented front door; `joy ls` prints id → socket → attach hint.
- The app's terminal view is unaffected (it rides the daemon's pane stream,
  which now reads through the session's own handle).
- Raw `tmux ls` no longer shows joy sessions — accepted cost, mitigated by
  `joy ls`. e2e suite docs updated to target per-session sockets for
  capture-pane cross-checks.

### 5. Rollout
- Flagged: `JOY_TMUX_PER_SESSION` (default ON) applies to NEW sessions only.
  Live sessions keep their shared-server windows and the legacy paths until
  they end — no migration, no flag day, dual population handled by the
  `socket` field.
- The shared server dies naturally once its last legacy window closes
  (`kill-window` on the final window leaves an empty server; the orphan
  sweep may then retire it).

### 6. What this does NOT fix
- A single long-lived session can still bloat its own server. Remedy stays
  `joy restart <id>` — which now rotates the server too (full reclaim).
  Future option: per-server RSS watch → surface a "session heavy" notice.
- The leak itself. Independent mitigations worth doing regardless: upgrade
  tmux (extended-cell leak fixes), enable control-mode flow control
  (`refresh-client -f pause-after`) so a stalled reader can't pin server
  memory.

## Touch points (implementation inventory)
- `src/paths.ts` — `tmuxSocketArgs(sessionId?)`, label scheme.
- `src/tmux/shell.ts` / `driver.ts` — argv prefix parameterization + handle
  pool; `ControlClient` per handle (attach target unchanged otherwise).
- `src/domain/registry.ts` — create/recover/killAll/restart on handles;
  orphan sweep; hook install per server.
- `src/domain/windowRecord.ts` — `socket` field (additive).
- joy CLI — `attach`/`ls` affordances.
- `.claude/skills/e2e-tests/` — capture commands per socket.

## Open questions
1. ~~Should codex/opencode/pi sessions get servers too?~~ **Done 2026-09-02:
   uniform.** codex's attach TUI moved onto its own server (it redraws like
   any TUI); opencode/pi have no pane at all.
2. Auto-rotation threshold (restart a session whose server RSS crosses N
   GB)? **Proposed: not in v1** — observe first via a `joy ls` RSS column.
3. Does anything depend on cross-session tmux state (global options,
   status line)? Audit during implementation; per-relay servers already
   forced most of this to be per-server-safe.
