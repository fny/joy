# Voice

Voice lets you talk to your sessions: ask what they're doing, send them instructions, and answer their permission requests, hands-free. joy doesn't run a voice service of its own. You bring your own conversational agent from ElevenLabs, and the app connects your microphone to it directly. This page covers setting the agent up, the two conversation modes, and what the agent can see.

## What you need

- An **ElevenLabs** account and a Conversational AI agent created on the ElevenLabs dashboard.
- The agent's **agent id** (it starts with `agent_`).
- If the agent has authentication turned on, an ElevenLabs **API key**. A public agent needs only its id.
- Microphone access for the app, on your phone or in your browser.

Voice works in the phone app and on the web.

## Set up the agent on ElevenLabs

On the ElevenLabs dashboard, give your agent two **client tools**. These are how it acts on your sessions:

| Tool | What it does |
|---|---|
| `sendMessageToSession(sessionId, message)` | Sends text into a session, as if you had typed it. |
| `processPermissionRequest(requestId, decision)` | Allows or denies a tool call a session is waiting on. |

You can also add ElevenLabs' built-in `skip_turn` tool.

Then give the agent its instructions. Settings → Voice → **Suggested system prompt** copies joy's operating notes to your clipboard; paste them into the agent's prompt on the dashboard.

If you plan to use **Standby** mode (below), also open the agent's **Security** tab on the dashboard and enable overrides for the **system prompt** and the **first message**. **Stays on** mode needs neither.

## Add the agent in joy

1. Open Settings → **Voice**.
2. Tap **Add agent**.
3. Enter a **Name** (for example "Joy"), the **Agent id**, and, for a private agent, the **API key**. Leave the key empty for a public agent.

You can add several agents. The one marked **In use** is the one the microphone connects to; tap another and choose **Use this agent** to switch. Each agent can be renamed, have its key set or replaced, or be removed.

## Start and end a conversation

When the composer is empty and no turn is running, its send button shows a microphone. Tap it to start voice.

A voice bar shows where the conversation stands:

| Status | Meaning |
|---|---|
| **Connecting…** | The app is opening the conversation. |
| **Voice live** | You're talking to the agent. In **Stays on** mode, tap the bar to end it; in **Standby**, tap to hang up and stand by. |
| **Joy idle** | Standby: the conversation has hung up and is waiting to wake. Tap to talk, or just start talking if **Wake on sound** is on. |
| **Voice error** | Voice could not start or was refused. Tap to retry. |

The **×** on the bar ends voice altogether. The agent can also end the call itself, which turns voice off.

If the connection drops, the app reconnects on its own, a few times, with a short delay between tries.

## Conversation modes

Settings → Voice → **Conversation** has two modes.

### Stays on

The default. Tapping the microphone opens one conversation, and it stays open until you end it. There is no hang-up after silence and nothing wakes it. The app sends nothing the agent has to allow, so an agent straight off the dashboard works as is. Joy's operating notes and a briefing on your sessions are sent as context each time the conversation connects.

### Standby

The conversation hangs up after a stretch of silence and stays **armed**: nothing is connected, so nothing is billed, but it can wake again. While standing by:

- **Wake on session events** reconnects and speaks when a turn ends, an approval is waiting, or a session asks you a question.
- **Wake on sound** listens on the device while the app is open, and reconnects when you start talking. It measures sound level only, not words, so a TV or a nearby conversation can wake it too.
- **Hang up after silence** sets how many seconds of silence end the conversation. The default is 45 seconds; 0 means never.

What was said is kept across hang-ups and replayed to the agent when it reconnects.

Standby mode needs the system-prompt and first-message overrides enabled on the agent's **Security** tab. Without them, ElevenLabs closes every call as soon as it opens. The app detects this: if a call ends within a few seconds of connecting, before anyone has spoken, it stops and shows **Voice call refused** with the likely reason, instead of retrying. Enable the overrides on the dashboard, or switch to **Stays on**.

## What the agent can see and do

While a conversation is live, the agent is kept up to date on your sessions:

- When it connects, it gets joy's operating notes, a list of your sessions, the session you have open, and, after a reconnect, what was said so far.
- As you move between sessions and as new messages arrive, it is told quietly, without speaking.
- When a turn ends, a permission request arrives, or a session asks you a question, it is prompted to tell you.

It acts only through the two client tools: sending a message into a session, and answering a permission request. It can't read your files or run commands on its own.

## Privacy

- **Your voice and the session context go to ElevenLabs.** The app connects your microphone straight to ElevenLabs from your device; no joy server is involved. Whatever the agent is told about your sessions, including recent messages, is sent to ElevenLabs to make that possible. Use voice only with sessions you are comfortable sharing with ElevenLabs.
- **Your API key stays with you.** A private agent's API key is stored in your account settings, which are encrypted end to end. The app uses it only on your device, to open each conversation; it is never sent to the relay in readable form.
- **Wake on sound stays on the device.** It measures sound level locally and sends nothing until it decides to reconnect.

## Related

- [The app](app.md)
- [Messages and the queue](messages.md)
- [Notifications](notifications.md)
- [Security](../reference/security.md)
- [FAQ](../reference/faq.md)
