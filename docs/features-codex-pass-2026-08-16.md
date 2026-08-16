# Joy feature inventory (independent source pass)

## Scope and status vocabulary

This inventory was derived from `packages/joy-app`, `packages/joy-daemon`, and `packages/joy-relay`. It intentionally excludes every `happy-*` mirror package and was produced without reading the repository-root `FEATURES.md` or `API.md`.

The source contains three kinds of surface that are worth distinguishing:

- **Current Joy path:** linked from the normal Joy UI or used by `joy-app`/`joy-daemon` today.
- **Compatibility/latent path:** compiled route or UI retained for upstream Happy compatibility, but not the normal Joy navigation path.
- **Implemented, not integrated:** working protocol/server code for a later migration, with no caller in the examined app or daemon packages.

## Product shape and package interconnection

Joy is a multi-device remote interface for coding agents running on the user's machines.

```text
Joy app (iOS / Android / web / Tauri desktop)
  |  account/session APIs + Socket.IO + encrypted machine/session RPC
  v
selected relay URL
  |  current Joy relay: transparent HTTP/WebSocket proxy
  v
upstream account/session service
  ^
  |  machine heartbeat, encrypted transcript events, RPC handlers, push events
Joy daemon on each machine
  |-- Claude Code interactive TUI in tmux
  |-- Codex app-server + attached TUI
  |-- OpenCode HTTP server
  `-- Pi JSON-RPC process

Optional local path: Joy app -> configured localhost HTTP URL -> Joy daemon
Future/native path: clients -> joy-relay /joy/v1 durable lease/turn protocol
```

The app is the account, navigation, chat, and settings client. The daemon owns local processes, transcripts, tmux, filesystem access, agent normalization, and machine-side usage. The relay makes app and daemon reachable to each other; on the current path it forwards the upstream-compatible protocol, while its native `/joy/v1` implementation is a separate, currently unwired protocol nucleus.

Content such as profiles, session metadata/messages, settings, attachments, artifacts, and machine/session RPC payloads is encrypted/decrypted by the clients. The relay routes using account/session metadata and opaque payloads; push notification headlines are explicitly not treated as end-to-end-encrypted content.

## App: account, pairing, and relay selection

### First run and account recovery

- The signed-out landing page can create a new account from a newly generated 32-byte secret. On mobile, the alternative is **Link or Restore Account**; desktop/web leads with **Log in with Mobile App**.
- QR restore displays a device-link QR code, waits for approval in an already authenticated mobile app, receives the account credentials, and signs the new device in.
- Manual restore accepts the formatted backup/secret key, validates and normalizes it, authenticates it against the selected relay, and restores the account.
- The account page can reveal and copy the formatted backup key and can scan a QR code to link another device.
- Terminal/client authorization deep links have accept/reject screens showing the request public-key fingerprint and the end-to-end-encryption claim. Web uses a `#key=` link and removes the key from browser history before approval; native handles the `happy://terminal?...` form.

### Account and connected services

- Displays active status, anonymous ID, public/server ID, avatar, display name, bio, GitHub identity, and known connected services.
- GitHub and connected Claude, Gemini, or OpenAI/Codex services can be disconnected. The retained Claude-connect test route does not perform OAuth; it tells the user to run `happy connect claude` in a terminal.
- Logout removes the current login from the app.
- Push administration shows OS permission state, can request permission again or open system settings, can re-register this device, and lists every server-side Expo token with fingerprints/timestamps. Non-current or stale tokens can be deleted; the current token can be copied.

### Relay accounts

- Built-in choices are Happy Cloud and Joy Relay, plus a custom URL. A custom endpoint must respond with the expected Happy-server welcome text.
- Credentials are stored per relay. Switching reloads the app into that relay's paired account, or into its connect screen when no account is stored.
- A new relay can be entered with the current backup key, a pasted backup key, or left for later login. **Apply current key to all relays** creates/opens the same secret-derived account at every known relay.
- App caches are also relay-scoped so records from two relay accounts are not mixed.

## App: primary navigation and session list

- The authenticated app has **Sessions** and **Settings** roots. Phone uses the tab/header layout; tablet and desktop use a persistent session sidebar and content pane. The sidebar can be collapsed into zen mode and restored; browser Back/Forward navigate the content history.
- Every normal **New Session** affordance currently opens `/joy/new`. The upstream-compatible `/new` route remains compiled but is no longer the standard navigation target.
- Sessions are grouped by machine and project/folder, with machine online state and CPU/RAM summary, project branch/worktree, and aggregate added/removed git lines.
- Project groups have a quick `+` action that pre-fills the machine and path on the Joy new-session page.
- Rows show agent/flavor, title/path, draft state, and live states including thinking, unread, permission/question waiting, disconnected/detached, background agents/tasks, long-running processes, compacting, retrying, and queued work.
- Active and archived/inactive sessions can be shown or hidden. Native swipe archives; long-press or desktop context-click opens session actions.
- A chronological **Recent Sessions** page groups all sessions by today, yesterday, or days ago.
- Update/changelog banners appear above the session surface when appropriate. The **What's New** page renders bundled changelog entries and tracks the last viewed entry.
- An optional web command palette provides New Session, all sessions, Settings, Account, Connect Device, recent-session switching, Sign Out, and (in development) Developer Menu.

