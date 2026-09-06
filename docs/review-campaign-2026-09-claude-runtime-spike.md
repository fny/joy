# Wave F spike — can the Claude adapter stop trusting pane text?

Campaign item 8 (docs/review-campaign-2026-09.md:119). Read-only spike, 2026-09-06,
against Claude Code 2.1.263 on this box. No repo files changed.

## 1. What the pane decides today (session.ts)

| Decision | Pane primitive | Where | Issues it caused |
|---|---|---|---|
| "safe to type" (box empty) | `paneInputText(...) === ""`, else C-u loop | `#drainOnce` 1798-1846, parser 4093-4123 | #478 #485 #486 (drafts misread as empty / box invisible) |
| "a turn is live" | `paneShowsGenerating` = `/esc to interrupt/` over the WHOLE capture + spinner shape in last 12 lines | 4215-4227 | #479 (quoted hint in a reply blocks dispatch forever) |
| "my prompt landed" | echo timer + foreign turn-start `#confirmDispatchIfAwaiting` (hook text-match when present) | 1869, 3005-3043 | #32 (Enter swallowed, foreign turn confirms) |
| permission mode | `parsePermissionModeFromPane` = first mode phrase anywhere in the capture; set = Shift+Tab cycle then re-read | 2008-2040, 4232-4238 | #480 |
| login form | `loginFromPane` URL regex + `/login-code` types into whatever pane is up | 3225-3290, 3904 | #482 |
| dialogs (/model, trust, resume picker) | `dialogFromPane`, `numberedPickerFromPane`, `trustPromptKeys` | 3946-4050, 4247 | dialog false-confirm family |
| process alive | pid probe, falls back to the pane shell | registry.ts:562, `#pollEnd` | #30 |
| API retry storm | `retryFromPane` (2.1.x writes no transcript entry for 529s) | 3971 | silent stall otherwise |
| background work | `paneShowsWorking` footer "· N shells · ↓ to manage" below the box | 4176-4207 | stuck-thinking family |

Scale: 18 capture sites, 50 parser calls, 13 raw key sends in session.ts; the parser block is
342 lines; 64 of 123 unit tests in session.test.ts are parser tests; 28 of 162 commits on the file
(`--follow`) are pane repairs. #34 and #35 are queue/mutex bugs, not pane bugs — they survive any
runtime change and are out of scope here.

Hooks are already wired (claude/hooks.ts): `--settings` merges a managed file registering
PreCompact, SessionStart, UserPromptSubmit, Stop, Notification, all forwarded to
`POST /sessions/:id/hook`. The forwarder ships ONLY `event, session_id, transcript_path, prompt,
message, source, trigger` — it drops `permission_mode`, `notification_type`, `prompt_id`,
`end_reason`, `error_type`, `tool_name`. By design hooks "tighten state, they are never
load-bearing" (hooks.ts:19-25); the pane stays the authority.

## 2. What Claude Code offers on this machine (verified)

**Hooks that run inside the interactive TUI** (docs hooks reference, fetched 2026-09-06):
`SessionStart(source)`, `UserPromptSubmit(prompt, prompt_id, permission_mode)`,
`UserPromptExpansion`, `PreToolUse/PostToolUse/PostToolUseFailure(tool_name, tool_input,
permission_mode)`, `PostToolBatch`, **`PermissionRequest`** (tool_name/tool_input, can return a
`decision`), `PermissionDenied`, **`Stop(last_assistant_message, permission_mode)`**,
`SubagentStart/Stop`, `TaskCreated/Completed`, **`StopFailure(error_type ∈ rate_limit |
overloaded | authentication_failed | billing_error)`**, **`SessionEnd(end_reason ∈ clear |
resume | logout | prompt_input_exit | other)`**, `PreCompact/PostCompact`, and async
**`Notification(notification_type ∈ permission_prompt | idle_prompt | auth_success |
elicitation_* | agent_needs_input | agent_completed | quota_*)`**. `permission_mode` rides on
UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Stop, PostToolBatch, SubagentStop.
Docs are explicit: "No hook directly exposes the draft text in the input box" and "No hook can
directly inject a user message". Nothing fires on Shift+Tab itself; the mode is learned at the
next event. Nothing exposes a dialog, the OAuth URL, or the trust prompt.

