# Codex suite — codex-specific e2e tests

Run AFTER the chat suite has passed for codex. Requires codex ≥ 0.144 on the daemon's
PATH (`JOY_CODEX_BIN` respected). These tests exercise the codex adapter: app-server
drive, model/effort picker, codex permission modes, attach TUI, thread resume, and
non-yolo approvals.

## CX1: New-session page shows CODEX options only
- Toggle the agent to `codex`. Assert:
  - The model item shows the **live catalog** (from the `joy-codex-models` RPC —
    gpt-5.6-sol etc.), cycling works, and effort defaults to the model's own
    `defaultReasoningEffort` (gpt-5.6-sol → `low`).
  - Permission modes cycle through the CODEX set only: `default`, `read only`,
    `safe yolo`, `yolo` — never claude's `auto`/`accept edits`/`plan`.
  - Claude-only rows are **hidden**: claude effort, fallback, continue, fork,
    resume-MB, chrome, detached, extra args (regression 2026-07-29). The resume-id
    input remains (codex thread resume).
- Toggle back to claude: all claude rows return; codex rows gone.

## CX2: Model identity — the selected model actually runs
- Create a codex session with a NON-default model (e.g. `gpt-5.5`).
- Ask `In one short sentence: what AI model are you and who built you?` — the answer
  must be OpenAI/GPT (never Claude/Anthropic).
- Assert the window record's `codexSettings.model` matches the selection, and the
  attach TUI banner shows the same model.
- (Daemon-level equivalent: `src/codex/__fixtures__/model-identity-e2e.mjs`.)

## CX3: Attach TUI + intervention
- Terminal view shows the codex TUI banner (`>_ OpenAI Codex`), the correct model line,
  and the session directory. Type into the pane; the TUI receives it. A message sent
  from the TUI side shows up in the thread (and after reconcile, in the app).

## CX4: Thread resume on restart
- Note the `codexThreadId` (window record). Restart the session (info → Restart).
- The SAME thread id must be resumed (record unchanged), full history renders, and a
  follow-up message continues the conversation with prior context ("what did I ask you
  first?" answers correctly).

## CX5: Orphan rejoin on daemon restart
- With the session idle, restart joy-daemon. Daemon log must show
  `rejoined orphan app-server thread=<id>` (NOT a fresh spawn), the app-server PID is
  unchanged, and a follow-up message round-trips with **no duplicated history** in the
  app (turn-level checkpoint working).

## CX6: Non-yolo approval flow
- Create a codex session with permission mode `default`.
- Ask it to run a shell command (e.g. `create a file /tmp/cx-approve-test via shell`).
- The app shows the codex **approval bar** (Allow/Deny). Deny → the turn completes
  without executing (file absent). Repeat and Allow → command runs (file exists).
- The bar clears after answering; a second queued approval surfaces after the first.

## CX7: Effort + permission persistence
- After CX4's restart, `codexSettings` retains model/effort/permissionMode (no reset
  to defaults). Changing the mode via the app persists across a daemon restart.

## CX8: Interrupt
- Start a long turn; abort. The codex turn is interrupted (`turn/completed` status
  interrupted → chat shows the turn cancelled), no spinner wedge, next message runs.