## App: creating sessions

### Current Joy creation page (`/joy/new`)

- Probes online machines for a responding Joy daemon and remembers the ten most recent machine/path pairs. Machine and path are searchable/selectable; a missing folder requires explicit creation approval.
- A full HTTPS, SSH, or `git@` URL in the path field means **clone or reuse `~/Workspace/<repo>` and start there**. Clone/spawn gets a longer timeout than ordinary local creation.
- Agent picker cycles through **Claude Code, Codex, OpenCode, and Pi**.
- An optional initial prompt is sent after the relay session exists.
- There is deliberately no worktree picker on this Joy-native page.
- Claude controls: model family, effort, permission mode (bypass/yolo is the initial UI default), fallback model, continue most recent conversation, resume a specified or discovered transcript, configurable replay MB (`0` means full), fork the resumed conversation into a new Claude session ID, and free-form extra CLI arguments.
- Codex controls: daemon-discovered app-server model catalog, model-specific reasoning effort, Codex-specific read-only/safe-yolo/yolo approval+sandbox mode, continue/resume a thread, and free-form `key=value` config overrides.
- OpenCode controls: daemon-curated model catalog, continue most recent or select a previous project session, and model selection. Permission and raw-extra-argument controls are hidden.
- Pi is the intentionally minimal option: path and prompt, with no permission/model/effort/resume controls.
- Creation calls `joy-create-session`; after machine creation, the daemon returns the upstream relay session ID, the app refreshes sessions, sends the initial prompt through normal synced messaging, and opens the chat.

### Compatibility creation page (`/new`)

- Retained upstream-style composer with machine/path search, recent paths, agent defaults, model, effort, permission, initial prompt, and **no/new/existing git worktree** selection.
- Its visible agent list is **Claude Code, Codex, OpenClaw, Gemini, and OpenCode**. Pi types/assets exist but Pi is not in the rendered picker.
- It calls the legacy `spawn-happy-session` machine RPC (plus legacy worktree operations), not any operation implemented by `joy-daemon`. It therefore depends on an upstream-compatible machine daemon outside the three-package Joy-native implementation examined here.

## App: chat and live session experience

### Conversation rendering

- Unified encrypted chat stream for user text, assistant text, local-command output, tool calls/results, system/state rows, permissions, and post-compaction summaries.
- Markdown supports headings/lists/tables, links, code highlighting, diff views, and Mermaid diagrams. Long-press can open a dedicated selectable-text page; whole content can also be copied.
- Tool calls can render inline or on their own detail page, can be grouped/collapsed, show running time and completion/error state, and use specialized views for shell commands, reads/writes/edits/multi-edits, Codex commands/patches/diffs, Gemini execute/edit, MCP calls, tasks/subagents, todos, questions/options, and plan completion. Unknown tools fall back to JSON input/output.
- The app understands agent-emitted structured UI:
  - `<options>` becomes tappable answer choices while still allowing typed answers.
  - `<joy-img>` fetches session-local image bytes and renders an inline, zoomable/shareable image.
  - `<joy-file>` becomes a tappable file chip with optional line/column navigation.
  - `<joy-title>` retitles the conversation unless the user locked a manual title.
  - `<joy-notify>` creates a custom push notification.
  - Claude-only `<joy-bg long-running>` classifies persistent background servers/watchers separately from finite tasks.
- Inline delivery indicators distinguish sending, waiting for connection, and not delivered. Offline sends stay in the normal durable outbox and retry on reconnect.
- In-session Cmd/Ctrl+F searches message text and steps between matching rows without losing the reader's viewport.

### Composer and controls

- Send and abort/stop controls, per-session agent/mode/model/effort controls, connection/status display, context-window usage, git status shortcut, file browser shortcut, and session/profile details.
- Images/files can be attached from platform pickers or clipboard. Images have previews/thumbhash placeholders; non-images use compact file chips.
- A full-screen drawing attachment pad provides black/red/blue/yellow/white ink, four pen widths, light/dark paper, undo, clear, and PNG export back into the composer.
- Voice starts a realtime voice assistant bound to the current session; a global/sidebar status bar shows the active voice conversation and provides stop/return controls.
- Web can use Enter-to-send or newline behavior according to settings; mobile web preserves newline behavior.
- `@` autocomplete fuzzy-searches the project's files/folders (daemon `ripgrep --files --follow`, cached for five minutes). `/` autocomplete combines built-ins and the daemon-discovered command/skill list.

### Queues and drafts

