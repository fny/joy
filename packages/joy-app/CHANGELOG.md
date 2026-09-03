# Sep 3 (3) — Tap-to-answer options work again

- **Option chips render again.** A question with `<joy-options>` had been showing its raw tags as text since Jul 1 — a later change that hides joy control tags swallowed the opening tag, so the block was never recognised. Options are tappable chips again.
- **A held message now tells you why it is stuck.** Messages composed while the agent is working wait in the strip above the composer. If one fails to send, the row now shows the reason, and after the app stops retrying it says so and offers ↻ to try again — before, a failed send looked exactly like a message politely waiting its turn, forever.

# Sep 3 (2) — Voice is back, bring your own agent

- **Talk to your sessions.** The mic in the composer opens a voice conversation with your own ElevenLabs Conversational AI agent. It hears what the focused session is doing, can send a message into any session, answer a held tool approval, and read out a `<joy-options>` question so you can pick by voice. Works on phone, desktop and web.
- **Standing by costs nothing.** After a stretch of silence (45 seconds by default, Settings → Voice) the conversation hangs up but stays *armed*: when a turn ends, an approval is held or a question is asked, it reconnects and speaks. The spoken transcript carries over, so it picks up where you left off. The × on the voice bar ends it for good.
- **Wake by talking.** While idle and the app is open, the phone or browser listens locally (sound level only, nothing sent anywhere) and reconnects the moment you start talking; the bar reads "Joy idle · Listening". Off switch in Settings → Voice.
- **Limits page works again.** It read the pre-tunnel reply shape, so every machine showed blank bars; it now renders the daemon's normalized quota windows (Claude 5-hour and weekly, Codex weekly) and shows the daemon's reason when a provider can't be read.
- **`/joy-prompt` in the command picker.** Typing `/joy-` now offers it; it re-sends the current joy instructions to a running session (how sessions started before a daemon update pick up new instructions).
- **Bring your own agent.** Settings → Voice: add an agent by name and agent id (public agent), or with an API key (private agent with authentication on). The key lives in your encrypted settings and is only used to mint conversation tokens on your device; no server is involved.

# Sep 3 — Sessions can talk to each other

- **Messages from another session are marked.** When a joy session (or a script at a shell) sends a message into one of your sessions through the daemon, the chat shows a "from ‹session›" line above it and a quieter bubble, so you can tell a peer's message from your own. The agent sees the same provenance and knows where to reply.
- **Machine page: Environment.** Provider keys every new session on a machine should inherit (a Fireworks key for pi, for example) can now be added and removed from the machine page; they travel down the sealed tunnel once and are stored encrypted on the machine. Existing `~/.joy/env` files are sealed into the store automatically.
- **Pickers use `<joy-options>`.** The agent tag for tap-to-answer questions was renamed to match the rest of the joy tags; sessions pick it up on their next start or `/joy-prompt`.
- *Needs the updated daemon.* The `joy` CLI grew a matching set of verbs (`ls`, `check`, `about`, `ask`, `send`, `wait`, `events`, `abort`, `approvals`, `queue`, `mode`, `pane`, `env`).

# Sep 2 (5) — Sending from the phone works again

- **Messages send from iOS and Android.** Sealing a message used a text helper the native crypto module does not provide, so every send from a phone failed with "undefined is not a function" while reading worked. Desktop and web were unaffected.
- **Terminal, usage, files and git work from the phone.** The sealed tunnel to your machine used a cipher the native crypto module does not ship, so those screens failed the same way on iOS and Android. The tunnel now seals frames with libsodium's secretbox, which is native on the phone. *Needs the updated daemon: old and new tunnels cannot talk to each other.*

# Sep 2 (4) — Tool cards are back

- **The chat shows the whole turn again.** Since the move to the relay, sessions showed only your prompts and the agent's replies. Tool-call cards, thinking, turn lifecycle and per-turn token usage now flow from the daemon as sealed records for every agent (Claude, Codex, OpenCode, pi), rendered exactly as before. Prompts typed directly into the terminal pane appear as user bubbles as well. *Needs the updated daemon and relay.*

# Sep 2 (3) — Sends that fail come back

- **A message the relay did not accept is no longer lost.** Offline, a session still binding, a refused upload: the text and the pictures go back into the composer and you are told, instead of disappearing with nothing but a console line.
- **A retried message can no longer arrive twice.** The queued-draft release reuses the message's own id when it retries, and the relay treats that id as the identity of the message — a lost acknowledgement now replays the first delivery rather than queueing a second turn for the agent.
- **Long sessions no longer stall behind quiet pages.** Catching up after a reconnect could stop on a page of lifecycle-only events and never fetch what came after; the cursor now advances over them.
- **Attachment limits hold everywhere.** The 10MB per-file cap is checked on the bytes actually read, so pasted or dropped files on web can no longer slip past it; empty files are refused up front. Only PNG, JPEG, GIF and WebP render inline — other files show as a name and size row. Web previews release their memory once sent.
- **Removed from the app**: the never-shown "Sending… / Not delivered" line under messages and the long-press-to-fork gesture (neither could fire on the relay path), the subscription/RevenueCat code, the Claude.ai OAuth helper, the plaintext "Relay v2 Mode" developer screen, and a set of unused screens, hooks and native modules. Pairing a terminal now sends only the sealed data-key answer. *Needs the updated relay and daemon: `/joy/v1` is gone from the relay, the daemon refuses legacy (secret-based) pairings.*

