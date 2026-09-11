# joy documentation

joy lets you run coding agents on your own machines and drive them from your phone, the web, or your desktop. An agent such as Claude Code or Codex runs in a terminal session on your computer; joy mirrors that session to every device you use, end-to-end encrypted, so you can read what it is doing, answer its questions, queue the next task, or stop it from wherever you are.

These pages are for people using joy. If you want to work on joy itself, start with the [repository README](../README.md).

## Start here

1. [Overview](getting-started/overview.md): the three parts of joy, and how a message gets from your phone to an agent and back.
2. [Install](getting-started/install.md): pick a relay, create your account, install the daemon on a machine, and start your first session.
3. [Self-hosting a relay](getting-started/self-hosting.md): run the one server joy needs, with Podman or plain Node, behind TLS.

## Guides

| Page | What it covers |
|---|---|
| [Sessions](guides/sessions.md) | Starting agents, choosing a model and permission mode, headless sessions, archiving, and restoring after a reboot |
| [Messages and the queue](guides/messages.md) | Sending, the queue, steering a running turn, stopping, attachments, slash commands |
| [The app](guides/app.md) | The sidebar, the session view, the machine page, settings, and what syncs across your devices |
| [Automations](guides/automations.md) | Saved prompts that run on demand, on a schedule, or after one another |
| [Notifications](guides/notifications.md) | What sends a push and when, muting, resource alerts, and what a push reveals |
| [Usage and limits](guides/usage-and-limits.md) | The "% left" in the composer, account quota windows, and cost by project and model |
| [Voice](guides/voice.md) | Talking to your sessions through your own ElevenLabs agent |
| [Scripting and agents](guides/scripting-and-agents.md) | Driving joy from scripts and from agents, messages between sessions, and the tags an agent can write |

## Reference

| Page | What it covers |
|---|---|
| [Command line](reference/cli.md) | Every `joy` command, flag, and exit code |
| [MCP server](reference/mcp.md) | Your joy account as an MCP server for the Claude app and Claude Code |
| [APIs](reference/api.md) | The daemon's local REST API and the relay's protocol, for when the CLI is not enough |
| [Security](reference/security.md) | What is encrypted, what the relay and push services can see, and your backup code |
| [Troubleshooting](reference/troubleshooting.md) | Symptoms, causes, and fixes |
| [FAQ](reference/faq.md) | Short answers to common questions |

## The short version

- **There is no joy service.** joy has no default relay. You run one, or use one run by someone you trust, and it stores and forwards ciphertext plus the routing data it needs.
- **Your agents keep running without you.** They run on your machine, so closing the app or losing signal never touches them. Claude Code and Codex sessions live in tmux and outlive a daemon restart too.
- **Every device sees the same thing.** Type in the terminal, send from your phone, or queue from your laptop; all of it lands in the same session and shows up everywhere.