- Plain-text sends made while a fresh Joy session is provably busy enter an **app-side editable queue**. Each busy item can be edited/deleted and one item is automatically released after each completed turn. It has retry/backstop behavior so stale thinking state cannot hold text forever.
- The user can separately **Save Draft**. Manual drafts never auto-send and remain editable until explicitly sent.
- Attachments and commands known to execute immediately bypass the app-side hold. The immediate command set is `/model`, `/effort`, `/btw`, `/goal`, `/stop`, `/mcp`, `/skills`, `/hooks`, `/loops`, `/color`, `/doctor`, `/version`, `/focus`, `/brief`, `/daemon`, `/steer`, `/title`, and `/login-code`. Boundary commands such as `/compact` and `/clear` are held when the agent is busy.
- The daemon also exposes a verified durable queue for relay/HTTP/CLI injections. If it has visible items, the app shows a separate queue strip with edit, cancel, reorder, pause reason, and resume. This is distinct from the primary app-side queue.

### Live banners and intervention UI

- **Login bar:** detects Claude's browser OAuth URL, can open/copy it, accepts a pasted code, and submits it through `/login-code` only while the login box is still present.
- **Dialog bar:** mirrors detected CLI menus/questions and lets the user open the pane to answer them.
- **Codex approval bar:** allow or deny command execution and patch requests; the daemon times out unanswered requests.
- **Goal bar:** shows the live goal, lets the user edit it with `/goal ...`, or clear it.
- Disconnected/resume, resource warning, outdated CLI, retrying, compacting, background-task, and queue-paused state are surfaced without requiring the terminal.

### Mode/model changes

- Joy Claude permission-mode changes are executed in the TUI (Shift-Tab/key scripting), while model and effort changes send the CLI's `/model` and `/effort` commands.
- Joy Codex mode changes are stored for the next turn; model/effort use the app-server's model identity/turn configuration.
- OpenCode models can be changed through `joy-opencode-set-model`.
- Per-session overrides are kept in app state and cleared on abort; global per-agent defaults seed new sessions.

## App: files, diffs, pane, logs, and session management

### Files and git review

- Session **Files** has **Changes** and **All Files** modes. Changes are grouped by staged/unstaged/untracked/deleted state with status icons and line counts; All Files is a searchable, collapsible directory tree. A clean repo falls back to file search.
- The standard file page reads through the session RPC, detects binary content, renders raster images, syntax-highlights source, shows git diff/source/rendered modes where applicable, supports persisted font zoom and word wrap, copy, partial selection, line/column display, and download. Markdown, HTML, CSV/TSV, and images have rendered previews.
- Desktop/web can keep a Changes/All Files sidebar next to chat, expand inline diffs, and navigate selected files with back/forward history.
- The desktop/web file overlay includes a CodeMirror editor, preview/source toggle, download, and save. Saves use a content hash; a concurrent external edit opens a conflict diff with Reload or explicit Overwrite. It polls for external changes only while foregrounded.
- Daemon filesystem operations are jailed to the session cwd, with a second read-only allowance for that session's `~/.joy/sessions/<id>` media. Oversized relay reads use encrypted attachment blobs rather than overfilling a Socket.IO acknowledgement.

### Live tmux pane

- The Joy pane page polls ANSI-preserving `tmux capture-pane`, resizes the pane to the viewport, supports colored or literal/raw capture, and can send literal text or key-token scripts.
- Its key bar includes Enter, Esc, Ctrl-U, Ctrl-C, page up/down, Tab/Shift-Tab, Home/End, arrows, Backspace, and Ctrl-D. This is the escape hatch for trust prompts, CLI menus, and terminal-only state.
- Claude and Codex have real tmux panes. OpenCode and Pi adapters report that no pane is available in their current implementation.

### Details and quick actions

- Every session can open details, archive/kill, or permanently delete chat history. Developer mode adds copy-metadata and copy-metadata-plus-client-logs actions.
- Joy sessions can restart by killing the process/window and resuming into a fresh relay session. Joy Claude sessions can also fork the full conversation through `joy-create-session` with `resume_id + forkSession`.
- The compatibility experiment for non-Joy sessions can resume a disconnected Claude/Codex session on its original online machine, fork a full Claude JSONL, or duplicate/rewind from a chosen user message. These use legacy `resume-session`, `claude-fork-session`, `claude-list-rewind-points`, `claude-duplicate-session`, and `spawn-happy-session` RPCs, not Joy-daemon ops.
- Joy details show live model/effort, tmux window, PID, launch flags, host/path/timestamps, Joy/Claude/relay IDs, and a copyable resume command. Actions link to pane, per-session usage, machine, and project history; web can download the raw transcript JSONL (25 MB cap).

### Project/transcript history

- Machine Projects and per-session Projects derive project folders from synced sessions, then query the machine's Claude transcript directory.
- Logs are listed newest first with size/time. A selected log shows the last user/assistant turns without downloading the entire file; the user can copy its session ID or prefill `/joy/new` to resume it.
- A separate Joy Logs route supports choosing a machine/project and viewing the same transcript previews. Older entries are collapsed to keep the page compact.