# Sep 2 (2) — Attachments on the relay

- **Images and files send again.** Attaching a photo, file, paste or drawing to a message uploads it sealed with the session's own key — the relay stores bytes it cannot read — and the daemon drops the file into the session's folder and points the agent at it, so "look at this screenshot" works on every agent. If an upload fails the message is held back and you are told, instead of the text going out without its picture.
- **Attachments show in the chat.** Your sent images appear inline above the bubble (a blurred placeholder until the bytes load), other files as a name and size row, on every device signed in to the account.
- **Re-pair after updating.** The keys that seal session content are now derived under Joy's own name rather than the old Happy labels. Sealed history written before this update cannot be opened by the new app, and terminals paired before it must be paired again. *Needs the updated daemon on the machine.*

# Sep 2 — Joy only

- **The Happy Cloud relay is gone.** Server Configuration lists Joy Relay only, it is the default for new installs, and the server check now confirms it is talking to a joy-relay rather than looking for the old server's welcome banner. Custom relay URLs still work. Existing logins and caches on Joy Relay carry over unchanged.
- **Links are `joy://`.** The terminal-pairing and account-restore QR codes and the "paste URL" flows now use `joy://…` instead of `happy://…`; the app registers the `joy` scheme on iOS and Android. Old `happy://` links no longer open.
- **Voice, GitHub connect, artifacts, usage dashboards and connected services are removed.** None of them had a backend on the joy relay, so they could only fail; their settings pages, the microphone permission and the audio/voice libraries are gone with them.
- **Settings are per device.** Preferences no longer try to sync to an account-settings store the relay never had.
- **Machine page shows the daemon.** Version and Joy home directory appear alongside host and home; machines registered by an older daemon still list fine.
- **Renamed under the hood** — nothing to do: the resume snippet is now `joy new . --resume <id>`, the offline hint says `joy status`, the CLI install hint points at `@fny/joy-daemon`, and the desktop app calls itself Joy in its menu and window titles.

# Sep 1 (2) — Idle sessions stay in the sidebar

- **A live session no longer vanishes 90 seconds after its last reply.** The app judged "still alive" by the time of the last turn, which under v2 nothing refreshed while you weren't talking — so a freshly created session dropped out of the active list (or off the sidebar entirely) as soon as it sat idle. Liveness now follows the daemon's relay lease, the same signal that decides whether a message would be delivered: online means active, however long it's been quiet, and a daemon that dies shows offline within about 20 seconds.
- **Sessions that died while their daemon was down are archived, not haunted.** A session the relay still believed was running — but that no machine actually had anymore — grouped itself under "Yesterday" / "2 days ago" and then hid, leaving a date header with nothing under it. Two fixes: the daemon now archives any session it's supposed to own but has no runtime for the moment it reconnects, and the sidebar decides "active" once, the same way for grouping and for showing, so a row can never be filed as history and then dropped as active.
- **Desktop shows its release.** The JS-update row on web/desktop now always shows the commit and release time instead of "web bundle (unstamped build)".

# Sep 1 — Everything speaks v2

- **The entire app now runs on the joy relay's v2 surface.** Login, the session and machine lists, chat, push registration, the message queue, codex approvals, files, git, terminal, usage, limits, agent config, history — every call the app makes goes to `/joy/v2` or through the end-to-end-encrypted machine tunnel. The happy socket is gone from the app entirely; live updates arrive over the relay's event stream with a polling fallback.
- **Session cards are sealed.** The daemon publishes each session's name, path, state and queue as an encrypted card only your devices can open — the relay stores ciphertext. Presence now comes from the same lease signal the work queue dispatches on, so "online" can never disagree with "a message would actually be delivered".
- **First message can't vanish.** Creating a session with an initial prompt used to race the daemon's bind and silently lose the message; the app now waits for the bind (and refuses to ever send unencrypted while waiting). If an initial send fails you see the error.
- *Needs the updated relay and an updated daemon on the machine.*

# Aug 31 (3) — The terminal says why it is empty

