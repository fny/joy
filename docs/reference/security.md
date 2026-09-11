# Security and privacy

joy is built so that the relay, the one server in the system, cannot read your work. This page explains what is encrypted end to end, what the relay and push services can still see, how your backup code and machine keys work, and what joy's defaults let agents do on your machines.

## The short version

- Your code and files never leave your machines. Agents run locally.
- Everything the app and your machines exchange through the relay is encrypted on the sending device and decrypted on the receiving one.
- The relay sees who talks to whom and when, how much, and the state of each queue. It does not see what was said.
- Push notification text is not end-to-end encrypted. By default it carries the machine and folder name and a word such as "Finished", never conversation content.
- Your backup code is your account. Whoever holds it holds everything.
- Agents run with their permission prompts turned off by default. Treat a session like giving the agent your shell.

## What is encrypted end to end

Encrypted on your devices and machines, stored and forwarded by the relay as opaque data:

| Data | Who can read it |
|---|---|
| Messages you send and everything the agent produces (text, tool calls, results) | Your signed-in devices and the session's machine |
| Session details shown in the list: folder, title, agent, model, status details | Your signed-in devices and the session's machine |
| Your app settings, including pinned sessions and preferences | Your signed-in devices |
| Machine details: host name, system information, the daemon's reported state | Your signed-in devices and that machine |
| Images and files you attach to a message | Your signed-in devices and the session's machine |
| An automation's prompt and launch settings | Your signed-in devices and the target machine |
| Everything the app reads directly from a machine: files, git status, diffs, the terminal view, queue changes, provider keys you set | Your signed-in devices and that machine |

The last row travels through an encrypted tunnel between the app and the daemon. The relay forwards the bytes but never holds the key; both ends derive it independently.

joy uses libsodium's authenticated encryption (XSalsa20-Poly1305, with Curve25519 key exchange for wrapping per-session keys). Every session has its own key, wrapped so that only your account can open it.

## What the relay can see

To route and queue your work, the relay needs some facts in the clear:

- **Identifiers:** your account id, your machine ids, and session ids. These are random values, not names.
- **Timing and volume:** when each message and event was sent and how large it was, and how many events a session has.
- **Queue and lifecycle state:** whether a message is queued, delivered, running, finished, cancelled, or failed; whether a session is starting, active, or archived; which machine owns which session; whether each machine is online.
- **Automations:** each automation's **name and folder**, its trigger (manual, schedule with its cron expression and time zone, or after another automation), whether it is enabled, and each run's outcome and failure reason. The prompt is encrypted. Choose names accordingly.
- **Push tokens:** the addresses the push service uses to reach your devices.
- **Network details:** the IP addresses your devices and machines connect from, like any server.

The relay never sees your code, your prompts, the agent's replies, or file names inside your project. Folder and host names reach it in only two places: automations, above, and push notification titles, below.

## What push notifications expose

Push notifications go from the relay to Expo's push service, then to Apple or Google, then to your phone. Their title and body are visible to all three and to the relay. joy keeps them free of conversation content:

- **Title:** the machine's host name and the session's folder name, such as `my-laptop/my-project`.
- **Body:** a fixed phrase: `Finished`, `Permission needed`, or `Clarification needed`.

Two things put your own words into a notification:

- **An agent's `<joy-notify>` message.** Agents can send you a headline and detail when something needs your attention. Those fields are plaintext in the notification, so agents are told never to put secrets in them.
- **The opt-in reply preview.** Setting `JOY_PUSH_SNIPPETS=1` in a daemon's environment adds the first line of the agent's reply to its notifications. It is off by default, and it sends a slice of every reply through the relay and the push services.

Resource alerts (disk, memory, and usage limits) include the host name and the figures.

## Your backup code

Your account is a random 256-bit secret created on the first device you sign up on. There is no email, no password, and no copy on the relay. The backup code is that secret written as groups of letters. The app shows it in **Settings → Account → Backup** as your **Secret Key**.

From that one secret, each device derives your encryption keys and your sign-in identity. That is why:

- **It signs in anything.** A new device restored with it, or a machine paired with `joy auth`, gets full access to your account.
- **It works on any relay.** Restoring with it on a new relay creates the same account identity there, empty. Your sessions and machines stay on the relay where they were created.
- **Nobody can reset it.** Not the relay's owner, not the joy developers.

Store it in a password manager. Do not paste it into chats, issues, or agent sessions.

### If you lose it

- **If any device is still signed in,** open **Settings → Account → Backup** on it and save the code again.
- **If every device is gone,** the account cannot be recovered. Your machines keep their own credentials but not your account secret, so they cannot give it back. Create a new account, and pair your machines again with `joy auth`.

### If it leaks

Anyone with the code can read your sessions and send commands to your machines. Create a new account, sign your devices in to it, and run `joy auth` again on each machine with the new backup code so the machines leave the old account. Sessions stored under the old account stay readable to whoever holds the old code; delete the ones that matter from the app. On a relay you run, set a new access key.

## Linking devices without the code

To sign in a new device without typing the backup code, choose **Link or restore account** on it and scan the QR code it shows from a signed-in phone (**Settings → Account → Link New Device**). The signed-in phone approves the request and sends the account key to the new device, encrypted to a one-time key the new device generated. The relay only relays the encrypted handoff.

## Machine keys

When you pair a machine with `joy auth`, it gets its own credentials in `~/.joy/relays/<relay>/`: a sign-in token for the relay and a machine key. The daemon uses them to open the sessions it runs and the encrypted tunnel to your devices. The backup code itself is only held in memory while pairing and is not stored on the machine.

These files give access to that machine's sessions. Protect the machine and its home directory accordingly. Provider API keys you set with `joy env` are stored encrypted at `~/.joy/env.sealed`, with a key kept beside it on the same machine.

## The relay access key

A relay with `JOY_RELAY_ACCESS_KEY` set refuses every request that does not carry the key. It is a perimeter lock that decides who can use the server at all. It is separate from, and in addition to, the end-to-end encryption above. Without it, anyone who can reach the relay can create an account on it; they still cannot read yours. See [Self-hosting a relay](../getting-started/self-hosting.md#protect-the-relay-with-an-access-key).

## What agents can do on your machines

joy starts each agent in its own no-prompts mode unless you pick another:

| Agent | Default mode |
|---|---|
| Claude Code | `bypassPermissions` |
| Codex | `yolo` |
| OpenCode | `yolo` |
| Pi | `default` (Pi never asks) |
| Antigravity | `bypassPermissions` |

In these modes the agent runs commands and edits files without asking first, with your user's permissions, in the folder you chose and beyond. That is what makes working from a phone practical, and it is also the main risk. Choose a stricter mode per session or change the defaults in **Settings**, run agents in a machine or container that holds only what they need, and keep secrets out of project folders. See [Sessions](../guides/sessions.md).

Anyone who can sign in to your account can start sessions and send commands to every paired machine. Protecting your backup code protects your machines.

## Related

- [How joy works](../getting-started/overview.md)
- [Self-hosting a relay](../getting-started/self-hosting.md)
- [Notifications](../guides/notifications.md)
- [Sessions](../guides/sessions.md)
- [FAQ](faq.md)