### Machine pages and cleanup

- The machine list includes only responding Joy-daemon machines; the cleanup page includes all registered/offline machines.
- A machine page shows daemon version, PID, uptime, OS/architecture, Claude CLI availability/version, active-session count, host/home/ID, and supports a user display-name override.
- Live system telemetry includes CPU/model/core count/load, reclaimable-aware RAM usage, and disk free/used; RAM or disk at 90% is highlighted.
- Shows the daemon's discovered slash-command count/list and has an explicit re-scan action.
- Links to project logs, Joy session manager, new session, and machine usage.
- Daemon actions: restart daemon while tmux sessions survive, kill all sessions, or kill and permanently purge all Joy session records.
- Cleanup can close detached panes while keeping history, delete all session records for one remembered folder, purge a machine's Joy sessions, or delete the registered machine. A still-running deleted machine can reappear on its next heartbeat.

## App: usage, limits, voice, artifacts, and diagnostics

### Usage and limits

- Usage is computed on each machine from Claude JSONL, can be scoped to one machine or aggregated across responding machines, and supports today, week, 30 days, 90 days, six months, and all-time/per-session queries.
- Overview shows dollars, calls/turns, sessions, input/output/cache-read/cache-write tokens, and cache hit rate.
- Breakdowns include machine, project, model, activity category, core tools, MCP servers, skills/agents, subagents, and top sessions. Activity is daily, weekly, or monthly for the selected range; 30 days also has a calendar heatmap.
- Per-session usage rolls subagent spend into the parent and provides a model split and start/cost/token/turn summary.
- Limits queries live Claude OAuth windows (5-hour, weekly, weekly Opus, weekly Sonnet when present) and Codex primary/secondary rollout windows, with utilization and reset countdowns. Either agent half can fail without blanking the other.

### Voice

- Voice settings show seconds and conversation-count allowance, preferred spoken language (including automatic detection), and support/paywall behavior.
- A custom ElevenLabs agent ID can be supplied. **Direct Connection** bypasses the Joy token/gate for that custom agent.
- Developer mode can override the voice upsell variant, inspect the effective experiment/gating source, and reset local onboarding/paywall/message counters.

### Artifacts and auxiliary routes

- Artifact routes implement encrypted synced Markdown artifacts: list/count, create title+body, rendered view, edit, and confirmed delete. Draft artifacts are excluded from the main artifact list.
- These artifact routes are registered but no current Sessions/Settings navigation item links to `/artifacts`; they are a latent/deep-link surface in this build.
- Message-detail routes open the full specialized tool view or raw user/assistant text for a single message.
- The dedicated text-selection route provides native drag-handle selection and Copy All for Markdown/file text that is awkward to select inside nested chat views.

### Developer and update surface

- Developer Tools is always linked in the Joy settings build. It shows app/build/SDK/platform/anonymous IDs, socket status, in-app logs, and per-session raw/computed state.
- Component/diagnostic pages cover device/safe-area information, Expo constants, typography, colors, list/input/modal components, message/tool demos, inverted lists, shimmer, multi-line input, QR generation, session composer, Unistyles, in-app unit tests, and purchases/entitlements.
- Debug Mode, production console output, and verbose network logging are toggleable. A remote plaintext log-server URL is configurable from developer code and is explicitly unsafe for secrets.
- Test crash is functional. The current **Clear Cache** and **Reset App State** developer buttons only log/show success and do not actually erase storage.
- Settings can display/copy OTA update identity, manually check/download/reload an Expo update, show app/runtime/build metadata, open the `fny/joy` GitHub repository, and show the bundled changelog. Ten rapid version taps toggle developer mode.

## App settings inventory

### Appearance (device-local where noted)

- Theme: adaptive/system, light, or dark (local).
- UI language: automatic/device or Catalan, English, Spanish, Italian, Japanese, Polish, Portuguese, Russian, Simplified Chinese, or Traditional Chinese.
- Chat font scale from 80% to 140%, with reset (local).
- Inline vs separate tool-call views; expand todo lists by default.
- Line numbers in diffs and independently in other tool views; wrap long diff lines.
- Unified vs split diff layout on web.
- Always show context size and show agent-flavor icons.
- Light/dark palette live preview; light presets or editable custom shell colors; copy a preset to Custom; independent dark presets.
- Terminal/ANSI theme: Default Dark, Solarized Dark, Solarized Light, or GitHub Dark (local; applies to pane and shell output).

### Features

- Desktop file-diff sidebar and grouped tool calls.
- Maximum rendered chat-history messages per conversation.
- Require a second tap within two seconds to commit choice selections.
- Markdown Copy v2 (long-press copy modal), hide inactive sessions, experimental compatibility resume/fork/duplicate, and a local in-memory session cap.
- Web Enter-to-send and optional web command palette.

### Notifications

- Desktop/web banners when the app is not focused.
- Mobile push on/off, plus detailed device/token controls on Account.

