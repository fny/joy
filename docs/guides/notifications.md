# Notifications

joy sends push notifications to your phone when a session needs you, when a session finishes its work, and when a machine runs low on resources. This page lists every reason a push is sent, how to quiet a session, and what a push contains, since push notifications are not end-to-end encrypted.

## Where pushes come from

Every push starts on the machine that runs the session. The daemon there decides that something is worth a notification, writes it, and hands it to the relay. The relay sends it to each phone signed in to your account through Expo's push service, which forwards it to Apple or Google.

Pushes reach phones where the app is installed, signed in, and allowed to notify. On a phone, a push that arrives while the app is open does not show a banner or play a sound.

Tap a push to open the session it is about.

## What sends a push

| Reason | Sessions | When |
|---|---|---|
| **A turn finished** | Claude Code | The agent finished and the session is now idle. |
| **Permission needed** | Claude Code | The agent is waiting for you to allow a tool call. |
| **The agent's own notification** | Claude Code, Codex, OpenCode | The agent decided something was worth telling you. |
| **This session is full** | All | The relay caps session length and this session reached the cap. |
| **Resource alerts** | Not tied to a session | A machine's memory, disk, or Claude or Codex quota crosses 90%. |
| **`joy notify`** | Not tied to a session | You or a script sent one from the command line. |

### A turn finished

When a Claude Code session finishes a turn and has nothing left to do, you get a push whose body reads **Finished**. It is only sent when the session is really idle:

- **Once per run of messages.** If you queued several messages, you get one push when the last of them finishes, not one per message. The push waits a few seconds after a turn ends; if the next queued message starts in that time, the push is dropped and the next turn's end decides instead.
- **Not while background work continues.** A turn that ends while subagents or background tasks are still running does not notify. The final turn, after they all finish, does.
- **Not on top of the agent's own notification.** If the agent already sent its own notification for that turn, there is no plain "Finished" as well. The agent's words are the notification.

### Permission needed

When a Claude Code session stops to ask permission for a tool call, you get a **Permission needed** push, once per request. This is sent even for headless sessions, because an unattended job that is waiting for a human is exactly what you need to hear about.

### The agent's own notification

joy teaches Claude Code, Codex and OpenCode a `<joy-notify>` tag. When the agent decides something is worth telling you, such as a long task finishing or a question it needs answered, it ends its reply with one:

```
<joy-notify message="Deploy finished" detail="Staging is green after 42 minutes" />
```

The push title is the project folder and the message ("my-project: Deploy finished"), and the body is the detail. Agents are told to use it only when something long or important finishes, or when they stop to wait on you; routine replies get no notification of their own. They are also told never to put secrets in it. See [Scripting and agent tags](scripting-and-agents.md) for the full tag vocabulary.

### This session is full

A relay can be set to cap how many events each session keeps; by default it does not. When a session reaches the cap, you get one push reading **This session is full**: the agent may still be running, but its output can no longer be saved. Continue the work in a new session.

### Resource alerts

Each daemon watches its own machine and your agents' account quotas, and sends an alert when one crosses 90%:

| Alert | Checked | Title | Body |
|---|---|---|---|
| Memory | Every 5 minutes | RAM high on my-laptop | 93% used, and a warning that sessions may misbehave |
| Disk | Every 5 minutes | Disk high on my-laptop | 91% full, 9.8 GB free of 466 GB |
| Claude quota | Every 4 hours | Claude 5-hour limit at 92% (or weekly) | When the window resets, and on which machine |
| Codex quota | Every 4 hours | Codex limit at 90% | Which window (5-hour or weekly), and on which machine |

Disk is measured on the disk that holds your home directory, where transcripts and caches live. Claude's quota is read from the machine's own Claude Code sign-in (the 5-hour and weekly windows); Codex's comes from Codex's own session logs.

Alerts are designed not to nag:

- An alert fires when the value **crosses** 90%. It fires again only after the value has dropped below 85% and risen past 90% once more.
- Each alert is sent at most **once every four hours**, however often the value crosses.

Resource alerts go to all your devices and are not affected by muting a session.

### `joy notify`

Send a push yourself, or from a script, through the machine's daemon:

```
joy notify -p "Backups verified" -t "nightly"
```

`-p` is the message and `-t` the title, which defaults to "Joy". The command prints how many devices it reached. See the [CLI reference](../reference/cli.md).

## Quieting notifications

### Mute a session

Session info → **Mute notifications** silences one session on every device. A muted session sends no pushes at all: no "Finished", no permission requests, and no notifications from the agent. It still shows its status in the list. Tap **Unmute notifications** to turn them back on.

### Headless sessions

A session started with `joy new --headless` is meant to run unattended, so it sends no "Finished" pushes and none of the agent's own notifications. It still sends **Permission needed**, and it still appears in the list while it waits for you.

### Turn off pushes on one device

Settings → Notifications → **Mobile push** turns pushes off for the phone you are holding. Turning it off removes the phone's registration from the relay, so nothing more is sent to it. If the relay can't be reached at that moment, the app keeps trying, and offers **Retry token removal** on the same screen.

Settings → Account lists every push token registered on your account. Tap an old one to delete it.

## What a push contains, and who can read it

Push notifications are **not** end-to-end encrypted. The title and body travel in plain text through your relay and Expo's push service, and through Apple or Google to your phone. Everything else joy sends is encrypted end to end; see [Security](../reference/security.md).

For that reason, the automatic pushes carry no conversation content by default:

| Push | Title | Body |
|---|---|---|
| A turn finished | The machine and folder, for example `my-laptop/my-project` | **Finished** |
| Permission needed | The machine and folder | **Permission needed** |
| The agent's notification | The folder and the agent's message | The agent's detail |
| Resource alert | What crossed the line, and on which machine | The figure and, for quotas, when the window resets |
| `joy notify` | Your title, or "Joy" | Your message |

A push about a session also carries the session's ID, so that tapping it opens the right session.

If you would rather see the first line of the agent's reply in "Finished" pushes, and accept that it passes through the relay and Expo in plain text, set `JOY_PUSH_SNIPPETS=1` in the daemon's environment and restart the daemon. It applies to that machine only.

The agent's own notifications always contain what the agent wrote. That is why agents are told never to put secrets in them.

## Related

- [The app](app.md)
- [Sessions](sessions.md)
- [Scripting and agent tags](scripting-and-agents.md)
- [Security](../reference/security.md)
- [CLI reference](../reference/cli.md)
- [Troubleshooting](../reference/troubleshooting.md)
