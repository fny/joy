# Sessions

A session is one coding agent running in one folder on one of your machines. This page covers starting sessions from the app and the command line, the agents joy can run and what each supports, permission modes and models, picking up earlier conversations, reading a session's status, and ending, restoring and inspecting sessions.

## Starting a session

### From the app

Tap **+** at the top of the sidebar, or open a machine and choose **New Session** there to start on that machine. The new-session page asks for:

| Field | What it does |
|---|---|
| Machine | Which of your machines runs the agent. It has to be online. |
| Project path | The folder the agent works in. Type an absolute path or `~/…`, or pick one under **Recent**. If the folder does not exist, the app asks whether to create it. |
| Agent | Claude Code, Codex, OpenCode, Pi or Antigravity. |
| Model and effort | Which model, and how hard it thinks. Only shown for agents that have the setting. |
| Permission mode | How much the agent may do without asking. Modes in red run without any approvals. |
| Initial prompt | Optional. Sent as the first message once the agent is up. |

Depending on the agent, the page also offers ways to pick up an earlier conversation (see [Continuing a conversation](#continuing-a-conversation)) and a field for extra arguments passed to the agent itself.

### From the command line

On the machine, `joy new` creates a session and prints its id:

```bash
joy new ~/code/my-project -m "run the tests and fix what breaks"
joy new ~/code/my-project --agent codex --effort high
joy new . --read-only
```

| Flag | Meaning |
|---|---|
| `-m <msg>` | First message to send. |
| `--agent <a>` | `claude` (the default), `codex`, `opencode`, `pi` or `agy`. |
| `--model <m>`, `--effort <e>` | Model and effort for the agent. |
| `--read-only` | Start in the agent's read-only mode. Refused for an agent that has none. |
| `--headless` | See [Headless sessions](#headless-sessions). |
| `--continue`, `--resume <id>` | Pick up an earlier conversation. |
| `-- <args>` | Everything after `--` goes to the agent, not to joy. |

The session appears in the app on every device as soon as it starts. See the [CLI reference](../reference/cli.md) for every command.

## The agents

| Agent | Models | Effort | Permission modes | Change model mid-session | Resume earlier conversations |
|---|---|---|---|---|---|
| Claude Code | Fixed list, trimmed in Settings → Models | low, medium, high, xhigh, max | yolo, auto, default, accept edits, plan | Yes | Yes, and fork |
| Codex | Read from the machine | Depends on the model | default, read-only, safe yolo, yolo | Yes | Yes, and fork |
| OpenCode | Read from the machine | The model's reasoning variants | configured, read-only, allow all | Yes | Yes |
| Pi | Read from the machine | off to max | all tools, read-only tools | No | Yes, and fork |
| Antigravity | Read from the machine | low, medium, high | yolo, accept edits, plan | No | Yes, and fork |

Each agent has to be installed and signed in on the machine. If an agent needs you to sign in during a session, the session shows a sign-in bar with the link, and for Codex the one-time code to enter.

### Permission modes

Every agent starts in its own no-prompts mode unless you pick another one: yolo for Claude Code, Codex and Antigravity, allow all for OpenCode, and all tools for Pi (which never asks). What each mode allows:

| Agent | Mode | Allows |
|---|---|---|
| Claude Code | yolo | Every tool call runs without asking. |
| | auto | Claude decides which tool calls need approval. |
| | default | Asks before tool calls, as the CLI would. |
| | accept edits | File edits run without asking; other tools still ask. |
| | plan | Read-only planning: no edits, no commands. |
| Codex | default | Approvals on request, writes confined to the workspace. |
| | read-only | Nothing is written. |
| | safe yolo | No approvals, writes confined to the workspace. |
| | yolo | No approvals, full disk access. |
| OpenCode | configured | Whatever the agent's own permission config says. |
| | read-only | Reads and searches, no edits or commands. |
| | allow all | Every permission set to allow for this session. |
| Pi | all tools | read, bash, edit, write, grep, find and ls. |
| | read-only tools | Only read, grep, find and ls. |

To change the mode of a running session, tap the status line under the message box and pick **Permission mode**. **Model** and **Effort** are in the same panel. On web and desktop, Shift+Tab cycles through the modes. From the command line: `joy mode <session> <mode>`. Pi and Antigravity take their mode at start only.

Set the mode, model and effort new sessions start with in **Settings → Agent Defaults**.

### Models

Codex, OpenCode, Pi and Antigravity report their model catalogs from the machine, and some catalogs have hundreds of entries. **Settings → Models** chooses which models each agent's pickers offer. The choice syncs across your devices.

In Claude Code, `/model <name>` and `/effort <level>` work as they do in the terminal. When Claude Code asks you to confirm the switch and the highlighted answer is Yes, joy confirms it for you.

## Continuing a conversation

Every agent can pick up where an earlier conversation in the same folder left off. On the new-session page:

- **continue** resumes the newest conversation in the folder.
- **past sessions** lists earlier conversations in the folder to choose from.
- A session id resumes that exact conversation.
- **fork** (with a resume) starts a new conversation that carries the old one's context, leaving the original untouched.

From the command line, use `joy new <dir> --continue` or `joy new <dir> --resume <id>`.

From a running session, session info also offers **Fork**, a new session that continues from the last message. For Claude Code sessions it offers **Teleport** too, which continues the conversation on another of your machines. Teleport assumes the project's files are already there.

## Headless sessions

`joy new --headless` starts a session that nobody is expected to watch. It stays out of the app's session list and sends no "Finished" notification. It is not hidden when it matters: a headless session that needs you, for an approval or a sign-in, shows up in the list like any other, and a permission prompt still notifies you.

To see headless sessions anyway, turn on **Show headless** in the sidebar. Automation runs are headless sessions too; see [Automations](automations.md).

## Reading a session's status

Each session in the sidebar and in its own header shows one status. The most urgent one wins.

| Status | Meaning |
|---|---|
| permission required | A tool call is waiting for your approval. |
| approval required | Codex is holding a tool call for approval. |
| sign-in required | The agent needs you to sign in. |
| waiting in terminal | A dialog is open in the agent's terminal. |
| new results | A turn finished that you have not looked at yet. |
| A working message | A reply is being written. |
| compacting | The agent is summarizing its context. |
| retrying n/m | The agent is retrying a failed request. |
| n/m agents, n/m tasks | Idle, with background agents or tasks still running. |
| online | Idle, and you have seen everything. |
| no output for Nm | A turn is open but has produced nothing for a while. |
| detached | The agent has exited. See [Detached sessions](#detached-sessions). |
| last seen … | The machine cannot be reached. |

Statuses that need you are amber, new results are green, working states pulse, and read and offline sessions are grey.

## Ending a session

From session info:

- **Kill & Archive** ends the agent and archives the chat. Archived sessions move under **Show archived** in the sidebar and keep their history.
- **Delete Session** ends the agent and permanently deletes the chat history.
- **Restart Session** closes the agent's terminal window and resumes the same conversation in a fresh one. Use it when an agent is wedged.

From the command line, `joy kill <session>` ends a session.

### Detached sessions

A session is detached when its agent process has exited but joy still holds the session. You can still read its history and browse its files. Restart it from session info to resume the conversation, or archive it.

## After a reboot

Claude Code and Codex sessions run in tmux, which outlives the daemon, so a daemon crash or restart does not interrupt them: the daemon picks them up again when it starts. A machine reboot does end them. joy remembers every session that was running and can bring them back:

- On the machine page, **Restore N sessions** brings back everything the restart took. The row appears only when there is something to restore.
- In **Projects** on the machine page, **Restore latest session** brings back only the newest session in one folder.
- On the machine itself, `joy restore` does the same. `joy restore --dry-run` lists what it would bring back first.

Each restored session resumes its conversation when the agent kept one. A session that is still running is never offered, so you do not end up with two agents in one folder.

## Taking over in the terminal

Claude Code and Codex sessions run in a real terminal. **Open Terminal** in session info shows the live terminal with raw key input, for answering a dialog or looking at what the agent sees. OpenCode, Pi and Antigravity sessions have no terminal view.

On the machine, `joy jump` attaches your terminal to a session's tmux window: with no argument, the session in the current folder; otherwise a session id, a prefix of one, or a folder name. `joy pane <session>` prints the terminal as text without attaching.

## Session info

Open a session's header to reach session info. Besides the actions above it shows:

- **Live**: the current model, effort, tmux window, process id, and **CPU · Memory** for everything under the agent. Tap it, or **Processes**, for the list of every process under the agent, re-sampled every few seconds.
- **Reload Chat**: refetches the conversation from scratch. Use it when history looks empty or behind. Nothing on the relay or the machine changes.
- **Usage & Cost**: the cost of this conversation, computed on the machine.
- **Download Session Log**: the agent's raw transcript.
- **Hand off to…**: another model picks up the work from a note this session writes.
- **Mute notifications**: silences this session on every device.

## Session files

Files you attach to a message are saved on the machine in `~/.joy/sessions/<session id>/uploads/`, not in your project, so screenshots never pile up in your repository. The message tells the agent where the file is. In the session's **Files** view, **Session files** lists these uploads along with anything the agent produced there, newest first.

## Related

- [Messages and the queue](messages.md)
- [Automations](automations.md)
- [The app](app.md)
- [Notifications](notifications.md)
- [CLI reference](../reference/cli.md)
- [Troubleshooting](../reference/troubleshooting.md)
