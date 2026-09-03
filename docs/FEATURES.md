# joy feature map

What the product does and how the pieces connect. Maintained by hand — update
alongside API.md whenever a user-visible feature ships (both files are part of
the definition of done; the in-app What's New lives separately in
`packages/joy-app/CHANGELOG.md`).

## The one-paragraph model

joy is a phone/desktop cockpit for coding agents running inside tmux on your
machines. A **joy-daemon** per machine adopts or spawns agent sessions
(claude, codex, opencode, pi), parses their state, and relays everything
end-to-end encrypted through the **joy-relay** (`/joy/v2`: durable queue,
accounts, machines, push, E2E tunnel — one server, PGlite-backed) to the **joy-app**
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
  Shared sections: options, images, files, notify, title, peers
  (`<joy-message>`), and the joy CLI (sessions/talking/env verbs, with the
  rule not to touch env vars unasked) — `domain/agentTagsPrompt.ts`.
- **Attachments**: images from library/file/paste (up to 20 per message, 10MB
  each); **drawing pad** (full-screen finger sketch → PNG, five pens, two
  papers, four widths). Bytes are sealed with the session key and stored on
  the relay; the daemon materializes each into the session cwd (images as
  `paste-*.ext`, other files under their own name) and cites the path in the
  prompt. The chat renders images inline (thumbhash placeholder until the
  bytes are opened) and other files as a name + size row above the bubble.
  Session files up to 400KB travel inline over the tunnel, larger via
  encrypted blobs both directions (readFile spills to blob). The 10MB per-file
  cap is enforced on the bytes actually read (web paste/drop included).
- **Full chat on the relay path**: assistant text, tool-call cards (start →
  running → completed), thinking/turn lifecycle and per-turn usage arrive as
  sealed adapter records from the daemon for claude, codex, opencode and pi;
  a prompt typed straight into the terminal pane shows up as a user bubble too.
- **Agents talk to agents (CLI)**: `joy ls` (agent, state, title), `joy check`
  (exit code = idle / busy / needs input), `joy send` queues behind a running
  turn and returns the turn id, `joy wait --turn` blocks on it, `joy ask`
  returns a typed outcome, `joy events --follow` streams the session's
  records, plus `abort`, `approvals`/`approve`/`deny`, `queue`, `mode`, `pane`,
  `about`. A message sent from inside a joy session is wrapped by the daemon in
  `<joy-message from="joy:<id>" reply-to="joy:<id>">` and shown in the chat as
  coming from that session (peer bubble); no `reply-to` means no answer expected.
- **Machine environment**: the machine page lists the sealed provider keys
  (`~/.joy/env.sealed`) and can add/remove them over the tunnel; every new
  session on that machine inherits them. `joy env ls|set|unset` from a shell.
- **Sends never vanish**: v2 has no optimistic row and no outbox — the user
  bubble is the relay's `turn.queued` event. A send the relay did not accept
  (offline, unbound session, refused upload) puts the text and pictures back
  in the composer with a notice; the draft-release retry reuses its localId
  as the relay `clientIntentId`, so a lost ack replays instead of duplicating.

## Chat rendering

- Markdown + tool cards; tool cards collapse individually (chevron) and
  globally (header top-left collapse-all button, `useToolsCollapsed`).
- Claude tool cards carry the tool's OUTPUT and failure state: the daemon
  forwards `tool_result` content on `tool-call-end` (`result`, `isError`),
  clamped to `TOOL_RESULT_MAX_CHARS` (48k, head + tail). Before 2026-09-03 the
  record was the call id alone — no output, and a failed Bash call rendered
  like a successful one.
- Code diffs render with a `Diff +N −M` toggle row (Edit/Write/MultiEdit).
- Background task counters (`joy__tasks`/`joy__agents`) age out a launch with no
  completion after `BG_LAUNCH_TTL_MS` (6h) — a lost `<task-notification>` used
  to pin the count forever AND suppress the session's turn-done push.
