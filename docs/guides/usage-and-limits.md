# Usage and limits

Coding agents run on quotas: Claude and Codex both cap how much you can use in a 5-hour window and in a week. joy shows how much of the relevant quota you have left right in the composer, lists every quota window in Settings → Limits, and breaks down your token usage and estimated cost in Settings → Usage. This page explains each of those, and where the numbers come from.

## Where the numbers come from

joy never asks you for an Anthropic or OpenAI credential. Each machine's daemon reads the figures itself:

- **Claude quota** comes from the account that the machine's Claude Code is signed in to, the same figures Claude Code shows you.
- **Codex quota** comes from Codex's own session logs on the machine, so it is as fresh as the last time Codex ran there.
- **Usage and cost** are computed on the machine from Claude Code's transcripts.

If your machines are signed in to different accounts, each shows its own account's figures.

## "% left" in the composer

The composer's info row ends with a figure such as **4% left**. It is the tightest quota window that can stop the session you are in:

- The **shared windows** always count. Claude's 5-hour and weekly allowances apply to every model.
- The **selected model's own window** counts too. Some models have a weekly allowance of their own; only the one for the model this session uses is included.
- **Other models' windows are ignored.** If another model's weekly allowance is nearly spent, that does not change the figure for a session on a different model.

The figure follows the session's agent:

| Agent | "% left" shows |
|---|---|
| Claude Code | Claude's quota, as above |
| Codex | Codex's 5-hour and weekly windows |
| Other agents | The context reading instead (see below) |

Its colour tells you how close you are:

| Colour | Quota used |
|---|---|
| Grey | Under 80% |
| Orange | 80% or more |
| Red | 90% or more |

The figure refreshes every few minutes. Before a session's model is known, for example a fresh session that has not run a turn yet, every window counts.

### The breakdown

Tap the figure to see every quota window on that machine, each with how much is left, a bar, and when it resets ("resets in 2h 59m", "resets in 3d"). The breakdown lists all windows, including other models', so the whole picture is one tap away.

### The context reading

When there is no quota to show, the same spot shows how much of the conversation's context window is left, but only when it is running low: from 10% left in orange, and from 5% in red. Settings → Appearance → **Always Show Context Size** shows it all the time. If the model's context window size is unknown, it shows the number of tokens in use instead of a percentage.

## Settings → Limits

**Limits** shows live account quota windows for Claude and Codex, one card per online machine. Each card has a **Claude** section and a **Codex** section with a bar per window; a bar turns red at 80%. Tap **refresh** on a card to read it again.

A Codex section reads "no recent codex activity" when Codex has not run on that machine lately, because its figures come from Codex's own logs.

## Settings → Usage

**Usage** reports token usage and what it would cost, computed from Claude Code's transcripts on each machine.

Pick a scope:

- **All machines** — every machine added together. This can be slow.
- A single machine.

Pick a period: **Today**, **1 Week**, **30 Days**, **90 Days** or **6 Months**.

The report then shows:

| Section | What it shows |
|---|---|
| Overview | Estimated cost, calls, sessions, tokens by kind, and how much the prompt cache saved |
| By Machine | Each machine's share, when you chose all machines |
| 30-Day Heatmap | Day by day, for the 30-day period |
| Daily, Weekly or Monthly Activity | Cost and calls over the period |
| Top Sessions | The most expensive conversations |
| By Project | Cost and sessions per project folder |
| By Model | Cost and tokens per model |
| By Activity | Cost by kind of work |
| Core Tools, MCP Servers, Skills & Agents, Subagents | Which tools the agents called, and how often |

Costs are estimates at API prices. If you use Claude through a subscription, they are not what you pay; they show how your usage is spread, not your bill.

You can also see usage for a narrower scope:

- Session info → **Usage & Cost** — the cost of one conversation.
- The machine page → **Usage & Cost** — token usage and cost for that machine.

## Related

- [The app](app.md)
- [Notifications](notifications.md) — quota alerts at 90%
- [Sessions](sessions.md)
- [FAQ](../reference/faq.md)
