# CLI reference

The `joy` command controls the daemon on one machine and drives the agent sessions it runs. You use it to pair the machine with a relay, install the daemon as a service, start and inspect sessions, and script them: send a message, wait for the reply, answer an approval. This page lists every command and flag. For task-oriented walkthroughs, see [Getting started](../getting-started/install.md) and [Scripting and agents](../guides/scripting-and-agents.md).

## Basics

### One machine, one relay

Each machine talks to exactly one relay: the one you paired it with using `joy auth <relay url>`. There is no built-in relay. Until the machine is paired, only `help`, `auth`, `doctor`, `update`, `uninstall` and `notify` run; every other command stops with:

```text
✗ no relay configured — pair this machine first: joy auth <relay url>
```

and exits with code 2.

### Naming a session

Most commands take a `<session>` argument. You can give:

- the joy session id, for example `1a2b3c4d`;
- the agent's own conversation id (Claude Code's session id);
- a unique prefix of either, for example `1a2b`.

A prefix that matches more than one session is an error; the command lists the matches. `joy ls` shows every id.

`joy jump` also accepts a folder path or a folder name. See [jump](#jump).

### Exit codes

Every command uses the same codes, so a script can branch on them.

| Code | Meaning |
|---|---|
| 0 | Success. For `check`: the session is idle. For `ask`: answered. |
| 1 | Error, or the session is gone. |
| 2 | Usage error, or the machine is not paired with a relay. |
| 3 | Busy: `send --no-queue` found work in flight, or `check` found a turn running. Also an `ask` that would deadlock. |
| 4 | Timeout. |
| 5 | Mode: `--no-queue` needs a session in its no-prompts or read-only mode. |
| 6 | Needs input: the session waits on an approval, a question, a sign-in or a dialog. |

### Environment variables

| Variable | Effect |
|---|---|
| `JOY_RELAY_URL` | The relay this machine talks to. Overrides `~/.joy/relay.json`. The installed service sets it. |
| `JOY_HOME_DIR` | The joy home directory. Default `~/.joy`. A different value is a separate, isolated joy: its own pairing, state and sessions. |
| `JOY_SESSION_ID` | Set by the daemon inside every agent session. The CLI uses it to stamp who sent a message (see [send](#send)). You do not set it yourself. |
| `JOY_RELAY_ACCESS_KEY` | The relay's perimeter key, for a relay that is gated. Normally `joy auth` stores it for you. |
| `PORT` | The daemon's local port when no `daemon.json` exists yet. Default 4997. |

### Files

| Path | Contents |
|---|---|
| `~/.joy/relay.json` | The relay this machine talks to. Written by `joy auth` and `joy install`. |
| `~/.joy/relays/<host>_<port>/` | The pairing with that relay: `access.key`, `settings.json` (holds the machine id), and `perimeter.key` for a gated relay. |
| `~/.joy/relays/<host>_<port>/state/daemon.json` | The running daemon's pid, port and control token. Owner-only. |
| `~/.joy/relays/<host>_<port>/state/daemon.log` | The daemon's log when it runs detached or under launchd. |
| `~/.joy/sessions/<id>/` | Per-session files: uploads from the app and media the agent saves. |

## Setup

### auth

Show whether this machine is paired, or pair it.

```text
joy auth
joy auth <relay url>
```

With no argument, `joy auth` prints the credentials path, the machine id and the relay, or `not paired` (exit 1).

With a relay URL, it asks for your account backup code (the `XXXXX-XXXXX-…` code from the app), pairs this machine with the relay, and records the relay in `~/.joy/relay.json`. A bare `host:port` is read as `https://host:port`. The backup code is used and discarded; it is never written to disk.

After pairing, `joy auth` prints the relay perimeter key derived from your account. A relay operator who wants to gate the relay sets that value as `JOY_RELAY_ACCESS_KEY` on the relay (see [Self-hosting](../getting-started/self-hosting.md)).

Pairing with a different relay moves this machine to it. Run `joy install` afterwards so the service follows.

```bash
joy auth relay.example.com:4997
```

### install

Install the daemon as a service that starts at login and restarts if it exits.

```text
joy install
```

- **Linux:** writes a systemd user unit, `~/.config/systemd/user/joy-daemon.service`, and enables it. Logs: `journalctl --user -u joy-daemon -f`. To keep the daemon running while you are logged out, enable lingering: `loginctl enable-linger $USER`.
- **macOS:** writes a launchd agent, `~/Library/LaunchAgents/joy-daemon.plist`, and loads it. Logs go to `daemon.log` in the state directory.

The service carries the relay URL and the joy home directory it was installed with. Restarting or stopping the service stops only the daemon: your sessions live in tmux and keep running. `joy install` is idempotent; run it again after pairing with a new relay or after an update.

### uninstall

Remove the service. Running sessions are not touched.

```text
joy uninstall
```

### update

Update the daemon from the project's release branch, then reinstall the service, which restarts the daemon on the new code.

```text
joy update
```

This runs `pnpm add -g "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon"`, so pnpm must be on your `PATH`. A source checkout updates with `git pull` and `joy restart` instead.

### doctor

Check the environment: node, tsx, tmux, the `claude` binary, the relay, the pairing, the daemon's source, and whether the daemon is running. Exits 0 when tmux is installed and the machine is paired.

```text
joy doctor
```

### start, stop, restart, status

```text
joy start      # start the daemon detached; its log is daemon.log
joy stop       # stop the daemon
joy restart    # re-exec the daemon; starts it if it is not running
joy status     # version, pid, port, relay, uptime, active sessions
```

`joy stop` stops a service-owned daemon through systemd or launchd, so the service does not restart it. The service stays installed and returns at the next login; `joy install` re-arms it now. If `joy stop` cannot tell whether a service owns the daemon, it signals nothing and tells you how to stop it yourself.

None of these end Claude Code or Codex sessions: tmux keeps them alive, and the daemon adopts them again when it starts. OpenCode, Pi and Antigravity sessions run as processes of the daemon and stop with it.

### Example

```bash
CI=1 pnpm add -g "git+https://github.com/fny/joy.git#release&path:packages/joy-daemon"
joy auth relay.example.com:4997     # paste the backup code from the app
joy install
joy doctor
```

## Sessions

### ls

List every session on this machine: id, agent, state (`idle`, `busy`, `needs input`, `ended`), title, folder and how long ago it was active.

```text
joy ls
```

### about

Everything about one session: state, permission mode, model and effort, folder, pid, tmux target, uptime, turn count, queue length, pending approvals and cost.

```text
joy about <session> [--json]
```

### check

Can this session be talked to right now? The exit code is the answer.

```text
joy check <session> [--json]
```

| State | Exit | Printed |
|---|---|---|
| idle | 0 | `1a2b3c4d idle` (with a queue count if any) |
| busy | 3 | `1a2b3c4d busy for 2m, 1 queued` |
| needs input | 6 | the approval title, or the question and its offered answers |
| ended or error | 1 | the state and the reason |

`--json` prints `{ "session": "<id>", "state": "idle" | "busy" | "needs_input" | "ended" | "error", ... }` with the details the daemon reports, such as `queue`, `busySince`, `approvals`, `question`, `options` and `permissionMode`.

### new

Create a session and print its id.

```text
joy new <dir> [-m <message>] [--agent claude|codex|opencode|pi|agy]
              [--model <model>] [--effort <effort>] [--read-only] [--headless]
              [--continue | --resume <id>] [--json] [-- <args for the agent>]
```

| Flag | Effect |
|---|---|
| `<dir>` | The folder. Created if it does not exist. `~` is expanded. |
| `-m`, `--message` | The first message. It is sent as soon as the agent is ready. |
| `--agent` | Which agent to run. Default `claude`. |
| `--model`, `--effort` | Model and reasoning effort, in the agent's own names. |
| `--read-only` | Start in the agent's read-only mode: plan mode for Claude Code, OpenCode, Pi and agy; the read-only sandbox for Codex. Without it, the session starts in the agent's no-prompts mode. |
| `--headless` | Keep the session out of the app's session list and send no "Finished" notification. It still appears and still notifies when it needs you. |
| `--continue` | Continue the most recent conversation in the folder instead of starting a new one. |
| `--resume <id>` | Resume a specific past conversation. |
| `--json` | Print the full session record instead of the id. |
| `-- …` | Everything after `--` goes to the agent, not to joy. Claude Code, Pi and agy take command-line arguments; Codex takes `key=value` config overrides; OpenCode takes none. |

Because joy stops reading flags at `--`, a flag both share means the agent's: `joy new . -- --model opus` passes `--model opus` to the agent.

If the daemon does not accept the `-m` message, `joy new` still prints the id (the session exists), prints the command to retry the send, and exits with the send's exit code.

### run

One-shot, like `claude -p`: create a throwaway session, send the prompt, print the reply, then end the session and delete its transcript.

```text
joy run <prompt...> [--dir <dir>] [--agent <agent>] [--model <model>] [--effort <effort>]
                    [--read-only] [--timeout <seconds>] [--json]
```

- `--dir` defaults to the current folder. The session always starts fresh; it never revives an old conversation in that folder.
- The session runs in the agent's no-prompts mode unless you pass `--read-only`.
- `--timeout` defaults to 600 seconds and covers the whole run.
- Cleanup happens even after a timeout or an error.
- `--json` prints `{ "ok": true, "state": "answered", "cwd": "...", "response": "..." }`.

### jump

Attach your terminal to a session's tmux window, or switch to it if you are already inside tmux.

```text
joy jump [<id> | <prefix> | <path> | <folder name>]
```

With no argument, `joy jump` picks the session in the current folder, or in the nearest parent folder that has one. A folder name can be partial; an ambiguous match lists the candidates. `joy j` is an alias.

If you are inside a different tmux server, detach first (`C-b d`), then run `joy jump`.

### pane

Print what the session's terminal shows, as text.

```text
joy pane <session> [--color]
```

`--color` keeps the terminal's colour codes. Agents that have no terminal view answer with an error.

### mode

Show or set a session's permission mode.

```text
joy mode <session>           # print the current mode
joy mode <session> <mode>    # change it
```

The mode names are the agent's own. See [Sessions](../guides/sessions.md) for what each agent offers.

### kill

End a session and close its tmux window.

```text
joy kill <session>
```

### restore

Bring back sessions a reboot took. A daemon crash loses nothing, because tmux outlives the daemon. A reboot ends tmux too, and leaves only the session records behind. `joy restore` starts each of those sessions again and resumes its conversation.

```text
joy restore [--dry-run | -n] [--json] [<id>...]
```

- `--dry-run` lists what would come back and whether each one resumes a conversation or starts fresh.
- Give ids or prefixes to restore only those.
- `--json` prints the list and restores nothing.
- A session that is still running is never offered.

### Example

```bash
id=$(joy new ~/code/my-project -m "Read the README and summarise the build steps")
joy check "$id"; echo "exit $?"
joy pane "$id" | tail -20
joy kill "$id"
```

## Conversation

### send

Send a message without waiting for the reply.

```text
joy send <session> <text...> [--no-queue] [--no-reply] [--from <sender>] [--json]
```

If a turn is running, the message waits in the session's queue and runs when the turn ends. `joy send` prints `queued <turn id>`; pass that id to `joy wait --turn`.

| Flag | Effect |
|---|---|
| `--no-queue` | Refuse instead of queueing: exit 3 if any work is in flight. Only sessions in their no-prompts or read-only mode accept it (exit 5 otherwise), so a script never waits on a permission prompt it cannot see. |
| `--no-reply` | Mark the message as needing no answer. |
| `--from <sender>` | Who the message is from: `cli`, `app`, `cron:<name>`, or `joy:<id>` of a session on this machine. Default: `joy:$JOY_SESSION_ID` inside a session, otherwise `cli`. |
| `--json` | Print `{ "ok": true, "session": "...", "turn": "...", "from": "..." }`. |

When the sender is another session, the daemon wraps the text in a `<joy-message from=… reply-to=…>` envelope so the receiving agent knows who is talking. See [Scripting and agents](../guides/scripting-and-agents.md).

### ask

Send a message, wait for that message's turn to finish, and print the reply.

```text
joy ask <session> <text...> [--timeout <seconds>] [--no-queue] [--json]
```

- The reply is the text of the turn the daemon ran for this message, never the tail of an earlier turn.
- `--timeout` defaults to 600 seconds.
- If the session stops to ask a human (an approval, a question), `ask` returns at once with exit 6.
- An `ask` between two sessions that would wait on each other is refused with exit 3.

`--json` prints:

```json
{
  "session": "1a2b3c4d",
  "state": "answered",
  "text": "…the reply…",
  "turn": "<turn id>",
  "question": null,
  "options": null,
  "approval": null,
  "usage": { "…": "token counts for the turn" },
  "reason": "present when state is error, gone or timeout"
}
```

| `state` | Exit |
|---|---|
| `answered` | 0 |
| `needs_input` | 6 |
| `timeout` | 4 |
| `gone` | 1 |
| `error` | 1 (the turn could not be observed; `reason` says why) |

### wait

Block until a turn ends.

```text
joy wait <session> [--turn <turn id>] [--timeout <seconds>] [--json]
```

With `--turn`, `wait` follows that specific queued message until it finishes. Without it, `wait` returns when the session is idle. It returns early if the session needs input (exit 6) or ends (exit 1). `--timeout` defaults to 600 seconds. `--json` prints `{ "session": "...", "state": "...", "check": { ... } }`.

### events

Print the session's records: messages, assistant text, tool calls, turn starts and ends with usage.

```text
joy events <session> [--last <n>] [--follow] [--json]
```

- Without flags, the last 12 records.
- `--last`, `-n`: how many recent records to start with.
- `--follow`, `-f`: keep streaming new records until you press Ctrl-C. With `--follow` and no `--last`, only new records are shown.
- `--json`: one JSON object per line, each `{ "seq": <n>, "at": <ms>, "record": { "role": "...", "content": { ... } } }`.

### abort

Interrupt the running turn. Queued messages stay queued and run next.

```text
joy abort <session>
```

Exits 1 when there is nothing to interrupt, for example a session whose agent has exited.

### approvals, approve, deny

Tool-call approvals the agent holds for a human. These are held approvals from agents that report them to joy, such as Codex. A permission prompt drawn in Claude Code's terminal is answered in the app or the terminal and does not appear here.

```text
joy approvals <session> [--json]    # list: request id, kind, title, age
joy approve <session> [<request id>]
joy deny <session> [<request id>]
```

Without a request id, `approve` and `deny` answer the oldest pending approval.

### queue

The messages waiting behind the running turn.

```text
joy queue <session>                # list queued messages and their sender
joy queue <session> cancel <id>    # drop one queued message
joy queue <session> resume         # release a paused queue
```

The daemon pauses a queue when it could not deliver a message cleanly, for example when the agent's input box already held text. `resume` sends the held message.

### Example

```bash
# Queue two tasks behind whatever is running, then wait for the second.
joy send 1a2b3c4d "Run the test suite"
turn=$(joy send 1a2b3c4d "Summarise the failures" --json | jq -r .turn)
joy wait 1a2b3c4d --turn "$turn" --timeout 1800

# Or do both in one call and branch on the outcome.
if reply=$(joy ask 1a2b3c4d "Is the build green? Answer yes or no."); then
  echo "$reply"
elif [ $? -eq 6 ]; then
  joy check 1a2b3c4d     # shows the question or approval it is waiting on
fi
```

## automation

Saved work: a folder, a prompt and a trigger, and the runs it produces. Each run is a headless session. A run fails as soon as it needs a human, with one of these reasons: `blocked:login`, `blocked:trust`, `blocked:permission`, `agent_died`, `stalled`. See [Automations](../guides/automations.md). `joy auto` is an alias.

```text
joy automation create [--dir <path>] -m "<prompt>" [--name <name>]
                      [--on manual | automation_done [--filter <automation id>]]
                      [--cron "<expression>" [--tz <zone>]]
                      [--agent <agent>] [--model <model>] [--effort <effort>] [--json]
joy automation ls [--json]
joy automation show <id>
joy automation run <id> [--wait] [--json]
joy automation runs <id> [--json]
joy automation enable <id>
joy automation disable <id>
joy automation rm <id>
```

| Flag | Effect |
|---|---|
| `--dir`, `-C` | The folder the runs work in. Default: the current folder. |
| `-m`, `--message` | The prompt each run starts with. Required. |
| `--name` | The automation's name. Default: the first six words of the prompt. |
| `--on manual` | Runs only when you start one. The default. |
| `--on automation_done --filter <id>` | Runs whenever the named automation finishes, whatever its outcome. |
| `--cron "<expr>"` | Runs on a schedule: a five-field cron expression, such as `"0 2 * * *"` for 2 am daily. |
| `--tz` | The time zone for `--cron`, such as `America/New_York`. Default UTC. |
| `--agent`, `--model`, `--effort` | As for `joy new`. Default agent `claude`. |

- `run` starts a run and prints its id. A run is skipped when the automation already has one going.
- `run --wait` blocks until the run finishes (up to 30 minutes) and exits 0 for success and 1 otherwise, so scripts and agents can call an automation like a command.
- `rm` deletes the automation; the sessions its runs created are left alone.
- An automation created with the CLI runs on this machine. Its spec is sealed with this machine's key, so the CLI can only author automations for the machine it runs on.

### Example

```bash
joy automation create --dir ~/code/my-project --name "Nightly deps check" \
  -m "Check for outdated dependencies and open a summary in NOTES.md" \
  --cron "0 2 * * *" --tz Europe/Berlin
joy automation ls
joy automation run 9f8e7d6c --wait && echo "succeeded"
```

## env

A store of environment variables, such as provider API keys, that every new session on this machine inherits. The store is sealed with the machine's key, and values are never printed.

```text
joy env [ls]              # list the names
joy env set KEY=value
joy env unset KEY
```

Changes apply to sessions started afterwards, not to sessions already running.

```bash
joy env set OPENAI_API_KEY=sk-...
joy env ls
```

## notify

Send a push notification to every device on your account.

```text
joy notify -p "<message>" [-t "<title>"]
joy notify "<message>"
```

The title defaults to `Joy`. The daemon must be running, because the notification goes out through its connection to the relay. Push notifications are not end-to-end encrypted; do not put secrets in them.

```bash
./deploy.sh && joy notify -p "Deploy finished" -t "my-project"
```

## Related

- [Scripting and agents](../guides/scripting-and-agents.md)
- [Sessions](../guides/sessions.md)
- [Automations](../guides/automations.md)
- [API](api.md)
- [MCP server](mcp.md)
- [Troubleshooting](troubleshooting.md)
