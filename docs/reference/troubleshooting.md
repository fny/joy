# Troubleshooting

This page lists problems the way you notice them, with the likely cause and the fix. Most fixes start on the machine that runs your agents, with the `joy` command. If a problem is not listed here, `joy doctor` is the best first step: it checks Node, tmux, the agent CLIs, the relay pairing, and the daemon.

```bash
joy doctor     # environment: node, tmux, claude, relay pairing, daemon
joy status     # is the daemon running, which version, which relay
joy ls         # every session and its state: idle, busy, needs input
```

## Where the daemon's logs are

The daemon writes its log to a different place depending on how it runs.

| How the daemon runs | Where to read the log |
|---|---|
| Installed service on Linux (`joy install`) | `journalctl --user -u joy-daemon` |
| Installed service on macOS (`joy install`) | `~/.joy/relays/<relay>/state/daemon.log` |
| Started by hand with `joy start` | `~/.joy/relays/<relay>/state/daemon.log` |

`<relay>` is your relay's host name, with the port after an underscore when the address has one, for example `relay.example.com_4997`.

## joy says "no relay configured"

This machine is not paired with a relay yet. Every command that talks to the relay stops with:

```
no relay configured — pair this machine first: joy auth <relay url>
```

Pair it with your relay and your account's backup code, then install the service so the daemon starts on its own:

```bash
joy auth relay.example.com:4997
joy install
```

See [Install](../getting-started/install.md) for the full pairing steps.

## The daemon won't start, or "another joy-daemon daemon is already running"

Only one daemon may run on a machine. If an older daemon process is still alive, a new one refuses to start and logs:

```
another joy-daemon daemon is already running (pid 12345); refusing to start a second daemon.
```

This can happen after a restart where the old process did not exit. Your sessions are not affected, because they live in tmux, not in the daemon.

1. Run `joy status` and note the pid it reports.
2. If the service keeps restarting, stop the leftover process: `kill 12345`.
3. The service starts a fresh daemon within a few seconds. Check with `joy status`.

To restart the service yourself:

```bash
# Linux
systemctl --user restart joy-daemon

# macOS
launchctl kickstart -k gui/$(id -u)/joy-daemon
```

`joy restart` also works. It asks the running daemon to replace itself, and running sessions survive.

## My relay won't start: "refusing to start: JOY_RELAY_DOCS_TOKEN is not set"

A relay must be given a password for its API docs page, or be told to serve none. It checks this before anything else and exits when it has neither.

Set a password, or turn the page off, in the relay's environment and start it again:

```bash
JOY_RELAY_DOCS_TOKEN=$(openssl rand -base64 18)   # or: JOY_RELAY_DOCS=off
```

In a container, pass it with `-e` on `podman run`, in the Quadlet unit's environment file, or in the Compose `.env` file. See [Self-hosting a relay](../getting-started/self-hosting.md#choose-a-docs-password).

## Sessions show "offline" or "last seen"

The app shows a session as offline when its machine's daemon has stopped talking to the relay. The daemon is not running, the machine is asleep or off, or the machine lost its network.

1. On the machine, run `joy status`. If it says `joy-daemon daemon not running`, start the service (see above) or run `joy start`.
2. If the daemon is running but the app still shows it offline, read the log for relay errors. A wrong relay address, or a relay that requires an access key the machine does not have, both show up there.

In the session list, **Show offline machines** reveals machines that are currently offline so you can check when each was last seen.

## My message says "queued" and never runs

The relay keeps your message until the session's machine takes it. A message waits when:

- **The machine is offline.** The message runs when the daemon comes back. Fix the daemon first (see above).
- **A turn is still running.** Messages run one at a time, in order. Wait, or tap stop to end the current turn.
- **The queue is paused.** If the daemon could not type a message into the agent cleanly, it pauses the queue rather than guess. The strip above the composer says so, for example "A queued message didn't send — tap to resume" or "The session's input box has stray text — tap to clear and resume". Tap the strip, or run:

  ```bash
  joy queue 1a2b3c4d          # see what is queued
  joy queue 1a2b3c4d resume   # release a paused queue
  ```

- **The daemon crashed in the middle of a turn.** When it comes back, it checks the turn it left behind. It picks the turn up again if the agent is still working, and closes it as interrupted if the agent is gone. Anything queued behind it then runs. If nothing moves after the daemon is back, restart the daemon once.

