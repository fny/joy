# FAQ

Short answers to the questions people ask most. Each answer links to the page with the details.

## Is my code sent to your servers?

No. joy has no built-in server. You connect the app and your machines to a relay that you run, or one that someone you trust runs for you. Conversation content, session details and files are end-to-end encrypted between your devices and your machines, so the relay stores and forwards data it cannot read. See [Security](security.md).

## Do I need to keep my computer on?

Yes, while you want work to happen. Your agents run on your own machine, so a machine that is off or asleep runs nothing. Messages you send in the meantime wait on the relay and run when the machine's daemon comes back.

## Does it work with an agent I already started in a terminal?

Not with a process that is already running outside joy. joy starts each agent itself so that it can send it messages and read what it does. Claude Code and Codex run in their own tmux window, which also keeps them alive across daemon restarts. You can pick up an earlier conversation in a new joy session with `joy new <dir> --continue` or `--resume <id>`, and you can use any joy session from a terminal with `joy jump`. See [Sessions](../guides/sessions.md).

## Can I use it from several phones and computers at once?

Yes. Every device signed in to your account sees the same sessions, live. What you send from one device, and what you type into the terminal directly, appears on all of them. Your app settings, such as pinned sessions, sync across devices too. See [The app](../guides/app.md).

## What happens to a running agent if the daemon restarts?

For Claude Code and Codex, nothing. They run in tmux, which keeps running while the daemon restarts or updates, and the new daemon finds each session again and carries on where the old one stopped. OpenCode, Pi and Antigravity run as processes of the daemon itself, so a restart ends them; see [Sessions](../guides/sessions.md#after-a-reboot).

## What happens if the machine reboots?

A reboot stops tmux and the agents in it. The daemon remembers which sessions were running, and `joy restore`, or **Restore N sessions** on the machine's page in the app, brings them back with their conversations. See [Troubleshooting](troubleshooting.md#a-session-disappeared-after-a-reboot).

## Which agents are supported?

Claude Code, Codex, OpenCode, Pi and Antigravity. You choose the agent when you create a session, in the app or with `joy new --agent`. The agent's own CLI must be installed and signed in on the machine. See [Sessions](../guides/sessions.md).

## Can two agents talk to each other?

Yes. An agent inside a joy session can use the `joy` command to send a message to another session, or ask it something and wait for the reply. joy marks each such message with the session it came from, and the app shows who sent it. See [Scripting and agents](../guides/scripting-and-agents.md).

## What does it cost?

joy is open source under the MIT license and costs nothing. You pay for the agents you use, through your own subscriptions or API keys, and for wherever you host your relay.

## Can I self-host everything?

Yes, and you have to host the relay, because there is no default one. The relay is one small Node process, with a container image you can build with Podman or Docker from the repository. The daemon runs on your own machines, and you can build the app yourself from source. See [Self-hosting](../getting-started/self-hosting.md).

## Why tmux?

tmux keeps an agent running when nothing is attached to it, and it lets more than one thing use the same terminal. The daemon types your messages into the agent's real interface and reads what it shows, and you can attach to the same window yourself with `joy jump`. Because tmux outlives the daemon, restarting or updating the daemon never interrupts an agent.

## What is the backup code, and what if I lose it?

The backup code is your account's secret key. It signs your devices in, pairs your machines with `joy auth`, and brings your account back if you change relay or reinstall the app. Your data is encrypted with it, so nobody, including whoever runs the relay, can recover it for you. If a device is still signed in, you can see the key again under Settings → Account. Store it in a password manager. See [Security](security.md).

## Why do notifications say so little?

Notification text travels outside end-to-end encryption, through the relay and the phone's push service. So by default a notification says only which machine and folder it is about, and why: finished, permission needed, or a message the agent chose to send. Open the notification to read the conversation. See [Notifications](../guides/notifications.md).

## Does it work offline?

The app needs a connection to the relay to send and receive. If you send while your device is offline, the app keeps the message and sends it when you are back online. The agents themselves need whatever connection they need to reach their model provider.

## How do I update?

The app updates itself: on mobile, Settings → About → **Check for updates**; the desktop app loads the latest version each time it starts. On each machine, run `joy update`. It installs the latest daemon and restarts it without interrupting your sessions. See [Troubleshooting](troubleshooting.md#updates-dont-show-up).

## Where are the files I upload?

Files and screenshots you attach to a message go to `~/.joy/sessions/<session id>/uploads/` on the session's machine, not into your project folder. The message gives the agent the file's full path. In the app, the session's Files view lists them under **Session files**. See [Messages and the queue](../guides/messages.md).

## Can I use it without the phone app?

Yes. The web app and the macOS desktop app work like the phone app, and show desktop notifications instead of push notifications. You can also drive sessions entirely from a terminal with the `joy` command. See [CLI reference](cli.md).

## Is Android supported?

The app is built with Expo, and the project includes Android targets, but no Android build has been published. You can build and install it yourself from `packages/joy-app`.

## Can I use joy from Claude or another MCP client?

Yes. joy-mcp is an MCP server that acts as a client of your account. It can list your sessions, send and ask, approve or deny tool calls, and start new sessions. See [MCP](mcp.md).

## How is joy related to Happy Coder?

joy started as a fork of Happy Coder. It is now its own system, with its own daemon, relay and protocol, and it does not work with Happy servers or clients.

## Related

- [Overview](../getting-started/overview.md)
- [Install](../getting-started/install.md)
- [Troubleshooting](troubleshooting.md)
- [Security](security.md)
