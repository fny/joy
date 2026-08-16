# Aug 16 (2) — Less noise, real limits, a sketch pad

A quality-of-life sweep: collapse the chat clutter, see your actual Anthropic/OpenAI quota, draw on your screen, and edit any agent's config from your phone.

- **Collapse everything.** A new top-left button in each session collapses/expands every tool call at once; each tool card and each code diff also gets its own chevron. Compaction summaries now appear as a collapsed card instead of vanishing (or walling the chat).
- **Live account limits.** Settings → Limits shows your real Claude 5-hour/weekly utilization and reset times (read via each machine's own Claude Code login — no credentials to enter) plus Codex's rate windows. The daemon also pushes an alert when any quota, RAM, or disk crosses 90%.
- **Drawing attachments.** The brush button opens a full-screen sketch pad — five pens, white/black paper, adjustable thickness, smooth finger strokes — and drops the PNG straight into the composer.
- **Agent config editor.** Settings → Agent Config edits each agent's real config file (claude settings.json, codex config.toml, opencode, pi) on any machine: walk the published schema or use raw mode with JSON-path lines like `examples[0].title = "hi"`. Every write keeps a backup.
- **/joy-prompt.** Re-injects the latest joy instructions into a long-lived session (any agent) — the fix for stale titles and forgotten option pickers; it's also how pi learns the vocabulary.
- **Resource pressure, visible.** Machine view shows Memory and Disk as used-% (red at 90%+), and a red banner appears under a session's header when its machine runs hot.
- **Usage, faster + honest pills.** Usage reports answer instantly after daemon restarts (persistent cache, background-refreshed every 2h) and the period pills finally show which one is active in dark mode.
- **Queue steer arrow.** Each queued message has an arrow that sends it immediately (mid-turn) instead of waiting its turn.
- **Simpler terminal view.** The claude status chrome (permission hints, widgets) is filtered out by default — tap Full to see everything.
- **Session list by agent.** Settings → Sessions labels and sorts sessions by agent flavor, with a better icon.
- **Leaner relay picker.** The dev and direct doors are gone — Happy Cloud and Joy Relay only.
- **Esc stays in the chat.** Pressing Escape in a session aborts the running turn (or does nothing) instead of navigating you out mid-conversation. Subpages and the mouse back-button still go back.

# Aug 16 — Your own relays, new agents, big files

Joy now runs on its own infrastructure, speaks four agent flavors, and the file viewer handles real files.

- **Self-hosted relays.** Switch between Happy Cloud and the new joy relays right from Server Configuration — with three doors into the joy universe (stable, dev, and direct) for testing relay changes against live data.
- **One key everywhere.** Your original secret key now works on every relay: "Use this key on all relays" sets up each one in a tap, and `joy auth <relay>` pairs any machine from the same backup code — no more per-relay accounts.
- **New agent: opencode.** Full-featured sessions on open models (Kimi K3 on Fireworks by default) — steering, queueing, model switching, past-session resume, auto-titles.
- **New agent: pi.** A fourth flavor with native mid-turn steering and harness-owned queueing, also running Kimi K3.
- **Big files in the file viewer.** Files up to 10MB now load (was ~700KB) — bytes ship as encrypted blobs instead of squeezing through the realtime channel.
- **File viewer overhaul.** One file at a time, downloads, image rendering, and source/rendered modes for CSV, TSV, Markdown, and fully-working self-contained HTML.
- **Queued messages actually send.** Messages queued while the agent was busy could sit forever after an app reload — the release valve now arms on every boot.
- **File browser + attachments always on.** No more experiment toggles — the full UI is there on every account and relay.
- **Fewer duplicate machines.** Each computer registers once per universe, not once per relay door.
- Renamed the machine-side daemon to joy-daemon, with clean automatic service migration on update.
- **Search a conversation (⌘F).** Press ⌘F (Ctrl+F) in a session to search its messages — Enter/↑↓ jump between matches and scroll the chat to each one. Searches the loaded conversation; scroll up first to include older history.
- **Stop button in the composer.** While the agent is working, the send button becomes a square stop button — tap to interrupt; start typing to queue a follow-up instead. The save-draft button moves to where stop used to be.
- **New avatars.** Sessions and machines now use hashicon identicons — distinctive geometric marks derived from each id.
- **Desktop: text selection works again.** Code blocks and chat text can be selected and copied in the desktop app (the native-feel styling was suppressing it).

# Jul 3 — Consistent status, working scrubber, /title

Small polish across the chat and machine views, plus fewer false "failed to send" alarms.

- Session status color is now consistent everywhere — the sidebar dot and the chat header no longer disagree (teal while finishing background tasks, yellow for permission prompts).
- The "jump to previous prompt" arrow works when you're scrolled to the very bottom of a chat, instead of doing nothing.
- `/title` shows up in the slash-command menu, so you can rename a conversation without remembering the command.
- Tap a machine's command count to see the full list of slash commands it found (plugins marked), so it's clear what's available.

# May 15 — Cleaner, steadier chat

Less clutter in the conversation, fewer stuck states, smoother scrolling.

- Slash commands render as a clean chip — no more raw command markup or duplicated text.
- Skill runs no longer dump a wall of raw instructions into the chat.
- Chats pick up their real title instead of staying stuck on "New chat".
- The view stays put while the agent streams — no more scroll jumps when you've scrolled up to read.
- "Permission required" prompts clear properly after a session is interrupted.
- Resumed sessions no longer replay your whole history as duplicate messages.
- Slash-command and file autocomplete shows more results and keeps the highlighted item in view.

# May 13 — Faster long chats

Long sessions open instantly. Messages load latest-first with older history streaming in on scroll.

- Parallel decryption — no more freezing on sessions with thousands of messages.
- Backward pagination — scroll up to load history on demand.

# May 7 — Session retention, new sidebar, code editor, session branching

Desktop got a full refresh with a file browser, built-in editor, and zen mode. Sessions can now be branched or rewound.

**Session retention: 2 months.** Older sessions are cleaned up automatically to keep storage costs manageable.

## Features and fixes

- Thinking effort selection bug fixed.
- Smarter push notifications — suppressed when you're already in the app.
- Unread dots persist on sessions until you open them.
- Redesigned sidebar with file browser, code editor, and zen mode.
- Fixed stale sessions refusing to load, blank screen on launch, dual cursors in remote mode, `claude --resume` not finding Happy sessions.

## Experimental

Enable in Settings → Features:

- File diffs sidebar — see git changes next to chat on desktop.
- Session fork & rewind — branch off any session or roll back to any message.

# April 26 — Voice fixes, diffs, scroll

Voice actually works reliably now, plus better content rendering.

- Voice calls no longer break on second session.
- Tables and code blocks scroll horizontally.
- New diff viewer with syntax highlighting and unified/split toggle.
- Model and effort choices persist on mobile.
- Permission prompts no longer get lost.
- Settings stop randomly resetting during sync.
- Scroll-to-bottom button in chat.
- Delete machines from settings.

# April 8 — Gemini models, voice onboarding, CLI fixes

New models, smoother onboarding, fewer CLI hangs.

- Latest Gemini models in the picker.
- Better voice onboarding — clearer first-run prompts.
- CLI plan approval buttons actually show up now.
- CLI background tasks and Codex turns no longer hang.

# March 19 — New session screen, git worktrees, more agents

Completely new way to start sessions, plus worktree support and more agents.

- New session composer — pick machine, worktree, draft persists.
- Git worktree management from the app. Auto-cleanup on delete.
- Auto plan mode when your agent enters planning.
- OpenClaw as a selectable agent.
- Session quick actions, resume, delete from info screen.
- "Bypass" renamed to "yolo".

# December 22 — Agent updates, voice changes, tables

Agent config changes and voice pricing heads-up.

- Gemini support coming via ACP.
- Model config removed from app — use CLI defaults.
- Voice going subscription after 3 free trials.
- Markdown tables render properly now.

# September 12 — Codex, daemon mode, one-tap launch

Sessions start instantly now. No more manual CLI startup.

- Codex support for code completion and generation.
- Daemon mode — sessions start instantly without manual CLI startup.
- One-tap launch from mobile.
- Connect Anthropic and GPT accounts.

# August 29 — GitHub integration

Your GitHub identity in Happy.

- Connect your GitHub account via OAuth.
- Avatar, name, and bio sync to the app.
- Encrypted token storage.

# June 26 — QR login, dark mode, voice

Link devices instantly, look good doing it.

- QR code auth for instant device linking.
- Dark theme with system preference detection.
- Faster voice responses.
- Modified file indicators in session list.
- 15+ languages for voice.

# May 12 — Hello world

First release. Everything is new.

- E2E encrypted sessions.
- Voice assistant.
- File manager with syntax highlighting.
- Real-time sync across devices.
