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
  be restarted in place; kill one / kill all. A recovered card carries its
  agent flavor like a created one (#562). Every per-session tmux server is
  stamped (`set-environment -g JOY_OWNER_STATE_DIR`) with the owning daemon's
  state dir, and the boot-time orphan sweep (`domain/orphanSweep.ts`) retires
  only recordless, client-less servers stamped as OURS — another daemon
  universe on the box (another `JOY_HOME_DIR`, a per-relay daemon) shares
  the socket dir and label scheme and used to lose its live sessions to our
  boot (#55); unstamped (pre-stamp) servers are left alone. Working
  directories are canonicalised once (`paths.canonicalCwd`: `~`, `.`/`..`,
  symlinks) before launch, record and transcript path (#549 #564).
- **Four flavors, one interface** (`AgentSession`): claude (tmux pane +
  transcript tail), codex (app-server JSON-RPC + attach TUI), opencode
  (serve API), pi (bare `--mode rpc` stdio). Flavor shows in the session list
  and per-agent grouping in Settings → Sessions.

## Messaging path

- **Durable dispatch queue** per session, for every harness (claude, codex,
  opencode, pi, agy): the daemon's acceptance ledger (`domain/ledger.ts`,
  SQLite) holds the queue, the dispatch attempts, the delivery receipts and
  the outbound records — a send is acknowledged only once its row committed,
  the queue survives restarts, a redelivered relay seq dedupes against the
  pending row or the retained receipt, and a crash between a submit and its
  echo is an explicit unknown reconciled before any resend. One **session
  coordinator** (`domain/coordinator.ts`) runs the queue for every harness:
  the harness's own echo (codex clientId, opencode admission, pi response,
  agy stdin) is when a message counts as running, the harness's turn end is
  its outcome (a failed turn stays failed; an idle runtime with no turn end
  is `interrupted`, never "done"), a cancel is durable and retried until the
  harness confirms or is shown as unresolved, and a restart mid-turn ends
  that message `interrupted` while the rest of the queue carries over. All
  five harnesses are drivers of it (claude's driver is the session's pane
  gate + hook-owned turn edges: a message is `queued` until the box is
  verifiably idle and empty, typed with its Enter pending, and running once
  Claude's own hook or transcript echo proves it landed; a timeout pauses the
  queue with the message still queued, never silently re-typed). Claude
  adds verified typing into the pane. Queued rows render app-side in a
  drafts-style collapsible strip (`QUEUED · N`) with per-item
  edit/cancel/**steer** (arrow = cancel + `/steer` immediate send).
- **Steer**: `/steer` (and `/btw`) is a command of origin `steer` the
  coordinator dispatches ahead of the queue through the harness's steer op —
  claude types it into the pane now (mid-turn or idle), one pane operation at
  a time; opencode/pi route through their native steer semantics.
- **Codex output & recovery** (`codex/codexSession.ts`): a prompt typed in the
  attached TUI is mirrored into the card once, BEFORE its turn bracket — the
  turn-start record is held until the turn's first item, so the app groups it
  like a joy-sent prompt (#131). A restart or rejoin replays thread history
  through the same normalizer under deterministic ids; a live item that
  arrived while the read was pending binds to the replayed identity instead
  of a second one (#519); the delivered-turn checkpoint never passes a turn
  whose history came back partial, so the next recovery still replays it
  (#518); a rejoined in-progress turn is the active one — busy, thinking,
  Stop interrupts it by id — whether or not its items came back full
  (#513).
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
- **A full session says so**: the relay caps a session at 50,000 events. Past
  that its output can no longer be recorded, so the daemon drops it (the turn
  still terminalizes). The loss is not silent (#130): the card carries
  `joy__eventBudget` {since, dropped} — a banner like the retry/compacting
  ones, counting what was lost — and the first refusal also fires one push
  ("This session is full"). Both name the only recovery: continue in a new
  session; retrying never clears the budget.
- **Agents talk to agents (CLI)**: `joy ls` (agent, state, title), `joy check`
  (exit code = idle / busy / needs input), `joy send` queues behind a running
  turn and returns the turn id, `joy wait --turn` blocks on it, `joy ask`
  returns a typed outcome, `joy events --follow` streams the session's
  records, plus `abort`, `approvals`/`approve`/`deny`, `queue`, `mode`, `pane`,
  `about`. Outcomes of `ask`/`wait`/`run`: `answered` 0 · `needs_input` 6 ·
  `timeout` 4 · `gone` 1 (the session ended or no longer exists — a 404 from
  `/check` is never "answered", #496) · `error` 1 with a `reason` (`/check`
  failed or returned an unknown state; or the record stream broke and its
  tail could not be recovered, so the reply would be incomplete, #497). Every
  request inside the wait is bounded by the remaining `--timeout`, so a
  daemon that accepts `/check` and never answers still yields `timeout` (#501).
  A queued `ask` returns only ITS turn's text: the boundary is the daemon's
  mirrored user row carrying the prompt (the dispatch moment as fallback), so
  the tail of the turn it queued behind is not part of the reply (#498).
  `joy new -m` fails with the send's exit code when the first message is not
  accepted (the id is still printed, retry guidance on stderr, #494). A message sent from inside a joy session is wrapped by the daemon in
  `<joy-message from="joy:<id>" reply-to="joy:<id>">` and shown in the chat as
  coming from that session (peer bubble); no `reply-to` means no answer expected
  — `joy send --no-reply` and `joy run` send `replyTo: null`, which the daemon
  honours as exactly that (it used to fall back to the sender, #112).
- **Machine environment**: the machine page lists the sealed provider keys
  (`~/.joy/env.sealed`) and can add/remove them over the tunnel; every new
  session on that machine inherits them. `joy env ls|set|unset` from a shell.
  Writes from several daemons serialize on an OS-backed lock (`env.lock.db`)
  that dies with its holder, so a slow writer is never robbed mid-write.
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
- Daemon-created sessions (joy new, fork, teleport, handoff targets,
  restart) are ANNOUNCED to the relay by the lane every renew tick
  (`announceLocalSession`: `POST /sessions {mode:"announce_existing"}` — the
  row is born bound to this daemon with a fresh sealed key; idempotent by
  `creationIntentId: announce:<id>`). Before this they had no card at all.
  `create({forceNew})` skips the detached-session auto-revive (fork/handoff/
  teleport set it). Agy record ids carry a per-boot nonce.
- Peer-message provenance: joy-send wraps `<joy-message from="joy:<id>"
  from-label="<harness> (<model>) · <title>" reply-to=…>`; relay.ts lifts
  both into `meta.from` / `meta.fromLabel`. The app resolves `joy:<id>` to a
  card it holds (harness · title (id), tappable → that session), else shows
  the stamped label, else the id. agy and pi child processes get
  `JOY_SESSION_ID` + `JOY_DAEMON_FILE` like the claude launch line, so their
  `joy send` is attributed (it used to read "cli"). A daemon-owned slash
  command keeps its leading `/command` outside the wrapper (only a
  `/steer`/`/btw` body is stamped), so `/title`, `/steer`, `/login-code`
  sent with provenance are still intercepted (#552).
- **Handoff** (`domain/handoff.ts`): `joy-handoff` {agent, model?} on a session
  enqueues a note-request prompt (fixed template, ≤~2.5k words, written to
  `~/.joy/sessions/<id>/handoff-<ts>.md`); the daemon polls for the file
  (exists, size stable, session idle — harness-agnostic), appends a Reference
  block (session/model/machine, cwd, transcript path per harness, assets dir,
  prior notes), creates the target in the same cwd and enqueues a pickup
  prompt with the note. `joy-handback` on the target does the same and
  delivers the note INTO the source as a prompt (the source was only idle).
  Progress rides `joy__handoff` {state, peer, peerLabel, note} on both cards;
  the app's `HandoffBar` renders it (open peer, Hand back). Same machine only.
  One in-flight job per session: a second handoff/handback while the note is
  being written (card `writing`, or a persisted job) is refused (#53).
- Session page **Restart / Fork / Teleport**. Restart ends the process with
  `end("restart")` — no archive, record kept — and recreates under the SAME
  local id, so the v2 binding (and the card) survive, with the CURRENT
  model/effort/permission mode and the user's locked `/title` (persisted as
  `userTitle` beside the lock, #474 #51). Fork and teleport-export continue
  under the source's live permission mode, else its persisted one, else
  `default` — never bypass when the pane read fails (#50). Fork = `joy-fork-session`,
  one contract for every harness ({ok, localSessionId} | {ok:false, error}):
  claude `--resume <id> --fork-session`; agy/pi/codex copy their single
  history file under a fresh id with the embedded id rewritten
  (`domain/forkHarness`: agy conversations/<id>.db cascade_id, pi
  <ts>_<id>.jsonl header, codex rollout-<ts>-<id>.jsonl session_meta);
  opencode refused. The app follows the new card by `joy__sessionId`
  (`waitForLocalSession`). Teleport = `joy-teleport-export`
  on the source (transcript tail from the last `compact_boundary`, else a
  turn-snapped tail ≤6MB; base64) → `joy-teleport-import` on the target
  (canonicalises the cwd, writes `~/.claude/projects/<cwd>/<id>.jsonl`,
  refuses to clobber a conversation a session owns IN THAT FOLDER — a
  same-box import into another folder is the supported fork (#550) — then
  `create({resume_id, forkSession})`). Files are never copied. Claude only
  for now.
- **Antigravity (`agy`) sessions** — `packages/joy-daemon/src/agy/`. Headless:
  one `agy --print --output-format stream-json --dangerously-skip-permissions
  --add-dir <cwd> [--conversation <id>] [--model <display name>]` process per
  turn; `init` yields the conversation id (persisted as
  `agySettings.conversationId`), `step_update` mirrors text (per-step deltas,
  emitted at DONE) and tool calls (start with parameters, end with output),
  `result` closes the turn with usage. No resident process, so recovery is
  just re-creating the session from its record. Daemon-owned FIFO queue with
  real edit/cancel/reorder. `--add-dir` is required or writes land in agy's
  scratch dir. Models: `joy-agy-models` (`agy models` display names; the name
  IS the `--model` id). Config: `~/.gemini/antigravity-cli/settings.json`.
- File ops from the app are jailed to the session cwd (`validatePath`,
  realpath-resolved) plus explicit extra roots. READ-side ops — view/download
  (`readFile`), `listDirectory`, `getDirectoryTree`, `ripgrep` — also get
  `TEMP_ROOTS` (`/tmp` + `os.tmpdir()`, via `readRoots()`), so `<joy-file>`
  links to agent output in /tmp open. Write and delete stay cwd-only. Writes
  are atomic and hash-checked under a per-path lock (#539, #63); `ripgrep` /
  `difftastic` argv is allow-listed so no option can smuggle a path out of the
  jail (#537).
- Compaction summaries arrive as a collapsed "Compaction summary" card
  (previously dropped entirely). The daemon flags the mirrored transcript entry
  with `isCompactSummary`; without the flag it renders as a plain user bubble.
- The `compact_boundary` record becomes a `<joy-compacted>` agent marker the app
  draws as a centred divider — "Context compacted · 3m 3s · 385k → 17k".
- `<joy-options>` blocks become tap-to-answer pickers; `<joy-img>`/`<joy-file>`
  render inline; `<joy-title>` retitles (user `/title` locks, and the locked
  title survives restarts, #474); `<joy-notify>` becomes a push.
- **Optimistic sends.** `sync.sendMessage` inserts the user row immediately
  (`meta.deliveryStage: 'local'`, 70% opacity); the POST ack advances it to
  `relay` (80%) and binds the relay `turnId`; `turn.receipted` → `daemon`
  (90%); `turn.started` → `agent` (100%). The relay's own `turn.queued` row
  reconciles into the optimistic one by `origin.clientIntentId` = localId
  (reads.ts) — no duplicate bubble; it also supplies attachment citations.
  Stages are monotonic (`advanceDeliveryStage`); rows with no stage (history,
  other devices) render at 100%. A failed send is forgotten
  (`dismissLocalMessage`) and its text goes back to the composer.
- Above the composer: **Queue** (`WaitingStack`) and **Drafts**
  (`DraftQueueStrip`), both rendered by ONE `QueueStack` — same header
  (title · count, collapsible, +N more), same inline-editable rows, × remove,
  capped at 3 rows then scrolls, header outside the scroll region so collapse
  is always reachable, no icons. Queue MERGES the app-held busy items and
  the daemon's dispatch queue (`joy__queue`: visible + hidden items, edit via
  PATCH on commit, cancel, ⇡ steer) plus the paused-queue banner; Drafts get
  ↑ send-now. There is no separate "queued" strip any more.
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
- Session info → Live → **CPU · Memory**: the `get` op stamps `process`
  (`cpuPercent` summed over the agent's process tree, `rssBytes`,
  `processCount`) from `domain/procStats` — Linux samples /proc twice, macOS
  reads `ps`. Only on the single-session read.
- **Limits** (Settings): server-truth account quota — claude 5h/weekly
  Model-scoped weekly windows (Fable, …) come from the usage API's structured
  `limits` array via `claudeLimitRows`; codenamed experiment buckets are not
  rendered.
  utilization + reset times via the machine's own Claude Code OAuth token;
  codex windows from rollout `rate_limits`. No credential entry.

## Agent configuration

- **Agent Defaults**: per-agent model/effort/permission defaults + overrides.
- **Agent Config** (Settings): edit each agent's real config file on a machine
  — schema-walked rows (claude/opencode publish JSON Schemas) or raw mode with
  full-file editing and JSON-path assignment lines
  (`examples[0].title = "hi"`); daemon writes atomically and rotates the
  `.joy-bak` backup only as part of a successful replacement, so a retried
  failed save can never destroy the last good copy (#527).

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

Session Files view: git **Changes** (staged/unstaged/untracked/conflicted
groups, exact per-file and total line counts) and searchable **All Files**
tree; file page renders source/diff/rendered modes (Markdown, HTML, CSV/TSV,
images), zoom/wrap, download, delete (confirmed, irreversible); desktop adds a
CodeMirror editor with hash-guarded saves and conflict diff. Daemon FS ops are
jailed to the session cwd (+ read-only `~/.joy/sessions/<id>` media).

Git facts come from ONE structured daemon read (`git/status?v=2`, see
docs/API.md "Structured git status"): the app has no git text parser. A file
is opened by its exact identity and shown by separate display text, so names
with quotes, pipes, trailing spaces, newlines or undecodable bytes list and
open correctly; renames show destination + source; AA/DD conflicts are
conflicts; a rebase or detached checkout is reported as such (linked
worktrees included). Line counts are exact or absent (`'unavailable'` for
binary/untracked/unread — never a stand-in 0), so the +N/−N badges on
session rows, the Files header and each row show only real numbers. Refreshes
retry through the sync backoff on transport failure and a stopped project
sync can no longer overwrite its replacement's status. An older daemon (no
`v=2`) still lists files, without line counts.

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
- Everything user-visible is E2E-encrypted through the relay. A sealed session
  never accepts a plaintext prompt (#579) and never replays spooled output in
  the clear (#582); tunnel responses are bound to their request's stream id
  so the relay cannot replay one request's sealed answer to another (#418 —
  an app with this check needs daemons that emit the binding).
- Tunnel exchanges are bounded end to end. Request side: the relay admits on
  the headers before buffering a byte (`503 daemon_offline`; `413` for a
  declared size over 32 MiB; `503 daemon_busy` past 16 requests / 64 MiB
  parked per daemon; `503 relay_busy` past the relay-wide 256 requests /
  256 MiB), reserving the declared size while the upload is in flight. Both
  clients retry the two busy codes per `retry-after` (3 attempts, never
  `daemon_offline`); the app reads "the machine/relay is busy". Response
  side: at most 8 MiB buffered per client, then the daemon's frame post waits
  for the socket to drain; a client that has not drained in 10 s is dropped
  (daemon hears `429 client_slow`, a dead socket `410 client_gone`, a vanished
  request `404 request_gone` — all terminal for the executor, which releases
  its local stream). A cut stream after a verified head reads as
  "connection too slow" (`connection_slow`), not tamper; a GET is re-asked once.
- Local acceptance is durable: `send`, `queueAdd` and handoff notes are
  acknowledged only after the queue spool is persisted, else `not_durable`
  (#551, #542); queue and window-record writes are atomic (#555, #567).
- Claude session state: hooks and the transcript are the authority, the pane
  parser is a tie-breaker. The daemon launches `claude --settings` with a
  managed hook set (`claude/hooks.ts`, HOOK_VERSION 6: SessionStart/End,
  UserPromptSubmit, Stop, StopFailure, PostToolUse, PermissionRequest,
  SubagentStop, Notification, PreCompact, each forwarding `permission_mode`,
  `notification_type`, `end_reason` (Claude's `reason`), `error_type`,
  `tool_name`, `prompt_id`, the subagent identity `agent_id`/`agent_type`,
  and `launch_id` — the `JOY_LAUNCH_ID` the daemon exports per launch and
  persists as the window record's `hookLaunchId`). Ingress is FENCED before
  anything changes: an event that does not echo the session's launch id, or
  names another conversation id, is a retired predecessor's (a restart
  replacement inherits the route id, a `--resume` replacement even the
  conversation id) and flips no latch, persists no mode, arms or withdraws no
  end, closes no turn and confirms no dispatch; a session recorded without a
  launch id accepts any. A subagent's events (`agent_id`) never touch the
  main agent's turn, wait or mode — its `PermissionRequest` opens a wait
  tagged with its actor that only its own `PostToolUse` answers, and
  `SubagentStop` persists no mode. Hooks are best-effort, so each session
  carries a `hooksLive` latch that flips on the first hook event from its
  own claude process and gates every authority swap; until it flips (adopted
  sessions, old settings snapshots, daemon downtime) the pane rules apply
  unchanged. Once live: a plain prompt is "delivered" only when
  `UserPromptSubmit` (or the transcript's user echo) text-matches it — a
  foreign turn start never confirms it (#32); without hooks (and for a
  slash/`!` command, which fires no `UserPromptSubmit`) a turn start confirms
  only against a FRESH box read that positively shows the text gone, never
  the cached sweep frame; `Stop`/`StopFailure`/idle close the RUNTIME turn
  (`Session.promptReadiness()`, the one decision every dispatch/clear gate
  and `busy()` consume) even while the transcript's tail is still open and
  the pane still paints "esc to interrupt" — the box/dialog checks on a
  fresh capture remain; the pane's
  "esc to interrupt" read never sets thinking and clears it only after six
  idle polls past the lease (#479) — `UserPromptSubmit`/`PostToolUse` mark
  generating, `Stop`/`StopFailure`/`Notification` mark idle; `permission_mode`
  from a main-agent hook is persisted (the cache advances only on a
  successful record write, so a lost write is retried by the next hook) and
  verifies `setPermissionMode`, which reads FRESH footers on both sides of
  the Shift+Tab cycle and fails on a failed key (the live footer under a
  located box is still read, since Shift+Tab fires no hook; the hook value
  fills in when no box is on screen, and outranks a cached frame captured
  before the hook) (#480); a hook-reported permission wait is cleared by the
  pane only once the dialog has been continuously ABSENT for 10s, never by
  one contradictory capture; `SessionEnd` (exit-class reasons;
  `clear`/`resume` rotate the conversation) ends the session as
  `process_exited` once, after a 1.5s grace, no live claude is found — an
  unresolved/shell/dead pid is re-resolved from the pane shell's live child
  first, so a replacement under the shell is never torn down by its
  predecessor's late hook — the pid probe and the pane's frozen frame no
  longer decide alone (#30);
  `StopFailure(authentication_failed)` opens an auth episode and
  `/login-code` types only inside one (or under a surfaced login bar) AND
  into the real form (#482); `PermissionRequest`/`Notification` set the
  `needs_input` that `joy check`/`wait`/`ask` report. The pane stays the only
  source for what hooks cannot see: draft text, dialogs, the login form, the
  shells footer, API-retry spinners — and for the interrupt edge `Stop` does
  not report (the transcript's interrupt marker covers it first). Spike:
  `docs/review-campaign-2026-09-claude-runtime-spike.md`.
- Local acceptance is durable and transactional: `send`, `queueAdd`, relay
  prompts and handoff notes are acknowledged only after the ledger commit
  (`domain/ledger.ts`: WAL + `synchronous=FULL`, one transaction per write,
  no boolean "saved"), else `not_durable`; a session whose generation has
  closed answers `session_ended` (#551, #542, #553). Command id, payload
  version, session generation, runtime attempt id and outbox sequence are
  distinct identities; a confirmed delivery stays in the receipt table after
  its pending row is gone (#516); a write from a superseded generation is
  refused (#481); a checkpoint commits only once the outbound rows it covers
  are acked (#67); terminals are posted after their session's outputs by
  one sender per session (#74). Execution policy lives in one place: a
  command's state is the ledger row the coordinator moves, a submit is
  applied only while its op token and generation still own the row (#34
  #481), a turn start never confirms a submission (#32 #40), the terminal
  state is the attempt's own outcome (#463 #584), cancel is a durable flag
  consulted at every operation boundary and retried until confirmed or
  surfaced as unresolved (#35 #66 #77 #79), and the queue of a restarted
  session is the replacement's (#36 #49). Window records (identity/config only) and
  user files still use atomic replacement (#567). The one-time legacy import
  (`domain/ledgerImport.ts`) commits a per-source marker (`import_sources`:
  file + content hash) inside each file's transaction, so a repeat import is
  a no-op even when the file could not be moved aside; synthetic rows carry
  ids derived from the source, and an imported checkpoint never rewinds the
  ledger's cursor. An unreadable or malformed source is a FAILED import:
  left in place, retried next boot, and its session is quarantined
  (`registry.quarantine`: not recovered, `create`/`restart({id})` refused)
  until it imports — and "malformed" is judged per row/field, not per
  envelope (review 7652e686): a queue or codex-inbound entry without a
  string id/text (or with a non-numeric seq) fails its whole file with
  nothing committed, and a window record whose execution field has the
  wrong shape (`transcriptCheckpoint.offset: "100"`) is neither imported
  nor stripped until repaired. Settlements obey the current-owner rule:
  `settleAttempt`/`confirmDelivery` change the command only when the claimed
  generation is the session's current one AND the attempt is the command's
  newest; anything else is recorded as a `stale_settlement` observation on
  its own attempt (late-echo ownership kept) and never fails the command or
  supersedes the newer attempt. `transition`/`setCheckpoint`/`acceptCommand`
  take the owner's generation (+ expected attempt) and refuse when stale
  (review 95c4781e). Command ids are global and owned: `acceptCommand`
  dedupes a caller-chosen id only for the session that owns it and throws
  `CommandIdConflictError` when another session presents it (the import
  fails that file), and the session queue facade (`domain/queueFacade.ts`
  — every `queueFor(session)` lookup / edit / cancel / reorder / waitFor)
  treats another session's command id as unknown (review 7652e686).
- tsx runs untyped — `pnpm typecheck && pnpm test` before shipping daemon
  changes; e2e suite (`.claude/skills/e2e-tests`) covers the tmux
  control-mode path unit tests can't.
