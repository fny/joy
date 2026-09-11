# How joy works

joy lets you run coding agents on your own machines and drive them from your phone, a browser, or a desktop app. This page explains the three parts that make that possible, how a message travels between them, and the words the rest of these docs use.

## The three parts

joy is three programs. You run two of them yourself and use the third.

| Part | Where it runs | What it does |
|---|---|---|
| **The app** | Your phone, a browser, or the macOS desktop app | Shows your machines and sessions, lets you send messages, answer prompts, browse files, and read the terminal. |
| **The daemon** | Each computer you want agents on | Starts and watches agent sessions, types your messages into them, reads their output, and reports everything to the relay. Ships with the `joy` command-line tool. |
| **The relay** | One server you host or are given | Holds your account, your list of machines, the message queue for each session, and delivers push notifications. It passes encrypted data between the app and your daemons and cannot read it. |

The app and the daemons never connect to each other directly. Both connect out to the relay, so your machines do not need open ports, a public address, or a VPN. A laptop behind a home router works the same as a cloud server.

## How a message travels

When you send a message from the app:

1. The app encrypts the message on your device and hands it to the relay.
2. The relay adds it to that session's queue. It stays there, safely stored, even if the machine is off.
3. The daemon on the session's machine collects the next queued message as soon as the agent is free.
4. The daemon types it into the agent, exactly as if you had typed it at the keyboard.
5. As the agent works, the daemon reads its output, encrypts it, and sends it to the relay.
6. Every device signed in to your account receives the output and shows it.

It also works the other way. If you sit at the machine and type into the agent's terminal yourself, the daemon sees that too, and the conversation appears in the app.

Because the queue lives on the relay, you can send messages while a machine is asleep or offline. They run, in order, when it comes back.

## The words these docs use

| Word | Meaning |
|---|---|
| **Account** | Your identity on a relay. It is a secret key created on your device. Nothing else, no email or password. |
| **Backup code** | Your account's secret key written out as groups of letters (`XXXXX-XXXXX-…`). The app calls it your **Secret Key**. It signs in new devices and pairs new machines. |
| **Machine** | A computer running the daemon and paired with your account. |
| **Session** | One agent working in one folder on one machine, with its own conversation. A machine can run many sessions at once. |
| **Agent** | The coding tool a session runs, such as Claude Code or Codex. |
| **Turn** | One round of work: a message goes in, the agent works, the agent stops and waits. |
| **Queue** | Messages waiting for the agent to finish its current turn. Each session has its own. |
| **Relay** | The server your account lives on. Each app and each machine talks to exactly one relay. |

## Supported agents

joy drives these agents. Install and sign in to each one on the machine first, the same way you would to use it directly.

| Agent | Command on the machine | Notes |
|---|---|---|
| Claude Code | `claude` | Runs in a real terminal inside tmux. The session outlives a daemon restart, and you can attach to it with `joy jump`. |
| Codex | `codex` | Sign-in screens show up in the app, with the link and one-time code to finish in a browser. |
| OpenCode | `opencode` | Uses the models your OpenCode installation is configured for. |
| Pi | `pi` | Uses the providers your Pi installation is configured for. |
| Antigravity | `agy` | Runs each turn as its own `agy` process. Permission prompts are always skipped. |

Each session uses one agent for its whole life. Different sessions on the same machine can use different agents.

## What stays on your machine

Your code, your files, and your agents' credentials never leave the machine. The daemon runs the agent locally, in the folder you choose, as your user. The app reaches files, git status, and the terminal view through an encrypted connection to the daemon that passes through the relay. See [Security and privacy](../reference/security.md) for exactly what is encrypted and what the relay can see.

## Where to go next

- To set joy up for the first time, follow [Install and first run](install.md).
- To run your own relay, see [Self-hosting a relay](self-hosting.md).
- To learn the app, start with [Sessions](../guides/sessions.md) and [Messages and the queue](../guides/messages.md).

## Related

- [Install and first run](install.md)
- [Self-hosting a relay](self-hosting.md)
- [Security and privacy](../reference/security.md)
- [Command-line reference](../reference/cli.md)
- [FAQ](../reference/faq.md)
