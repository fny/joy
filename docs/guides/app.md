# The app

The joy app runs on iOS, Android, the web, and macOS. It shows every session on every machine you have paired, lets you read and steer them, and keeps its preferences in sync across your devices. This page is a tour: the session list, the session screen, the machine page, and each settings screen, followed by what syncs, the desktop app, and how updates arrive.

## The session list

The list is the app's home screen. On a phone it is the first screen; on a tablet, the web and the desktop app it is the sidebar next to the open session.

### Active sessions, grouped by machine

Sessions whose agent is running sit at the top, grouped under a header for each machine. Each machine header shows the machine's name and its CPU and memory load.

- Tap the machine's **name** to open its [machine page](#the-machine-page).
- Tap anywhere else on the header to collapse or expand that machine. A collapsed machine shows how many sessions it holds and a coloured dot for the one that most needs you.

Which machines are collapsed is remembered per device: a phone usually wants more folded away than a wide desktop.

### Archived sessions

Sessions whose agent has stopped are history. They sit below a **Show archived** divider; tap it to reveal them and **Hide archived** to fold them away again.

### Headless sessions

Sessions started with `joy new --headless` are kept out of the list so unattended jobs don't crowd it. A **Show headless** divider reveals them. A headless session that needs a human, for example to approve a tool call, always appears in the list whatever the toggle says.

### What the colours mean

Every row has a status dot, and the status line under the title says the same thing in words.

| Colour | Meaning |
|---|---|
| Yellow | Needs you: a permission request, a prompt or dialog in the terminal, or a sign-in. Pulses while a permission request is waiting. |
| Green | New results you have not read yet. |
| Blue, pulsing | The agent is working on a reply. |
| Teal, pulsing | Idle, with background tasks still running. |
| Pink, pulsing | Idle, with subagents still running. |
| Purple, pulsing | Compacting the conversation. |
| Orange | Retrying a failed request (pulsing), or a turn that has produced no output for a long time (steady, "no output for Nm"). |
| Grey | Online and idle, and you have seen it. |
| Red | Detached: the agent process has exited. |
| Light grey | Offline: the machine cannot be reached. |

### The new session list

Settings → Features → **New session list** turns on an experimental list with pinning and more structure. It is off by default and the switch is per device.

With it on:

- **Pinned** sits at the top. Long-press a session (right-click on the web and desktop) and choose **Pin**; choose **Unpin** to remove it. Pinned rows are compact: project name first, then the session title.
- Tap the **Pinned** header to switch its order between **by state** (the default: what needs you first, then unread, then working, then idle, then errors, then offline) and **by project** (alphabetical by project name).
- **Automation failures** appears above Pinned when an automation run fails, and stays until you dismiss the failure. See [Automations](automations.md).
- Running automation sessions sit under their own **Show automations** divider.
- Archived sessions under **Show archived** are grouped under the same machine rows as live sessions. Each group folds on its own: folding a machine's archived sessions leaves its live ones open, and the reverse.

Settings → Appearance has a **Pinned rows** group for the pinned identicon's shape and size, separate from the identicons in the rest of the list.

### The row menu

Long-press a session (right-click on the web and desktop) for its menu. Depending on the session and its agent you get:

- **Details** — the session info screen.
- **Pin** / **Unpin** — with the new session list on.
- **Resume Session** or **Restart session** — bring a stopped session back in a fresh terminal, continuing its conversation.
- **Fork session** — a new session that continues from the last message.
- **Teleport** — continue the conversation on another machine.
- **Archive** and **Delete**.

## The session screen

### Chat

The chat shows your messages, the agent's replies, and its tool calls. A few things to know:

- **Thinking.** When the agent uses extended thinking, each thinking block appears as a collapsed row; tap it to read. Turn this off with Settings → Features → **Show thinking**.
- **Tool calls.** Settings → Features → **Group Tool Calls** collapses runs of consecutive tool calls into one container. Settings → Appearance → **Inline Tool Calls** shows them directly in the chat.
- **Answer chips.** When the agent offers a set of answers, they appear as buttons under its reply. Tap one to send it, or type your own.
- **Images.** Images the agent shows appear inline; tap to zoom.

Sending, queueing, editing and stopping are covered in [Messages and the queue](messages.md).

### Session info

Tap the session's title to open its info screen. It shows the live model, effort and process details, and the actions:

- **Processes** — every process under the agent, with CPU and memory.
- **Open Terminal** — the live terminal, with raw key input.
- **Restart Session**, **Fork**, **Hand off to…**, **Teleport**.
- **Mute notifications** — silence this session's pushes on every device.
- **Reload Chat** — refetch this chat from scratch, for history that won't load.
- **Usage & Cost** — cost for this conversation, computed on the machine.
- **Download Session Log** — the raw transcript file from the machine.
- **Kill & Archive** and **Delete Session**.

### The terminal

**Open Terminal** shows the agent's actual terminal window as it runs on the machine, and lets you type into it directly. Use it for things the chat can't express: a dialog the agent is stuck on, a sign-in screen, or anything you would normally do at the keyboard.

### Files and changes

Tap the git status badge in the composer's info row to open the session's files. The screen has three modes:

- **Changes** — staged and unstaged changes in the session's repository, with a diff for each file. The diff view can be **Unified**, **Split** (web and desktop) or **Whole file**.
- **All Files** — browse and search the project, open any file, and edit it.
- **Session files** — uploads you attached to messages and images the agent showed. These live in the session's own folder on the machine, outside your project, so they never end up in your repository.