### Agent defaults

- Per-agent Permission, Model (when the agent has choices), and Effort (when supported) for Claude, Codex, Gemini, OpenClaw, OpenCode, and Pi.
- Each field can inherit the code default or override it; all overrides can be cleared at once.
- These defaults drive the compatibility new-session page and session UI. Joy-native creation has its additional daemon-specific catalogs and controls.

### Agent config files

- Choose an online Joy machine, then Claude, Codex, OpenCode, or Pi.
- Reads and displays both raw and parsed config from `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, or `~/.pi/agent/settings.json`.
- Schema-driven/path assignment mode can merge lines such as `a.b[0] = value`; JSON `null` deletes a key. Full raw replacement is also available.
- Writes are refused unless the resulting JSON/TOML parses, preserve unrelated fields in assignment mode, and create one adjacent `.joy-bak` backup generation.
- Claude and OpenCode schemas are fetched and disk-cached for offline reuse; Codex and Pi have raw/path modes but no published schema.

### Sessions, machines, HTTP, raw settings

- Joy Sessions probes online machines, lists active daemon records by agent, opens the relay chat, captures the pane, kills a session, and creates a simple cwd session.
- Machines and Cleanup provide the machine/session operations described above.
- Joy HTTP config selects a direct daemon URL (default `http://localhost:4997`), lists/creates/kills sessions, opens a relay-backed chat when an ID exists, and displays a raw pane snapshot. This bypasses machine RPC only for those controls.
- Raw Settings is a schema-aware JSON editor that replaces the entire synced settings object after confirmation. Removing a key really deletes it; invalid known-key types are rejected rather than silently defaulted.

### Synced vs local behavior

- Account settings sync includes appearance behavior, notification preferences, agent defaults, voice settings, recent paths, last-used agent/modes, chat cap, double-tap, direct-daemon URL, and experimental feature flags.
- Device-local state includes theme/palette/terminal theme, chat and file-view font/wrap, command palette, Markdown-copy behavior, zen mode, memory cap, logging/debug flags, voice experiment override, and update/changelog acknowledgements.

## Slash commands and command/skill discovery

### Composer defaults and filtering

- Always offered: `/compact`, `/clear`, `/mcp`, `/skills`, `/steer`, `/btw`, and `/title`. Fuzzy matching searches name and description and returns at most ten results.
- Potentially dangerous, redundant, setup-only, or unusable built-ins are deliberately filtered from autocomplete (for example login/logout, permissions, config, resume, exit, upgrade, IDE/setup, cost/status/help, and several review commands). They can still be typed manually if the harness supports them.
- Installed plugin commands are intentionally excluded from composer autocomplete. The scanner implementation can understand plugin layouts, but the active machine scan does not add them; the machine-page footer that mentions plugins is stale relative to this behavior.

### Filesystem discovery by flavor

- Claude: project/personal `.claude/commands/**/*.md` and `.claude/skills/*/SKILL.md`.
- Codex: project/personal `.codex/skills`, personal top-level `.codex/prompts/*.md`, plus project/personal `.agents/skills`.
- OpenCode: project/personal `.opencode/{commands,skills}`, `.agents/skills`, and Claude **skills** (not Claude commands).
- Pi palette projection advertises Claude and `.agents` skills; Pi also has its own harness discovery outside this scanner.
- One command-directory sublevel is namespaced as `subdir:name`; skill frontmatter supplies canonical name and descriptions. A session receives personal plus its project projection filtered to what that agent actually loads. The machine page shows the accumulated union across scanned projects.
- Machine commands rescan every five minutes and on explicit refresh; project commands scan when a session attaches.

### Joy-owned command semantics

- Claude adapter intercepts `/steer`, `/btw`, `/title`, `/login-code`, and `/joy-prompt` before ordinary queue delivery:
  - `/steer text` submits text immediately even during a turn.
  - `/btw question` transports Claude Code's built-in side question immediately without interrupting the main turn.
  - `/title text` sets and locks the app title; bare `/title` unlocks and returns to agent/CLI titles.
  - `/login-code code` safely fills the currently visible OAuth code input.
  - `/joy-prompt` invisibly re-injects the current Joy structured-UI/tag instructions in a long conversation.
- Codex, OpenCode, and Pi implement `/title` and `/joy-prompt` parity. Their normal busy delivery uses their native turn/follow-up mechanism rather than Claude's `/steer` command.
- All other slash commands pass to the selected harness. `/goal` is a Claude CLI feature surfaced by the Goal bar rather than a daemon-owned command.

## Joy daemon: runtime and transports

### Runtime/lifecycle