`joy check 1a2b3c4d` tells you what the session is doing right now. It exits `0` when idle, `3` when busy, and `6` when it needs input.

## A session is waiting on a prompt, a dialog, or a sign-in

Some agent prompts need a person. The app shows them at the top of the chat:

- **ACTION NEEDED** is a question from the agent's own interface, for example a confirmation. Answer it in that bar.
- **SIGN IN** means the agent CLI needs you to log in. The bar has the login link and a field for the code. Open the link, sign in, and submit the code.
- The session status reads `permission required`, `sign-in required`, or `waiting in terminal` while it waits.

The daemon answers Claude Code's first-launch folder-trust prompt for you, so a new session does not stop there.

To see or answer what the agent shows in its terminal:

```bash
joy pane 1a2b3c4d     # print the terminal view as text
joy jump 1a2b3c4d     # attach to the session's tmux window
```

## Codex needs sign-in

When Codex needs you to log in, the app shows a **SIGN IN TO CODEX** bar with a link and a one-time code. Open the link, sign in, and enter the code there. The session status reads `sign-in required` until the sign-in completes. If Codex reports that its access token could not be refreshed in the middle of a conversation, sign in the same way.

## History renders empty

If a chat shows no history, or stops loading older messages, drop this device's copy of the chat and fetch it again. Tap the session title to open session info, then tap **Reload Chat**. This affects only this device. It does not change the session.

## The app says "connecting" forever

The app cannot reach the relay.

1. Check the relay address. Open Settings and look at the relay row. To use a different relay, use **Change relay**, which signs this device out first. Your account stays on the old relay, and your backup code restores it.
2. If your relay requires an access key, set it in Settings → Account (the lock on the relay row). Without it, a gated relay refuses every request.
3. Check that the relay itself is up. If you run your own, see [Self-hosting](../getting-started/self-hosting.md).

## I get too many notifications, or none at all

**Too many.** To silence one session on every device, tap its title to open session info and tap **Mute notifications**. It still shows its status in the list. Sessions you start with `joy new --headless` send no "finished" notification, but still notify when they need a person. A run of queued messages sends one "finished" notification, after the last one ends.

**None at all.**

1. In Settings → Notifications, check that **Mobile push** (phone) or **Desktop notifications** (web and desktop app) is on, and that the operating system allows notifications for the app.
2. Check that the session is not muted.
3. Send a test from the machine:

   ```bash
   joy notify -p "test from my machine"
   ```

See [Notifications](../guides/notifications.md) for what triggers each notification.

## A session disappeared after a reboot

A daemon crash loses nothing, because sessions live in tmux, and tmux outlives the daemon. A machine reboot stops tmux and the agents in it. The daemon remembers which sessions were running, and can bring them back with their conversations.

- In the app, open the machine's page and tap **Restore N sessions**. To bring back only the newest session of one folder, open the machine's Projects list and tap **Restore latest session** on that folder.
- From the machine:

  ```bash
  joy restore --dry-run   # see what would come back
  joy restore             # bring them all back
  joy restore 1a2b3c4d    # bring back one
  ```

A session that is still running is never offered, so restore cannot put two agents in one folder.

## "This session is full"

The relay keeps a fixed number of events for each session. When a session reaches it, the relay refuses new output for that session. The agent can keep working, but nothing new it produces is saved, and messages you send there are refused. The status reads `output dropped — session full`. This does not recover by itself. Start a new session in the same folder and continue there.

## Updates don't show up

**The app.** Mobile app updates arrive over the air. Open Settings → About and tap **Check for updates**. The app downloads the update and restarts. The desktop app loads the latest version when it starts, so quit and reopen it.

**The daemon.** If the app says "This machine's daemon is out of date — run `joy update` on it", run this on that machine:

```bash
joy update
```

It installs the latest daemon, reinstalls the service, and restarts it. Running sessions survive.

## Related

- [CLI reference](cli.md)
- [Install](../getting-started/install.md)
- [Sessions](../guides/sessions.md)
- [Messages and the queue](../guides/messages.md)
- [Notifications](../guides/notifications.md)
- [FAQ](faq.md)