- **A session the machine no longer has now says so.** Opening the terminal for a session the daemon doesn't know showed an empty black terminal with a small "session_not_found — retrying…" note, as though it were still loading — it never would. It now states plainly that the session ended or the daemon restarted without reattaching it. Same for a machine your account can't reach.
- Genuine blips (a timeout, a daemon restarting mid-poll) still show the retry banner and still recover on their own.

# Aug 31 (2) — Terminal view fixes

- **The terminal opens on your session, not on a blank.** The view sized the tmux window to twice the height it renders, so Claude — which pins its input box to the bottom — put the box at the fold with a screenful of empty space above it, and the conversation a full screen higher. The window now matches what you actually see. (Scrolling back further is gone with it; Claude keeps no terminal scrollback, and the taller window was the only way to fake it.)
- **Rotating no longer leaves the pane the wrong height.** A resize was only sent when the column count changed, so a height-only change kept a stale row count.
- **The terminal can no longer shrink your session to 20×10.** Opening it before the layout had measured sent a real 20×10 resize, which stuck after you left the screen — leaving a session whose terminal shows nothing useful and whose typed messages can stop landing.

# Aug 31 — Every joy session runs on v2

- **v2 is the only path now.** New joy-tmux sessions always run on the v2 relay pipeline — the "via v2 relay" tick is gone because it is no longer a choice. Sends, cancels, files, git, terminal, usage and history all travel the sealed v2 path, and every option the old screen offered (model, effort, permission mode, fallback model, continue/resume, fork, extra arguments) rides along with the spawn. *Needs an updated daemon on the machine.*
- **Sessions in a brand-new folder start properly.** Claude asks whether you trust a folder it has not seen before. Joy was answering that prompt with the wrong option and quietly shutting the session down, so anything you typed sat unsent forever. It now answers correctly no matter how the prompt is laid out.
- **Changes tab works on a cold open.** Opening a session's Changes straight from a link used to say "not a git repository" until you navigated away and back. It now waits for the session to load instead of giving up.
- **Per-session usage over v2.** The session usage screen reads its cost row through the new path in one call, and no longer fails with an encryption error on v2 sessions.

# Aug 30 (2) — v2 on the main relay, create-directory prompt

- **v2 works on the Joy Relay.** The main relay now serves the v2 pipeline, so v2 sessions work without switching relays — no more errors when a session tries the new path.
- **"Create directory?" on v2.** Starting a v2 session in a folder that does not exist now asks whether to create it, the same as a normal session, instead of spinning forever.

# Aug 30 — v2 sessions, end to end (developer)

- **v2 as a real transport (opt-in per session).** New joy-tmux session → tick **via v2 relay** and the session runs over the new relay pipeline: sends and cancels travel the durable, end-to-end-encrypted v2 path, while the conversation still shows the same way. Everything is sealed — the relay stores ciphertext it cannot read. *Needs a relay serving `/joy/v2` and an updated daemon on the machine.*
- **V2 badge.** Sessions running on the v2 path show a small **V2** tag in the session list, so it is clear at a glance which are the new-pipeline sessions.
- **Safer by construction.** A v2 session refuses to send if it cannot encrypt (never falls back to plaintext), image attachments are blocked with a clear message on the v2 path for now, and cancelling a v2 turn goes through the one clean path.

# Aug 26 — Relay v2 Mode (developer), header search

- **Relay v2 Mode (Developer).** Settings → Developer → Relay v2 Mode drives sessions over the new native `/joy/v2` relay surface end to end: create a session on a machine (pick the folder and agent), watch the reply stream in live, edit/reorder/delete queued messages, retry a failed delivery, cancel a running turn, send attachments. It's the testing surface for the next-generation sync — *needs a relay serving `/joy/v2` and an updated daemon on the machine.*
- **Search from the header.** The session header gains a search button that opens the find bar — same as pressing Cmd+F on desktop.
- **Relay password stays home.** The per-relay password now only ever accompanies requests to exactly the configured relay origin — a look-alike domain can no longer receive it.

# Aug 19 — Lighter app, file delete, relay passwords

- **~3.5 MB smaller.** The app was shipping all 19 icon fonts — including families it has never drawn a single glyph from. It now bundles only the two it actually uses (Ionicons and Octicons); everything that referenced the others was moved onto equivalents.
- **Delete a file from the file viewer.** A trash button sits next to Download. It confirms first, naming the file, and there is no undo — the daemon unlinks it. Directories are refused, and it only reaches inside the session's own folder. *Needs the machine's daemon updated to work.*
- **Relay passwords, per relay.** Settings → Account: each relay row has a lock you can tap to set that relay's password. This matters before switching to a gated relay — it refuses the connection without the key, so it has to be set in advance.
- **Composer tidy-up.** The draft button is now a save icon (it saves a draft), settings sits before the paperclip, and the icon row's spacing is halved without shrinking the tap targets.

# Aug 18 — Identicons, tidied

