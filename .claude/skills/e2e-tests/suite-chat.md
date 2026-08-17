# Chat suite — agent-agnostic e2e tests (run once per agent: claude AND codex)

These tests exercise the shared chat pipeline: create → send → receive → artifacts,
ordering, exactly-once, queueing, abort, restart-history, terminal view, multi-client.
Everything here MUST pass identically for `AGENT=claude` and `AGENT=codex` (select the
agent on the new-session page via the agent toggle). Where an artifact is agent-specific
(claude transcript vs codex rollout), substitute per the table below.

| Artifact | claude | codex |
|---|---|---|
| Agent-side log | `~/.claude/projects/<enc-cwd>/<session-id>.jsonl` | `~/.codex/sessions/<y>/<m>/<d>/rollout-*-<threadId>.jsonl` |
| Session binding on `/sessions` | non-null `claude_session_id` | non-null `codexThreadId` in the window record |
| Pane content | claude TUI | codex attach TUI (`codex --remote … resume <thread>`) |

## CH1: Create + first exchange
- New-session page with AGENT selected; create in `$HOME/joy-test` (createDir yes).
- Initial message `What is 4+4?` → response `8`/"eight".
- Status: session **online/green**, sidebar **gray**; title is not "New Chat".
- Validate artifacts (both messages, seq order, exactly once).

## CH2: Exactly-once — NO duplicate messages (regression 2026-07-29)
- Send `Say the word PINEAPPLE once.`
- Assert the USER message renders **exactly once** in the chat (the codex relay path
  once re-mirrored it → every user message duplicated), and once in the server seq.
- Assert the agent reply appears exactly once. Repeat with a second message; recheck.

## CH3: Working states
- Send `write me a long paragraph of lorem ipsum` → status **blue** (working) in session
  + sidebar; on completion green→gray idle. Long text present. Validate artifacts.

## CH4: Abort mid-turn
- Send a long task; press stop mid-turn. Turn is interrupted promptly, status returns
  idle, an interruption is acknowledged (claude: "⏹ Interrupted" note; codex: turn ends
  with status cancelled — no spinner left behind). A new message afterwards runs fine.

## CH5: Queueing while busy
- While a turn is working, send 3 messages quickly. They deliver **in order**, none
  lost/duplicated, no "didn't send" banner. (claude: daemon `joy__queue`; codex: daemon
  FIFO — one turn/start at a time.) Validate artifacts in send order.

## CH6: Terminal (pane) view works
- Open the session's terminal view (session info → Open Terminal, or `/joy/pane/...`).
- Assert it renders live pane content (claude TUI or codex attach TUI banner — NOT a
  blank screen), and keys typed there reach the CLI (type a char, see it echo).

## CH7: Restart shows full history immediately
- With ≥3 exchanges recorded, kill/archive the session; restart it (sidebar restart for
  claude; for codex any restart path — it must thread/resume the SAME conversation).
- On landing, the ENTIRE prior conversation renders immediately without sending a
  message (first + last visible, count matches server seq, no interior gaps).
- Send one new message; it appends after history, in order.

## CH8: Daemon restart mid-session
- Restart joy-daemon while the session is idle. It must rebind (claude: transcript
  re-bound; codex: orphan app-server rejoined — check the daemon log). A follow-up
  message round-trips; no duplicate replay of old messages in the app.

## CH9: Multi-client
- Second browser, restore via secret key: prior session visible; a message sent from
  browser two round-trips and appears in all artifacts, in order, exactly once.

## CH10: Multiline content
- Send a multiline message; newlines preserved in chat + artifacts.