- One daemon instance per relay. The default relay uses port 4997 and historical credentials; additional relays get their own state directory, tmux server, service unit, credentials, and dynamically assigned localhost port.
- Reads optional provider environment variables from `~/.joy/env` without overriding real process environment.
- A singleton lock prevents two daemons from recovering and publishing the same tmux windows.
- Persists `daemon.json` with localhost port, PID, version, relay, and a random mutation token. Session window records, inbound/outbound spools, queue state, and adapter checkpoints enable recovery after daemon restart.
- Stopping/restarting the daemon does not kill tmux-hosted Claude/Codex sessions; startup recovers and reattaches surviving windows and relay sessions.
- Publishes machine heartbeats/telemetry and metadata, warms the incremental usage cache after boot and every two hours, rescans personal commands every five minutes, and reconnects relay state automatically.

### Two operation transports

- Every catalog operation is registered as an encrypted machine/session RPC over the relay and, when it has an HTTP mapping, as a localhost endpoint using the same handler.
- HTTP listens only on `127.0.0.1`, validates the `Host` header against loopback, restricts CORS reads to its own loopback origin, caps JSON bodies at 10 MB, and requires the per-instance `X-Joy-Token` for POST/DELETE. Read-only GETs remain usable by the local debug UI.
- HTTP-only debug pages are `/`, `/session/:id`, `/session/:id/screenshot`, and an `/events` SSE stream containing chat/session history plus live updates.

### Machine operation catalog

| Area | Relay RPCs / HTTP capability |
| --- | --- |
| Discovery | `joy-list-sessions`, `joy-get-session`, `joy-status`, `joy-codex-models`, `joy-opencode-models`, `joy-opencode-sessions`, `joy-refresh-commands` |
| Session lifecycle | `joy-create-session`, `joy-restart-session`, `joy-kill-session`, `joy-kill-all-sessions`, `joy-restart-daemon` |
| Input/control | `joy-send`, `joy-send-keys`, `joy-set-mode`, `joy-opencode-set-model`, and Codex-only relay RPC `joy-codex-approve` |
| Verified queue | `joy-queue-list`, `joy-queue-add`, `joy-queue-edit`, `joy-queue-cancel`, `joy-queue-reorder`, `joy-queue-resume` |
| Pane/transcript | `joy-pane`, `joy-resize`, `joy-transcript`, `joy-session-log` |
| Analytics | `joy-usage`, `joy-session-usage`, `joy-limits` |
| Agent config | `joy-agent-config-read`, `joy-agent-config-set`, `joy-agent-config-write`, `joy-agent-config-schema` |
| Project logs | `joy-list-logs`, `joy-read-log` |
| Notification | `joy-notify` sends a title/body directly to all registered Expo tokens through the authenticated account |

`joy-send` can either queue normally or enforce the CLI scripting contract: an exclusive send rejects busy sessions and rejects permission modes that could block on an unattended prompt.

### Session operation catalog

- `abort`, `killSession`, and the internal `joy-hook`/legacy `compacting` hook endpoints.
- Jailed `bash`, `readFile`, `writeFile`, `listDirectory`, `getDirectoryTree`, `ripgrep`, and `difftastic`.
- `writeFile` supports expected-hash concurrency checks. `readFile` transparently remaps a malformed Joy-media session ID to the current session's media directory and can upload large responses as encrypted blobs.

### Queue and delivery robustness

- Claude relay messages are durably staged before acknowledgement, sequence-deduplicated, and dispatched only when the pane is ready and its input box is empty. Typed text is verified against the transcript/TUI echo before the cursor advances.
- Queue pause reasons (dirty input, mismatch, timeout, failed persistence) are published to the app rather than silently discarding input. Items support edit/cancel/reorder/resume before dispatch.
- A delayed Enter avoids Claude treating a fast `send-keys` burst as an unfinished paste. Abort/kill/mismatch cancels stale scheduled input.
- Retriable Claude 5xx failures are re-enqueued with a bounded, visible retry schedule (roughly an hour across 14 attempts).
- Codex and OpenCode have their own durable inbound stores/checkpoints and replay dedupe. Pi delegates busy follow-up ordering to its native RPC queue and exposes counts, but not editable daemon queue items.

### Automatic notifications and resource alerts

- Agent turn completion, permissions/questions, and custom `<joy-notify>` events post upstream push-events, allowing the account service to suppress a notification when the app is focused on that session.
- `joy notify`/`joy-notify` fetches account push tokens and sends Expo pushes individually so one stale token does not prevent other devices from receiving the alert.
- Daemon resource alerts cover RAM, home-volume disk, Claude 5-hour/weekly quota, and Codex primary/secondary quota crossing 90%. Each alert re-arms below 85% and has a four-hour cooldown; RAM/disk sample every five minutes and quotas every four hours.

## Joy daemon CLI (`joy`)