- One "done" push per turn id (`#notifiedTurns`); a re-read transcript entry
  used to fire the notification again.
- A CLI slash command (`/effort`, `/model`, …) takes no thinking lease
  (`takesThinkingLease`) and a visible dialog clears it outright — both kept
  `busy()` true for a prompt that never generates, holding the relay turn open
  and queueing everything behind it.
- File ops from the app are jailed to the session cwd (`validatePath`,
  realpath-resolved) plus explicit extra roots. READ-side ops — view/download
  (`readFile`), `listDirectory`, `getDirectoryTree`, `ripgrep` — also get
  `TEMP_ROOTS` (`/tmp` + `os.tmpdir()`, via `readRoots()`), so `<joy-file>`
  links to agent output in /tmp open. Write and delete stay cwd-only.
- Compaction summaries arrive as a collapsed "Compaction summary" card
  (previously dropped entirely). The daemon flags the mirrored transcript entry
  with `isCompactSummary`; without the flag it renders as a plain user bubble.
- The `compact_boundary` record becomes a `<joy-compacted>` agent marker the app
  draws as a centred divider — "Context compacted · 3m 3s · 385k → 17k".
- `<joy-options>` blocks become tap-to-answer pickers; `<joy-img>`/`<joy-file>`
  render inline; `<joy-title>` retitles (user `/title` locks); `<joy-notify>`
  becomes a push.
- **Optimistic sends.** `sync.sendMessage` inserts the user row immediately
  (`meta.deliveryStage: 'local'`, 70% opacity); the POST ack advances it to
  `relay` (80%) and binds the relay `turnId`; `turn.receipted` → `daemon`
  (90%); `turn.started` → `agent` (100%). The relay's own `turn.queued` row
  reconciles into the optimistic one by `origin.clientIntentId` = localId
  (reads.ts) — no duplicate bubble; it also supplies attachment citations.
  Stages are monotonic (`advanceDeliveryStage`); rows with no stage (history,
  other devices) render at 100%. A failed send is forgotten
  (`dismissLocalMessage`) and its text goes back to the composer.