On the desktop, Settings → Features → **File Diffs Sidebar** shows git changes next to the chat.

## The machine page

Open a machine from its header in the list, or from Settings → Machines. It shows:

- **Daemon** — the daemon's version, process, uptime, operating system and the Claude CLI it found. When a reboot has taken sessions with it, a **Restore N sessions** row brings them back, each resuming its conversation.
- **Machine** — name (tap to rename), host, home directory and machine ID.
- **System** — live CPU, memory and disk. Memory and disk turn red at 90%.
- **Environment** — provider keys, such as API keys for a model provider, that every new session on this machine inherits. They are stored sealed on the machine; values never come back to the app.
- **Slash commands** — the commands and skills the daemon found on this machine, which appear in the composer's `/` menu. **Refresh** re-scans them.
- **Go to** — **Projects**, **Sessions**, **New Session** and **Usage & Cost**.
- **Daemon actions** — **Restart Daemon** (running sessions survive), **Kill all Sessions**, and **Purge and kill all Sessions**.

**Projects** lists every folder the machine has worked in, most recent first. A project that lost sessions to a reboot offers **Restore latest session**, which brings back only its newest one.

Settings → Machines also has:

- **Cleanup** — clean up detached sessions, purge a machine's records, or delete a machine.
- **Storage** — what each session leaves on the machine's disk and on the relay, biggest first. Select any number and delete them in one press.

## Settings

The settings screens, in the order they appear:

| Screen | What it does |
|---|---|
| **Scan QR code to authenticate** | Phones only. Approve a terminal or another device that shows a QR code. |
| **Account** | Your account status, **Link New Device**, the relay this device talks to (tap the lock to set a relay password), your **Secret Key** backup, registered push tokens, and **Logout**. |
| **Sessions** | Manage sessions machine by machine. |
| **Machines** | Your machines, plus **Cleanup** and **Storage**. |
| **Automations** | Saved work: a folder, a prompt and a trigger. See [Automations](automations.md). |
| **Relays** | The relay this device uses, its access key, and **Change relay**. Changing relay signs this device out first; your account stays on the old relay and your backup code restores it there. |
| **Appearance** | Theme, colour palette, identicon style and size, **Pinned rows**, language, chat font size, and display options for tool calls, todo lists and diffs. |
| **Notifications** | **Mobile push** on or off for this device. See [Notifications](notifications.md). |
| **Agent Defaults** | Default model, effort and permission mode for each agent, used when a session starts without one. |
| **Models** | Which models each agent's pickers offer. **Recommended only** shows the daemon's short list; **Enable all** shows everything. |
| **Agent Config** | Edit each agent's own config file on a machine, field by field or as raw text. |
| **Voice** | Your ElevenLabs voice agents and how voice behaves. See [Voice](voice.md). |
| **Features** | Feature switches: **File Diffs Sidebar**, **Group Tool Calls**, **Chat history limit**, **Show thinking**, **Double tap**, the experiments (including **New session list**), and on the web **Enter to Send** and **Command Palette** (⌘K). |
| **Usage** | Token usage and estimated cost. See [Usage and limits](usage-and-limits.md). |
| **Limits** | Live account quota windows for Claude and Codex. |
| **Relay** | The relay server as it reports itself: version, uptime, CPU, memory, disk, database size, and how many daemons are connected. |
| **App Lock** | Phones only. Require Face ID or the device PIN to open the app. |
| **What's New** | The release notes for every app update. |

## What syncs across your devices

Your account settings are stored on the relay, encrypted with your account key, and every signed-in device reads them. They include your pins, whether archived sessions are hidden, agent defaults, the models each picker offers, your voice agents, and most display options for chat, tool calls and diffs. A change on one device appears on the others within about half a minute, or as soon as the other app comes to the foreground.

Some preferences are deliberately per device:

- the theme, colour palette and chat font size
- which machine sections are collapsed
- the pinned order (by state or by project)
- **Show headless** and **Show automations**
- **New session list**, **Show thinking** and the other experiments
- identicon sizes and the pinned-row shape
- **App Lock**

## The desktop app

The macOS desktop app is a native shell around the web app. It loads the same app you use in a browser, so app updates reach it without a new download; reload the window (⌘⇧R) to pick up an update straight away.

Desktop and web add a few things phones don't have: split diffs, the file diffs sidebar, **Enter to Send**, and the ⌘K command palette. On the web you can paste or drag images into the composer to attach them. Dragging images onto the desktop app needs a desktop build that includes drag-and-drop support.

## Updates and What's New

App updates are delivered over the air: new versions arrive without going through an app store.

- Settings → **Check for updates** downloads the latest update and restarts the app with it.
- Settings → **JS Update** shows which update you are running; tap it to copy its full ID.
- Settings → **What's New** lists the changes in each update, newest first.

Some changes also need an updated daemon on your machines. The release notes say so when they do; see [Installing joy](../getting-started/install.md) for how to update a daemon.

## Related

- [Messages and the queue](messages.md)
- [Sessions](sessions.md)
- [Notifications](notifications.md)
- [Usage and limits](usage-and-limits.md)
- [Voice](voice.md)
- [Troubleshooting](../reference/troubleshooting.md)