- Global `--relay <alias|url>` selects the relay-specific daemon. Known aliases include happy/happy-joy/joy/joy-dev; custom HTTP(S) URLs work.
- Service/runtime: `start`, `stop`, `restart`, `status`, `list`/`ls`, `doctor`, `update`, `install`, and `uninstall`. Install creates a systemd user service on Linux or launchd agent on macOS; restart/re-exec preserves tmux sessions.
- Terminal access: `jump`/`j [id|prefix|path|folder]` attaches or switches to the unique matching tmux window, defaulting to the current cwd.
- Authentication: bare `auth` shows credentials/machine/relay; `auth <relays...>` pairs multiple non-default relays from one backup code. Default-relay credentials are shared with the existing app/Happy credential directory.
- `notify -p message [-t title]` sends a push through the running authenticated daemon.
- Scriptable sessions:
  - `new <dir>` creates a Claude/Codex/OpenCode/Pi session with optional first message, agent, model, effort, read-only mode, continue/resume, and JSON output.
  - `ask` exclusively sends, waits for the next completed turn, and prints assistant text.
  - `send` is exclusive fire-and-forget; `wait` blocks until idle; `log` prints recent user/assistant text; `kill` ends a session.
  - `run` creates an ephemeral session, runs one prompt, prints the response, then always kills it and removes its transcript, including error/timeout cleanup.
- Scripted sends never silently queue: busy is exit 3, timeout exit 4, and a mode other than yolo/bypass or read-only/plan is exit 5 because unattended permission prompts could hang automation.
- `doctor` checks Node, `tsx`, tmux, Claude, relay/auth files, daemon source, and live daemon state.

## Agent adapters

### Shared contract

- Joy-native creation accepts exactly `claude`, `codex`, `opencode`, and `pi`; unknown agents are rejected.
- Each adapter normalizes harness-specific activity to one relay/chat vocabulary: user/assistant text, turn start/end, tool start/end, thinking, model/effort, context, receipts, title, notifications, and state metadata.
- Claude, Codex, and OpenCode are taught the shared `<options>`, image, file, title, and notify conventions at launch/first prompt. Pi learns them only after `/joy-prompt` in the current bare implementation.

### Claude Code

- Runs the real interactive `claude` TUI inside a tmux window. Supports new, continue, resume, replay-limit, fork-session, model, fallback model, effort, permission mode, and extra CLI flags.
- Installs a launch-time appended system prompt for structured options/media/files/title/notifications and the Claude-only long-running-background tag. It explicitly steers the agent away from `AskUserQuestion`, which the remote UI cannot answer reliably.
- Tails Claude JSONL and hooks `SessionStart`, `UserPromptSubmit`, `Stop`, `Notification`, and `PreCompact` to bind session identity and derive messages, thinking, context, compaction, retry, permissions/dialog/login, goals, subagents, finite background tasks, and persistent processes.
- Can adopt surviving tmux windows, resume transcripts, reconcile local/relay input, and expose the live pane. Supports every Joy-owned command described above.

### Codex

- Starts one Codex app-server JSON-RPC Unix socket per Joy session (private socket permissions) and an attached Codex TUI in tmux. It starts/resumes/rejoins threads and queries the live model catalog with a disk/app-server cache.
- Normalizes Codex command execution, file changes/patches, MCP/tool events, assistant text, context, model, and effort into the shared UI.
- Mode mapping is fail-closed: default = on-request + workspace-write, read-only = on-request + read-only, safe-yolo = never ask + workspace-write, yolo = never ask + danger-full-access.
- Only command-execution and file-change approval requests are supported by the app bar. Other request-user-input, permission, MCP elicitation, and token-refresh requests are rejected/unsupported; unanswered supported approvals auto-deny after five minutes.
- Mode changes apply on the next turn. Turns are FIFO with durable inbound replay/checkpoints.

### OpenCode

- Starts one `opencode serve` HTTP process per Joy session and uses persistent OpenCode project sessions rather than a terminal transcript.
- Supplies a curated daemon model allowlist, lists/resumes prior sessions in the cwd, can continue the newest session, reconstructs history/checkpoints after reconnect, injects follow-ups while busy, and switches models live.
- Its normalized events drive the same chat/tool/title/context/notification UI. Current v1 has no Joy permission/approval surface and no tmux pane.

### Pi

- Runs `pi --mode rpc --no-session`, normalizes response/turn/tool/queue/error events, and uses native `prompt`, mid-turn `steer`, follow-up queue, and `abort` messages.
- Minimal v1: no resume or restart reconciliation, permissions, effort, live model switching, or terminal pane. It supports `/title`, `/joy-prompt`, basic title inference, final text, and tool events.

## Joy relay

### Current deployed-path behavior in this source

- `proxy.mjs` is the phase-0 transparent proxy: every HTTP request and raw WebSocket/Socket.IO upgrade is forwarded byte-for-byte to an upstream server (default localhost port 3005). It returns a Joy-branded 502 only when upstream is unavailable.
- `server.mjs` combines that same passthrough with native handling for `/joy/v1`; its own source comments designate the stable instance as still using `proxy.mjs` and the combined server as the development-first migration entrypoint.
- The examined app and daemon contain no `/joy/v1`, lease, claim, or session-creation endpoint references. Their `/v1`/`v3` HTTP, Socket.IO, machine RPC, session sync, artifact, attachment, and push traffic therefore uses the passthrough/upstream-compatible path today.

