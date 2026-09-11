# Messages and the queue

This page covers talking to a session: sending messages, what happens to a message you send while the agent is busy, editing and removing queued messages, stopping and steering a running turn, drafts, attachments, joy's own slash commands, messages that come from other sessions, and what "This session is full" means.

## Sending a message

Type in the message box and send. On web and desktop, Enter sends and Shift+Enter starts a new line; turn off **Enter to Send** in Settings → Features to make Enter insert a new line instead. What you send is typed into the real agent, so it behaves exactly as if you had typed it at the machine. Anything typed at the machine directly shows up in the app too.

If you have no connection, the message is kept on the device and sent when you are back online. A banner says so: "No connection — queued messages will send when you're back online".

## The queue

A plain message you send while the agent is working does not interrupt it. It waits in the **Queue** above the message box and goes out when the current turn ends, one message per turn, in the order you sent them.

While a message is in the queue you can still change it:

- **Edit** it in place: each row is an editable text field.
- **Remove** it with ×.
- **Steer** it with ⇡ to deliver it into the running turn now instead of waiting (see [Steering a running turn](#steering-a-running-turn)).

Two kinds of message skip the queue and go straight to the session: messages with attachments, and slash commands that act on a running turn.

### When a queued message does not go out

If a release keeps failing, the row turns red and says why: "Couldn't send — *reason*. Trying again…" while it retries, then "Couldn't send — *reason*. Tap ↻ to try again." once it gives up. Tap ↻ to send it again.

Sometimes the machine pauses its own queue instead of risking a garbled send, for example when the agent's input box already holds stray text. The queue then shows a line such as "The session's input box has stray text — tap to clear and resume". Tap it to resume. From the command line: `joy queue <session> resume`.

## Stopping a turn

While the agent is working and the message box is empty, the send button becomes a stop button. Tap it to interrupt the turn.

If you are typing a follow-up while the agent works, the send button stays a send button so queueing stays one tap, and a smaller stop button appears beside it. On web and desktop, Escape also stops the turn.

From the command line: `joy abort <session>`.

## Steering a running turn

Steering puts a message into the turn that is already running, instead of waiting for it to end. Use it to correct course mid-task.

- Start a message with `/steer`, as in `/steer use the staging database instead`.
- Or tap ⇡ on a row in the queue.

`/btw <question>` asks Claude Code a side question while it keeps working. It is Claude Code's own command; joy delivers it immediately rather than queueing it.

## Slash commands

Most slash commands are the agent's own, such as `/compact` or your project's commands, and are passed to the agent untouched. These are handled by joy:

| Command | What it does |
|---|---|
| `/steer <message>` | Type the message into the running turn now. |
| `/btw <question>` | Deliver Claude Code's side-question command now, mid-turn. |
| `/title <text>` | Set the session's title. A title you set is kept: the agent can no longer rename the session. `/title` with no text unlocks it again. |
| `/login-code <code>` | Paste a sign-in code into the agent's login prompt. |
| `/joy-prompt` | Remind the agent of joy's instructions, for long sessions where it has drifted. |

`/model <name>` and `/effort <level>` are Claude Code's own commands. When Claude Code asks you to confirm the change and the highlighted answer is Yes, joy confirms it for you. You can also change the model, effort and permission mode from the status line under the message box; see [Sessions](sessions.md#permission-modes).

## Drafts

A draft is a message you want to keep without sending. Type it, then tap the save icon beside the message box. Drafts collect under **Drafts** above the message box, stay on this device, and are never sent automatically. Edit one in place, tap ↑ to send it, or × to throw it away.

Drafts can carry images. Your phone may clear its cache when storage is low, and a draft kept for a long time can lose its images that way. The draft then shows how many images are missing and asks before sending it without them.

While the agent is working, the save icon gives way to the stop button, so the row gains only one extra icon.

## Attachments

Tap the attach button in the message box to add:

| Option | What it adds |
|---|---|
| Photo Library | Photos from your library. |
| Choose File | Any file. |
| Paste Image | An image from the clipboard. |
| Draw | A sketch you draw in the app. |

On web and desktop you can also paste an image straight into the message box, or drag images onto the window.

A message can carry up to 20 files, each up to 10 MB. Attachments are encrypted on your device and saved on the machine in `~/.joy/sessions/<session id>/uploads/`, outside your project. The message tells the agent where each file is. You can browse them later under **Session files** in the session's Files view.

## When the agent needs you

Some turns stop and wait for an answer:

- **Permission prompts** appear in the chat with the agent's own choices, such as "Yes, allow all edits during this session" or "No, and provide feedback".
- **Codex approvals** appear as a bar above the message box.
- **Sign-in** appears as a bar with the login link and, for Codex, a one-time code. Paste a code back with the bar's field or `/login-code`.
- **Dialogs** in the agent's terminal show as an ACTION NEEDED bar with the dialog's choices. Answer them in the terminal: tap the bar, or **Open Terminal** in session info.

The session's status turns amber while it waits. A permission prompt also sends you a notification; see [Notifications](notifications.md).

## Messages from other sessions

Agents can message each other, and so can scripts and scheduled jobs, with `joy send`. A message that arrives this way is labelled in the chat with who sent it.

If the session is busy, such messages wait in their own **From other sessions** stack, folded by default and captioned with the sender, so they never mix with your own queue. You can remove one or steer it into the running turn. You cannot edit another party's words. See [Scripting and agents](scripting-and-agents.md).

## "This session is full"

The relay stores a large but fixed amount of history per session. A very long session can run out. When it does:

- A bar reads OUTPUT DROPPED: "This session is full — part of the conversation was not saved".
- The agent keeps running, but its new output is not saved and new messages to the session are refused.
- You get a "This session is full" notification.

It does not recover. Tap **Start a new session** on the bar to continue in a fresh session in the same folder.

## Related

- [Sessions](sessions.md)
- [Notifications](notifications.md)
- [Scripting and agents](scripting-and-agents.md)
- [The app](app.md)
- [CLI reference](../reference/cli.md)