- Above the composer, `PendingQueueStrip` (busy-held) and `DraftQueueStrip`
  (deliberate drafts) both render through ONE `QueueStack`: same header
  (title · count, collapsible), same inline-editable rows, capped at 3 rows
  then scrolls with "+N more" in the header. Drafts get ↑ send-now; a
  pending item whose release keeps failing gets ↻ + the error line.
  `JoyQueueStrip` (the daemon's own queue) is separate and unchanged.
- **Copy · Reuse** live in the text-selection screen (`/text-selection`,
  opened by long-press with `markdownCopyV2` on): Copy puts the ORIGINAL
  markdown on the clipboard; Reuse inserts it into the session's composer via
  `composerBridge` (appends below an existing draft, focuses) and returns to
  the chat. MarkdownView passes `sessionId` on the route. No per-message row.
  On web/desktop the same view opens on **right-click** of a message
  (`onContextMenu` in MarkdownView) — unless text is selected, in which case
  the browser's own menu is left alone.
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
- Session pushes (done/permission/question, `<joy-notify>`) deep-link by the
  RELAY session id, resolved through `v2SessionIdFor` — the app keys sessions
  by that id, so stamping the daemon's local id sent every tap to "Session has
  been deleted". An unbound session sends no link rather than a broken one.
- Session info → **Reload Chat** drops one session's local messages, reducer
  state and cursors and refetches (`sync.resetSessionChatState`); use it when
  history renders empty.
- The connection indicator reflects the RELAY POLL (`noteRelayReadOk` off the
  `fetchSessions` request), not the SSE doorbell — SSE needs a streaming fetch
  body React Native does not have, so on phones it never opens and the dot read
  "connecting" forever. SSE remains a pure latency win on web/desktop.

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

- One backup code pairs everything: app relay picker (Joy Relay + custom
  URL), `joy auth <relay...>` CLI self-pairing, per-relay MMKV scoping so
  accounts never bleed. The relay is the account authority (ed25519 login,
  EdDSA bearer tokens, terminal + account pairing flows).
- Relay perimeter password: settable per relay from Settings → Account (lock
  on each relay row) as well as Server Configuration. Stored per relay and
  sent as `X-Joy-Relay-Key`; a logged-in client also derives one from the
  account secret, so the manual value is an override for relays gated on
  something else. Setting it per relay matters because a gated relay refuses
  the connection — the key must be in place BEFORE switching to it.
- Identicons drawn from the joy logotype palette (circles / squares).
- Deploys: app via EAS OTA (desktop + mobile ALWAYS together); daemon via git
  release branch (`git push main:release` + `joy update` on each box).

## Files & git

Session Files view: git **Changes** (staged/unstaged/untracked groups, line
counts) and searchable **All Files** tree; file page renders source/diff/
rendered modes (Markdown, HTML, CSV/TSV, images), zoom/wrap, download, delete
(confirmed, irreversible); desktop adds a CodeMirror editor with hash-guarded
saves and conflict diff. Daemon FS
ops are jailed to the session cwd (+ read-only `~/.joy/sessions/<id>` media).

## Account & extras

- Account: backup-key reveal/restore, QR device-link approval, terminal-auth
  deep links (`joy://`), push-token administration.
- joy CLI: `joy` daemon control (`update`, `auth <relay...>`, `new --agent`,
  install/uninstall services), release-branch installs.
- Machine cleanup page: close detached panes, purge per-folder or per-machine
  records, delete machines.
- Dev tools: always-on developer pages, OTA identity + manual update check,
  in-app changelog (What's New), 10-tap dev mode.

## Voice (bring-your-own ElevenLabs agent)

- Settings → Voice holds a list of agents: name + agent id (public agent), or
  name + agent id + API key (private agent, authentication on). One is "in
  use". The key lives in synced settings (end-to-end encrypted) and is used
  only on the device to mint single-use WebRTC conversation tokens; no server
  is involved (`sources/realtime/elevenLabs.ts`).
- The composer mic arms voice for the open session and connects. States
  (`sources/realtime/RealtimeSession.ts`): ARMED (no connection, nothing
  billed) ↔ LIVE (conversation open). Idle hang-up after
  `voiceIdleTimeoutSec` of silence; session events (turn ended, held
  approval, `<joy-options>` question) wake an armed voice when
  `voiceWakeOnEvents` is on; a local sound-level detector
  (`realtime/soundWake.ts`, expo-audio metering natively / AnalyserNode on
  web, foreground only) reconnects on speech-like sound when
  `voiceWakeOnSound` is on. The spoken transcript survives hang-ups and is
  replayed on reconnect (continuation prompt); × on the voice bar disarms.
- Context feed (`realtime/hooks/voiceHooks.ts`): focus changes and new
  messages are silent contextual updates; turn end, approvals and questions
  are prompts the agent speaks. Client tools the agent must declare:
  `sendMessageToSession(sessionId, message)` and
  `processPermissionRequest(requestId, decision)`. The system prompt and
  first message are overridden on every connect (dashboard overrides must be
  enabled).
- Native modules: `@elevenlabs/react-native` over LiveKit/WebRTC (pinned to
  the versions in the July 3 native build; `@elevenlabs/react` on web).
  `patches/fix-livekit-room-reuse.cjs` forces the `/rtc` v0 path.

## Cross-cutting invariants

- Three packages, no upstream: joy-app, joy-daemon, joy-relay. There is no
  proxy and no second server — an endpoint the relay doesn't implement
  doesn't exist.
- Everything user-visible is E2E-encrypted through the relay.
- tsx runs untyped — `pnpm typecheck && pnpm test` before shipping daemon
  changes; e2e suite (`.claude/skills/e2e-tests`) covers the tmux
  control-mode path unit tests can't.
