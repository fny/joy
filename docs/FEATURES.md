# joy feature map

What the product does and how the pieces connect. Maintained by hand — update
alongside API.md whenever a user-visible feature ships (both files are part of
the definition of done; the in-app What's New lives separately in
`packages/joy-app/CHANGELOG.md`).

## The one-paragraph model

joy is a phone/desktop cockpit for coding agents running inside tmux on your
machines. A **joy-daemon** per machine adopts or spawns agent sessions
(claude, codex, opencode, pi), parses their state, and relays everything
end-to-end encrypted through a **relay** (happy-server) to the **joy-app**
(Expo RN: iOS/Android/web/Tauri desktop). One account backup code works on
every relay; machines register per account.

## Sessions

- **Create** from the app (+ button): pick machine → directory → agent →
  model/effort/permissions (per-agent defaults with user overrides,
  Settings → Agent Defaults). All agents always shown; the daemon rejects
  unknown ones loudly ("run joy update?").
- **Resume / fork claude sessions**: new-session page lists past transcripts
  in the chosen directory (radio picker); session actions offer Fork (new
  claude session id via `--resume --fork-session`) and Duplicate. Fresh
  sessions are pinned to a generated `--session-id` so several can share a cwd.
- **Adopt & restart**: daemon recovers live tmux windows at boot; sessions can
  be restarted in place; kill one / kill all.
- **Four flavors, one interface** (`AgentSession`): claude (tmux pane +
  transcript tail), codex (app-server JSON-RPC + attach TUI), opencode
  (serve API), pi (bare `--mode rpc` stdio). Flavor shows in the session list
  and per-agent grouping in Settings → Sessions.

## Messaging path

- **Durable dispatch queue** per claude session: verified typing into the pane,
  queue survives restarts, seq-dedupe against relay redelivery; queued rows
  render app-side in a drafts-style collapsible strip (`QUEUED · N`) with
  per-item edit/cancel/**steer** (arrow = cancel + `/steer` immediate send).
- **Steer**: `/steer` bypasses the queue mid-turn (claude); codex/opencode/pi
  route through their native steer/queue semantics.
- **Drafts**: composer stash button; drafts sit at the chat bottom.
- **Slash commands** the daemon owns: `/title`, `/steer`, `/btw`,
  `/login-code`, `/joy-prompt` (re-inject current instructions — the fix for
  long sessions forgetting the tag vocabulary; also the only way pi gets it).
- **Attachments**: images from library/file/paste; **drawing pad** (full-screen
  finger sketch → PNG, five pens, two papers, four widths); files up to 400KB
  inline, larger via encrypted blobs both directions (readFile spills to blob).

## Chat rendering

- Markdown + tool cards; tool cards collapse individually (chevron) and
  globally (header top-left collapse-all button, `useToolsCollapsed`).
- Code diffs render with a `Diff +N −M` toggle row (Edit/Write/MultiEdit).
- Compaction summaries arrive as a collapsed "Compaction summary" card
  (previously dropped entirely).
- `<options>` blocks become tap-to-answer pickers; `<joy-img>`/`<joy-file>`
  render inline; `<joy-title>` retitles (user `/title` locks); `<joy-notify>`
  becomes a push.
- Cmd/Ctrl+F in-session search with match cycling.
- Composer info line: agent · model · reasoning · permissions.

## Terminal (pane) view

Live ANSI mirror of the tmux pane, adaptive width (last connector drives
cols), text + raw-key input modes, quick-key bar. **Simple mode** (default)
strips claude's status chrome below the input box; Full toggle restores it.
This is the intervention surface — trust prompts, TUI menus, wedged sessions.

## Machines

- Machine page: CPU / **Memory % / Disk %** (red ⚠ at ≥90%), model/cores/load,
  slash-command inventory, daemon version + update.
- Session header shows a red banner when the session's machine crosses 90%
  RAM/disk (resource pressure correlates with queue/stray-text weirdness).
- Daemon pushes alerts at the same thresholds plus claude/codex quota ≥90%
  (edge-triggered, 4h cooldown) — groundwork for iOS Live Activities (native
  build still pending).

## Usage & limits

- **Usage** (Settings): transcript-derived cost/tokens per period/project/
  model/session/tool, per machine or aggregated; daemon keeps a persistent
  parse cache (`~/.joy/usage-cache.json`) warmed every 2h.
- **Limits** (Settings): server-truth account quota — claude 5h/weekly
  utilization + reset times via the machine's own Claude Code OAuth token;
  codex windows from rollout `rate_limits`. No credential entry.

## Agent configuration

- **Agent Defaults**: per-agent model/effort/permission defaults + overrides.
- **Agent Config** (Settings): edit each agent's real config file on a machine
  — schema-walked rows (claude/opencode publish JSON Schemas) or raw mode with
  full-file editing and JSON-path assignment lines
  (`examples[0].title = "hi"`); daemon backs up `.joy-bak` on every write.

## Identity & relays

- One backup code pairs everything: app relay picker (Happy Cloud + Joy
  Relay), `joy auth <relay...>` CLI self-pairing, per-relay MMKV scoping so
  accounts never bleed. joy-dev/happy-joy doors removed from the picker.
- Hashicon avatars snapped to the joy logotype palette.
- Deploys: app via EAS OTA (desktop + mobile ALWAYS together); daemon via git
  release branch (`git push main:release` + `joy update` on each box).

## Files & git

Session Files view: git **Changes** (staged/unstaged/untracked groups, line
counts) and searchable **All Files** tree; file page renders source/diff/
rendered modes (Markdown, HTML, CSV/TSV, images), zoom/wrap, download; desktop
adds a CodeMirror editor with hash-guarded saves and conflict diff. Daemon FS
ops are jailed to the session cwd (+ read-only `~/.joy/sessions/<id>` media).

## Account, voice, extras

- Account: backup-key reveal/restore, QR device-link approval, terminal-auth
  deep links, push-token administration, GitHub/service connections.
- Voice assistant (ElevenLabs realtime) with language pick and custom agent id.
- Encrypted Markdown artifacts (routes live; not linked from nav yet).
- joy CLI: `joy` daemon control (`update`, `auth <relay...>`, `new --agent`,
  install/uninstall services), release-branch installs.
- Machine cleanup page: close detached panes, purge per-folder or per-machine
  records, delete machines.
- Dev tools: always-on developer pages, OTA identity + manual update check,
  in-app changelog (What's New), 10-tap dev mode.

## Cross-cutting invariants

- happy-* packages are pristine upstream mirrors; happy-server is never
  modified.
- Everything user-visible is E2E-encrypted through the relay.
- tsx runs untyped — `pnpm typecheck && pnpm test` before shipping daemon
  changes; e2e suite (`.claude/skills/e2e-tests`) covers the tmux
  control-mode path unit tests can't.