- **Identicons: circles and squares.** The hashicon style is retired; identicons are now the joy-palette confetti grid clipped two ways — Circles (the new default) or Squares. Pick in Appearance → Identicons.
- **Smaller by default, finer control.** Identicon size now defaults to 16px and ranges 8–24 in 2px steps (it was 24px, 16–48 in 4s). If you had it set larger, it pins to the new maximum.
- **Session list lines up.** The project identicon now sits on the same column as the status dots in the rows below it, and the folder name starts exactly where the session titles do.
- **Icon browser (Developer).** Settings → Developer → Icons lists every icon in every family the app ships — search by name, tap one to copy its name.

# Aug 17 — Queue crash fixed, ordering, desktop drawing

Fixes for yesterday's batch: the big one is a crash that could take down the whole session screen the moment a message actually queued.

- **Session screen no longer crashes on queueing.** When a message entered the daemon queue (the QUEUED strip appearing), a React hooks bug could crash the entire conversation view to the error screen. Fixed.
- **Queued messages land in order.** A message released after a turn now waits for the turn's final answer to arrive before sending, so it appears *after* the response it queued behind — not spliced into the middle of it.
- **Drawing works on desktop.** The sketch pad now uses a real canvas on web/desktop — mouse strokes draw properly and save reliably. (It was effectively dead there before.)
- **Identicon alignment, actually fixed.** Session-list identicons now line up exactly with the session title edge.
- **Quieter paperclip.** The attach button no longer lights up when attachments are present — the thumbnails already tell you.
- **Draft pencils.** Sessions with saved drafts show the same plain pencil in the session list as the composer's draft button.

# Aug 16 (2) — Less noise, real limits, a sketch pad

A quality-of-life sweep: collapse the chat clutter, see your actual Anthropic/OpenAI quota, draw on your screen, and edit any agent's config from your phone.

- **Collapse everything.** A new top-left button in each session collapses/expands every tool call at once; each tool card and each code diff also gets its own chevron. Compaction summaries now appear as a collapsed card instead of vanishing (or walling the chat).
- **Live account limits.** Settings → Limits shows your real Claude 5-hour/weekly utilization and reset times (read via each machine's own Claude Code login — no credentials to enter) plus Codex's rate windows. The daemon also pushes an alert when any quota, RAM, or disk crosses 90%.
- **Drawing attachments.** The attach menu gains Draw: a full-screen sketch pad — five pens, white/black paper, adjustable thickness, smooth finger strokes — and you can paste or pick an image to annotate on top of. The PNG drops straight into the composer.
- **Agent config editor.** Settings → Agent Config edits each agent's real config file (claude settings.json, codex config.toml, opencode, pi) on any machine: walk the published schema or use raw mode with JSON-path lines like `examples[0].title = "hi"`. Every write keeps a backup.
- **/joy-prompt.** Re-injects the latest joy instructions into a long-lived session (any agent) — the fix for stale titles and forgotten option pickers; it's also how pi learns the vocabulary.
- **Resource pressure, visible.** Machine view shows Memory and Disk as used-% (red at 90%+), and a red banner appears under a session's header when its machine runs hot.
- **Usage, faster + honest pills.** Usage reports answer instantly after daemon restarts (persistent cache, background-refreshed every 2h) and the period pills finally show which one is active in dark mode.
- **Queue steer arrow.** Each queued message has an arrow that sends it immediately (mid-turn) instead of waiting its turn.
- **Simpler terminal view.** The claude status chrome (permission hints, widgets) is filtered out by default — tap Full to see everything.
- **Session list by agent.** Settings → Sessions labels and sorts sessions by agent flavor, with a better icon.
- **Leaner relay picker.** The dev and direct doors are gone — Happy Cloud and Joy Relay only.
- **Esc stays in the chat.** Pressing Escape in a session aborts the running turn (or does nothing) instead of navigating you out mid-conversation. Subpages and the mouse back-button still go back.
- **Identicon styles.** Appearance → Identicons: pick between the hashicon mark, a square confetti grid, or a circular one — all drawn strictly from the joy logo palette, with live previews. Folder names in the session list are now bold in the standard text color. Identicons now align with session titles, and their size is adjustable (16–48px). The draft button is a plain pencil.
- **Relay access key.** Your relay can now require a perimeter key on every connection — strangers can't even create accounts on it. Set the key in Server Configuration; Happy Cloud and open relays need nothing.
- **Notification taps open the session.** Tapping a notification now lands you in the right conversation — on mobile (including cold start, which used to drop the tap) and on desktop (web notifications navigate on click; the Mac app jumps to the session when you activate it from a banner).
- **Desktop links fixed.** Links in chat are real links again — click to open in your browser; right-click/copy/cmd-click behave like a browser.
- **App Lock.** Optional Face ID / device-PIN lock (Settings): the app locks on launch and whenever it returns from the background. Turning it off requires authenticating too.

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