### Native `/joy/v1` protocol (implemented, not yet called here)

- Public capability discovery reports protocol 1.0 with sessions, turns, cancellations, claims, events, state, and SSE.
- Client surface: list sessions; create a daemon-spawned session or announce an existing local session; submit encrypted prompt turns; cancel a target turn; query a session state projection; paginate canonical events; and subscribe to account-level SSE hello/poke notifications.
- Daemon surface: acquire/renew a 20-second lease, long-poll separate work and control lanes, acknowledge a delivery, bind a spawned session/local ID/key envelope, report submitted/start, append output or terminal facts, and reconcile orphaned turns after restart.
- Embedded PGlite persists native sessions, daemon leases, commands, turns, deliveries, and ordered session events outside the deployed checkout.
- Strict per-session ordering permits only one execution-bearing turn at once. Claims only offer the queue head, and an unacknowledged current-epoch delivery is re-offered rather than duplicated.
- Cancellation is durable: queued turns can be cancelled before start; active turns enter cancelling; an optional barrier also cancels earlier queued turns. Late/stale starts are rejected.
- Lease tokens, monotonically increasing epochs, daemon/account ownership, delivery IDs, and run tokens fence stale daemons. A five-second sweeper marks dispatching/running/cancelling work orphaned when its lease expires; only explicit reconcile can return an orphan to running or terminal.
- Client intent IDs are idempotent per token-derived actor. Reuse with different request content returns `409 idempotency_mismatch`. Runtime fact IDs similarly deduplicate adapter retries.
- State reports daemon online/expired state, queued and delivered counts, active turn, cancellation/recovery flags, and execution states such as idle, dispatching, running, cancelling, orphaned, stalled, or recovery required.
- Admission limits: 256 KB inline ciphertext, 100 queued turns/session, 200 non-archived sessions/account, 50 daemons/account, 50,000 events/session, and eight SSE streams/account.
- SSE messages are only snapshots and **pokes**; clients fetch durable DB events after a poke. Daemon wakeups are also advisory long-poll wakeups followed by a DB query, so lost in-process notifications delay but do not lose work.
- Native authenticated routes delegate bearer-token validation to upstream `/v1/account/profile` and cache only successful token/account bindings for five minutes. Actor identity is derived from the token hash, not a caller-controlled header.

## End-to-end feature flows

| User action | App responsibility | Daemon responsibility | Relay/upstream responsibility |
| --- | --- | --- | --- |
| Pair/sign in | Generate/restore secret, QR approval, store per-relay token | Share/default credentials or pair extra relays via CLI | Authenticate public-key challenge and store account/device identity |
| Start Joy session | Pick machine/path/agent/options; call machine RPC; send optional first prompt | Validate/create/clone cwd, start adapter, create relay session, publish metadata/RPCs | Route machine RPC and create/sync session record |
| Send message | Optimistic encrypted row, durable outbox, busy draft queue | Durable inbound staging, harness-specific delivery, echo/receipt matching | Store/sequence encrypted message and route it to machine |
| Render response | Decrypt and normalize shared message/tool UI | Tail/listen to harness, normalize events, publish state/context/tools | Persist and fan out encrypted events; send focus-aware push events |
| Approve/intervene | Permission/dialog/login/Codex approval bars or pane keys | Translate to TUI keys, app-server response, abort, or mode change | Route RPC and state updates |
| Browse/edit files | Tree/search/diff/view/editor/conflict UI | Jailed bash/read/write/tree/grep/difftastic and attachment fallback | Route encrypted session RPC; store large encrypted attachment blobs |
| Inspect machine/usage | Aggregate machines and render charts/limits | Heartbeat/resources; parse local JSONL and account quota sources | Sync machine metadata and route analytics RPC |
| Notify | Desktop banner/mobile preference and token management | Completion/question/custom/resource push event | Suppress focused-session events upstream; deliver mobile push |

## Important boundaries and incomplete surfaces

- Native relay durability is not the current app/daemon wire protocol: `/joy/v1` is implemented in `joy-relay`, but there are no callers in the examined app or daemon.
- The current stable relay entrypoint is described as the pure upstream proxy, so account/session/artifact/attachment storage and Socket.IO behavior still depend on the upstream server.
- `/new` and its Gemini/OpenClaw/worktree/legacy fork-resume ecosystem are compatibility surfaces. The current Joy navigation uses `/joy/new`, whose native daemon supports Claude, Codex, OpenCode, and Pi.
- OpenCode and Pi have no pane; OpenCode has no Joy permission surface; Pi has no restart reconciliation/resume/model/effort controls. Codex handles only command and patch approvals.
- Artifact CRUD routes exist but are not linked from normal navigation.
- Claude OAuth inside the app is disabled; the route displays a terminal command instead.
- Some developer controls are demonstrations/placeholders, notably Clear Cache and Reset App State; they should not be counted as working destructive maintenance features.
