# Pane input-box clearing: design + forensics

**Read this before touching `#clearInputIfDirty`, `#clearBoxWithCtrlU`, the
`#drainOnce` dirty branch, or `abort()` in `src/claude/session.ts`.** Several
"obvious fixes" here are traps that were walked into and out of the hard way
(live e2e, 2026-07-01/02).

## The invariants

1. **Clearing happens ONLY at the pre-type gates** — `#drainOnce` (the dispatch
   queue's empty-box gate) and `#steer` (which bypasses the queue and clears for
   itself). `abort()` sends **Escape and nothing else**.
2. **The clear key is C-u, looped and verified — never C-c.**
3. **Never type over residue.** A clear that cannot verify an empty box reports
   failure; the dispatch path pauses with the `input_dirty` banner and the steer
   path falls back to the queue head. Typing anyway concatenates the leftover and
   the new message into one garbled submit.
4. **Be patient before declaring a box unclearable.** A busy claude processes
   buffered keys *late*; a single quick re-capture misreads "busy" as "broken".
   The drain requires two full failed clear episodes, spaced 750ms, before it
   pauses.
5. **An `input_dirty` pause is provisional, not a latch.** It self-heals the
   moment the box reads verifiably empty again (`#recheckDirtyPause`). The
   `dispatch_*` pauses do NOT — see below.

## Why C-u and not C-c (the 2026-07-02 forensics)

During the v1.1.0→v1.3.x e2e run, an abort-storm test left text in the input box
that C-c would not clear — twice, minutes apart — while a single C-u cleared it.
That was first committed as "Claude 2.1.x made C-c a no-op on a filled box".
**That explanation is wrong.** Controlled retesting on both 2.1.197 and 2.1.198
(idle box, multi-line box, text typed mid-generation, Escape-interrupted state)
showed a healthy foreground claude clears a filled box — including a multi-line
box — with **one C-c, every time**.

The real mechanism, reproduced live:

- joy-daemon runs `claude` as a job under an **interactive bash** in the pane (so
  the user gets a shell + resume hint when claude exits). Interactive bash means
  **job control**.
- If claude **stalls or stops** (SIGSTOP as the stand-in; in the wild: an
  event-loop stall under load, or SIGTTIN from process-group churn when aborts
  kill tool subprocesses mid-flight — exactly what an abort storm produces),
  bash's job control takes the tty back and restores **cooked mode** (`isig`,
  `echo` on). Claude's TUI **stays painted** (background writes are allowed), so
  the pane looks completely healthy.
- In that state **^C is not a keypress — it's SIGINT**. It goes to bash (echoed
  as `^C`, an invisible no-op against the TUI), or to a dead process group
  (silent no-op), or — once claude is foreground again with the tty still
  cooked — **to claude, which exits**. Both the no-op and the session-kill were
  reproduced live. The pre-C-u daemon was firing a potential session-killer as
  its "clear".
- **^U can never become a signal.** In raw mode it's the byte claude reads as
  kill-line; in cooked mode it's the kernel's own line-kill. Stray C-u's on an
  empty box are harmless no-ops, so buffered presses that land late are safe.
- Diagnostic fingerprint of the damaged state: `stty -a -F <pane_tty>` shows
  `isig` (healthy claude runs `-isig -icanon`), and keypresses stop changing the
  box. `#clearBoxWithCtrlU` detects the second signal (three presses with no
  change) and reports failure instead of blasting its budget.

Also verified: a "failed" clear can be a **timing illusion** — a stalled claude
processes the buffered clear when it wakes, so whatever key was sent last gets
the credit in a quick capture. This is why the drain waits 750ms between clear
episodes rather than concluding from a 200ms re-check, and why single-capture
"verification" is never trusted.

## Why C-u is looped with a line-sized budget

C-u kills **one line per press**, and consuming the line break costs another
press: a 3-line box takes exactly 6 presses (measured). The press budget is
`min(40, 2 × rendered-box-lines + 4)` via `paneInputLineSpan`. A flat budget of
6 (the original implementation) silently left residue on any box taller than 3
lines — and then reported success, letting a steer type into it.

## Why the input_dirty pause self-heals (the 2026-08-17 forensics)

Reported as "why is this session stuck?" — a boite session sat with `QUEUED · 1`
and the *"input box has stray text — tap to clear and resume"* banner while the
live pane showed a **completely empty box**.

The daemon log had the whole story: a queued message arrived, the drain gate
paused with `input box dirty + unclearable`, the user resumed and tapped the
steer arrow, and `#steer`'s own clear then failed and re-paused — silently, since
that path pauses without logging. By the time anyone looked, the box was clean.

That is the **timing illusion** documented above, one layer up: the C-u presses
the clear loop gave up on were merely *buffered*, and landed a beat later. The
box healed; `#queuePaused` did not, because nothing ever re-evaluated it. Both
the drain gate and `resumeQueue` only run when something *else* pokes them, so
the session stayed blocked indefinitely on a condition that no longer existed.

`#recheckDirtyPause` closes that hole — the same verification the gate uses,
repeated on a timer (dense at first, then a slow heartbeat), permitted only ever
to **relax** the block:

- Only `input_dirty` self-heals. Its blocking condition is externally
  verifiable. `dispatch_timeout` / `dispatch_mismatch` / `dispatch_failed` mean a
  message may have *half*-landed, so re-sending is a human's judgment call and
  those stay latched (there is a test pinning this).
- Only a **strictly empty** box (`""`) heals it. A `null` box (dialog, menu, not
  ready) is "unknown", not "clean" — the same convention `#drainOnce` uses — and
  human-typed text keeps the pause, so a draft is never silently discarded.
- A false heal is cheap: `#drainOnce` independently re-verifies an empty box on a
  fresh capture before it types anything, and will simply re-clear/re-pause. The
  probe can only ever hand control back to the real gate.

## Why abort() does not clear the box

Abort used to arm a 400ms-delayed clear (`#abortClearTimer`). Removed
2026-07-02:

- **Redundant for correctness.** Every type-site independently verifies an empty
  box first, and "an aborted message is never re-sent" is enforced by receipt
  neutralization + not requeuing — not by the box being visually empty.
- **Maximally risky timing.** Right after an interrupt is precisely when the
  pane is most likely to be stalled or job-control-cooked — when control keys
  are swallowed, buffered into whatever state comes next, or (as C-c) lethal.

Accepted trade-off: an aborted-but-unsubmitted message stays visible in the
tmux pane until the next send's gate clears it. A human attached to the pane
could submit it with a stray Enter; the daemon itself cannot.
