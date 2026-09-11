# Install and first run

This page takes you from nothing to a working setup: a relay to connect to, an account in the app, the daemon installed and paired on a machine, and your first session. It then covers updating, adding more machines, and signing in on more devices.

## Before you start

You need three things:

- **A relay address.** joy has no built-in server. Either run your own (see [Self-hosting a relay](self-hosting.md)) or use one someone runs for you. A relay address looks like `relay.example.com` or `relay.example.com:4997`.
- **A computer to run agents on.** Linux or macOS. This is where your code lives and where the agents run.
- **A device to control it from.** A browser, the macOS desktop app, or a phone.

On the computer, install:

| Requirement | Version | Why |
|---|---|---|
| Node.js | 22.13 or newer | Runs the daemon. |
| pnpm | 10 or newer | Installs and updates the daemon. |
| tmux | any recent version | Every session runs inside tmux. |
| At least one agent | latest | For example `claude` (Claude Code), signed in. |

## 1. Open the app

Choose any of these. They are the same app and share your account.

- **Web:** open [https://joy.expo.app](https://joy.expo.app) in a browser.
- **macOS desktop:** the desktop app loads the same web app in its own window. Build it from `packages/joy-app` in the repository.
- **iOS and Android:** build from `packages/joy-app` in the repository with Expo.

## 2. Create your account

1. On the welcome screen, enter your relay address under **Relay** and tap **Continue**. A bare address such as `relay.example.com` is treated as `https://relay.example.com`.
2. If the relay is protected, the app asks for its **Relay access key**. Enter the key the relay's owner gave you.
3. Tap **Create account**.

Your account is a secret key generated on your device. There is no email and no password.

**Save your backup code now.** Open **Settings → Account**, find **Backup**, and tap to reveal your **Secret Key**. Copy it into a password manager. It is the only way to:

- pair a machine with your account,
- sign in on a new device if no signed-in device is at hand,
- get your account back if you lose every device.

Anyone who has this code has full access to your account, so treat it like a master password.

## 3. Install the daemon

On the computer where your agents will run:

```bash
CI=1 pnpm add -g "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon"
```

`CI=1` stops pnpm from asking which packages to build. The daemon needs no build step.

Check that everything it needs is present:

```bash
joy doctor
```

`joy doctor` lists Node, tmux, `claude`, the relay, your pairing, and whether the daemon is running. It is normal for the relay and pairing lines to fail until you finish the next step.

## 4. Pair the machine

```bash
joy auth relay.example.com
```

Paste your backup code when asked. The machine now belongs to your account and talks to that relay. `joy auth` also prints a **relay perimeter key**; you only need it if you run the relay yourself and want to protect it (see [Self-hosting a relay](self-hosting.md#protect-the-relay-with-an-access-key)).

A machine talks to exactly one relay. Running `joy auth` again with a different address moves it.

## 5. Start the daemon

Install it as a service so it starts at login and restarts if it stops:

```bash
joy install
```

On Linux this installs a systemd user service named `joy-daemon`. For it to keep running when you are not logged in, enable lingering once:

```bash
loginctl enable-linger $USER
```

On macOS it installs a launchd agent at `~/Library/LaunchAgents/joy-daemon.plist`.

Run `joy doctor` again. Every line should pass. Within a few seconds the machine appears in the app's sidebar.

## 6. Start your first session

**From the app:** tap **New session**, choose the machine, pick or type a folder, choose an agent, and send your first message. If the folder does not exist, the app asks whether to create it.

**From the terminal:**

```bash
joy new ~/code/my-project -m "Read the README and summarize this project"
```

`joy new` prints the new session's id. The session appears in the app right away, and you can continue it from either place. Add `--agent codex` (or `opencode`, `pi`, `agy`) to use a different agent.

To see what is running on the machine:

```bash
joy ls
```

## Updating

Update the daemon on each machine with:

```bash
joy update
```

It installs the latest release, reinstalls the service, and restarts the daemon. Running sessions keep running through the restart.

The web and desktop app update themselves. The app's **What's New** page lists recent changes.

## Adding more machines

Repeat steps 3 to 5 on each computer: install, `joy auth` with the same relay and the same backup code, then `joy install`. Every machine shows up in the app under its own heading.

## Signing in on more devices

On the new device, open the app, enter the same relay, and tap **Link or restore account**. Then either:

- **Link from a signed-in device.** The new device shows a QR code. On a phone that is already signed in, go to **Settings → Account**, tap **Link New Device**, and scan it.
- **Use your backup code.** Tap **Restore with Secret Key Instead** and paste the code.

Your settings, pinned sessions, and preferences sync between devices.

## Changing relay

To point the app at a different relay, go to **Settings → Account**, tap your relay under **Relay**, and choose **Change relay**. This signs the device out first. Your account stays on the old relay; to return, enter that relay again and restore with your backup code. Sessions and machines belong to the relay they were created on and do not move with you.

## Related

- [How joy works](overview.md)
- [Self-hosting a relay](self-hosting.md)
- [Sessions](../guides/sessions.md)
- [Command-line reference](../reference/cli.md)
- [Troubleshooting](../reference/troubleshooting.md)
- [Security and privacy](../reference/security.md)
