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

## Why C-u and not C-c (the 2026-07-02 forensics)

During the v1.1.0→v1.3.x e2e run, an abort-storm test left text in the input box
that C-c would not clear — twice, minutes apart — while a single C-u cleared it.
That was first committed as "Claude 2.1.x made C-c a no-op on a filled box".
**That explanation is wrong.** Controlled retesting on both 2.1.197 and 2.1.198
(idle box, multi-line box, text typed mid-generation, Escape-interrupted state)
showed a healthy foreground claude clears a filled box — including a multi-line
box — with **one C-c, every time**.

The real mechanism, reproduced live:

- joy-tmux runs `claude` as a job under an **interactive bash** in the pane (so
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