**Headless runtime** (`claude -p --input-format stream-json --output-format stream-json`,
probed once in /tmp/joy-spike-headless; result `success`, "spike-ok"): the binary carries the
control protocol `control_request/control_response/control_cancel_request, initialize,
interrupt, set_permission_mode, set_model, can_use_tool, hook_callback, mcp_message, keep_alive,
stream_event, tool_progress, rate_limit_event, prompt_suggestion`; flags `--replay-user-messages`,
`--include-hook-events`, `--include-partial-messages`, `--permission-prompts host|none`,
`--session-id`, `--resume`, `--fork-session`, `--no-session-persistence`. The `system/init`
message listed 66 `slash_commands`: every skill, plus `clear compact context model effort config
agents mcp rename usage goal doctor init insights recap` … Absent (interactive-only): `resume
login permissions tasks status help memory hooks export vim add-dir cost theme keybindings`.
`-p` skips the trust dialog. Rate-limit note: the probe ran inside a rejected five-hour window
and billed overage — no further live probes were run.

**Session sharing** — decisive: one conversation cannot be held by two processes. The daemon
already encodes this (registry.ts:329 "a second `claude --resume <id>` on a live conversation
collides/forks", :481-494 refuses it); the binary confirms it ("… is already running or being
resumed"; `--bg --resume` "starts a copy and says so when the session is already running").
Only sequential hand-off through the on-disk JSONL is possible (stop process A, `--resume` in B),
which loses the in-flight turn, Claude-side queued messages, and background shells.

**Claude's own structured surfaces, discovered, all private/undocumented:**
- `~/.claude/sessions/<pid>.json` — live registry: `sessionId, cwd, kind interactive|bg,
  status idle|busy + statusUpdatedAt, tmux "joy-59b2fd1e:@0.%0"` (it records OUR pane),
  `messagingSocketPath /run/user/1000/cc-socks/<pid>.sock`, `peerProtocol 1`. `claude agents
  --json` reads it. Status writes look transition-driven (idle records days old); the socket is
  agent-to-agent SendMessage ("from another Claude session, not your user"), not a prompt input.
- `claude daemon` (hidden; ~/.claude/daemon/roster.json, `ptySock`, `rendezvousSock`,
  attach-journal) hosts `--bg` sessions; `claude attach <id>` re-renders the TUI over a pty
  socket, Ctrl+Z detaches, `claude logs` prints the terminal. This IS a hybrid runtime built by
  Anthropic — but its only user-input path is the attached TUI's keyboard. No prompt API.
- In-repo precedent for a real hybrid: codex — daemon-owned app-server over a unix socket,
  `codex --remote unix://… resume <thread>` TUI in the pane (codex/attach.ts). Claude has no
  `--remote` equivalent today.

## 3. Candidates

### A — keep the TUI, make hooks + transcript the authority; pane only for what they cannot see

Replacements, per decision:
- prompt landed → `UserPromptSubmit` text-match (already at 3005); confirm-on-foreign-turn only
  when hooks are known dead. Kills #32.
- generating → `UserPromptSubmit`…`Stop` window, refreshed by `PostToolUse/PostToolBatch`;
  transcript stays the durable fallback. `paneShowsGenerating` demoted to a tie-breaker scoped
  to the live footer. Kills #479.
- permission mode → `permission_mode` on every hook; `setPermissionMode` still types Shift+Tab
  but verifies against the next hook (or a footer read scoped below the live box). Kills #480's
  false success; the set path stays keystroke-driven.
- waiting on a prompt → `Notification(permission_prompt|idle_prompt)` + `PermissionRequest`
  (tool_name/tool_input available for the app; `decision` output is a future path to app-side
  approvals without typing "1"). 
- exit → `SessionEnd(end_reason)` plus registry-file disappearance; pid probe becomes backstop.
  Kills #30 for every non-crash exit.
- auth → `StopFailure(authentication_failed)` opens the login flow, `Notification(auth_success)`
  closes it; `/login-code` typing requires BOTH an active auth failure AND the form on screen.
  Shrinks #482 to "form parser must match the real form".
- retries → still pane (`StopFailure` fires only when the turn finally fails); `rate_limit_event`
  exists only in stream-json.
CANNOT be observed structurally: draft text (#478 #485 #486), dialogs, the OAuth URL/code box,
the trust prompt, the "N shells" footer. For these the campaign rule stands: uncertain → unknown,
never "empty". Those three draft issues are parser fixes regardless of runtime.
What breaks: nothing user-visible; sessions launched without `--settings` (adopted) keep the
pane path. Risk: hooks are best-effort — daemon down, 1.5 s abort, or a settings snapshot from an
older version silently starve them, so a per-session "hooks live" latch (seen a SessionStart or
UserPromptSubmit in this process) must gate the authority swap, and `Stop`-after-interrupt needs
one live check (unverified here). Cost: 3-5 days incl. tests on recorded payloads.
Eliminates: #30 #32 #479 #480, most of #482; leaves #478 #485 #486 (parser), #34 #35 (queue).

### B — headless stream-json runtime owned by the daemon, Joy-owned terminal view

Gains: identified input (`user` messages with our ids; `--replay-user-messages` acks),
structured permission prompts (`can_use_tool`), `interrupt`, `set_permission_mode`, `set_model`,
`rate_limit_event`, `tool_progress`, no trust dialog, no paste-detection Enter race, no C-u —
every one of the ten issues disappears by construction. Same runtime family as codex/agy/pi.
Parity cost (the terminal users attach to today, FEATURES.md "Terminal (pane) view"):
- typing into the pane: gone unless we build an input TUI; Claude's TUI (autocomplete, @file,
  image paste, vim mode, task panel, dialogs) cannot be reproduced. Users get a Joy-rendered log.
- slash commands: 66 work headless; `/resume /login /permissions /tasks /status /memory /hooks
  /export /vim /add-dir` do not — `/login` must move to `claude auth`/`setup-token` out-of-band.
- drafts: fine (app composer + relay drafts already exist); terminal drafts gone.
- resume: fine (`--resume`, shared JSONL); a user can `claude --resume` the id in a plain
  terminal only after the daemon stops its process (lock).
- background tasks: transcript + SubagentStop/Notification cover it; the shells footer is gone.
- queue semantics change: stream-json queues mid-turn messages Claude-side; joy's durable queue,
  `/steer`, and cancel must be re-derived on top of `interrupt` + our own gating.
Breaks the product promise "attach to the same pane and type"; two runtimes in flight for a
release cycle; e2e suite asserts tmux-window consistency. Cost: 15-25 days daemon + app work.
Risk: high (protocol drift in a 2.1.x weekly CLI; joy-owned view is a permanent maintenance
surface).

### C — hybrid: headless for daemon turns, TUI attach as a read-only mirror

Two-process C (TUI on the conversation + headless on the same id) is impossible: the session
lock forks the second process. One-process variants:
- C1 `--bg` + `claude attach` in the pane: users get the real TUI, but the daemon's only input
  path is still keystrokes into that attached TUI → the pane problem returns, now over a private
  supervisor protocol (`roster.json` proto 1, pty sockets). Not viable today.
- C2 headless + a Joy-owned read-only ANSI mirror: this is B minus interactive attach — every
  cost of B for parity, and the mirror is still a rendering surface we own. 8-12 days, and it
  removes the feature users rely on rather than preserving it.
C only becomes real when Claude ships a `--remote`/attach-to-headless input channel (the codex
shape) or the messaging socket accepts user prompts. Watch `claude daemon`/`attach`; do not build.

## 4. Recommendation

**STOP on B and C as the runtime replacement. GO on A, bounded.**

Three facts decided it: (1) a Claude session id is single-process — no design can run a headless
runtime beside the TUI on one conversation; (2) the only attach-to-headless Claude offers
(`--bg`/`claude attach`) takes input solely through the attached TUI keyboard, so "hybrid" is
just B with a worse view; (3) the interactive TUI already emits nearly every state edge the pane
is guessing — `UserPromptSubmit`, `Stop`, `PermissionRequest`, `Notification(type)`, `SessionEnd`,
`StopFailure`, `permission_mode` on each — and joy currently forwards a fraction and refuses to
trust any of it. The only states hooks cannot see are draft text, dialogs and the login form,
which are exactly the parser fixes the campaign already mandates ("uncertain → unknown").

**First bounded step (1-2 days, no product change):** hooks.ts `HOOK_VERSION` "4": register
`SessionEnd`, `PermissionRequest`, `StopFailure`, `PostToolUse`, `SubagentStop`; forward
`permission_mode, notification_type, prompt_id, end_reason, error_type, tool_name,
last_assistant_message`. In session.ts add a per-session `hooksLive` latch; `onHookEvent`
consumes `SessionEnd` → `end("process_exited")` (#30), `permission_mode` → persisted mode +
`setPermissionMode` verification (#480), `StopFailure(authentication_failed)` → gate the
`/login-code` path (#482). Unit tests from recorded payloads; one live check that `Stop` fires
after Esc. Then, as step two, demote `paneShowsGenerating`/foreign-turn confirm to fallback-only
when `hooksLive` (#479, #32). Re-evaluate C the day Claude's attach grows a prompt API.
