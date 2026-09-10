// The CLI contract as a table: every state a session can be in when a `joy`
// verb arrives × every verb that acts on a session → the exit code, what the
// daemon must have done, and what `joy check` says afterwards.
//
// This is the specification. cli.matrix.test.ts walks the whole product
// against the real daemon path (transport → operations → coordinator) with a
// scripted agent runtime, so a cell that fails is either a bug or a wrong
// claim here — never a test that quietly skipped the case. Read the table,
// not the tests.
//
// Vocabulary
//   state    what the session looks like when the verb arrives
//   exit     the process exit code the verb must return
//   effect   what the daemon did with the verb
//              none         nothing accepted, nothing interrupted
//              delivered    the text reached the runtime now (one submit)
//              queued       the text is a pending row; the runtime saw nothing
//              refused      the daemon rejected the text (busy / mode / ended)
//              answered     ask: the reply came back; approve/deny: the held
//                           approval was answered
//              interrupted  an interrupt reached the runtime: the running
//                           turn's, or the session-wide Escape the daemon
//                           sends when nothing attributable runs (a turn
//                           started in the terminal is invisible to it)
//              killed       the session is gone from the daemon
//              mode_set     the session's permission mode changed
//   after    `joy check`'s exit once the dust settles: 0 idle · 3 busy ·
//            6 needs input · 1 ended/unreachable · "gone" (1, and unlisted)

export const STATES = [
  "gone",          // no such session on this daemon
  "ended",         // detached: the runtime exited, the session is still listed
  "idle",          // active, nothing running, empty queue, yolo
  "busy",          // a command's turn is running, empty queue
  "busy_queued",   // a turn is running and one more command waits behind it
  "paused",        // nothing running, one command waiting, the queue is paused (dispatch gave up on the pane)
  "approval",      // a turn is running and holds a command approval for the human
  "permission",    // a turn is running and the harness reported a permission prompt (hook wait)
  "question",      // idle; the last reply ended with a <joy-options> block
  "unscriptable",  // idle, but the mode is neither yolo nor read-only (exclusive sends are refused)
  "daemon_down",   // the daemon does not answer at all
] as const;
export type State = (typeof STATES)[number];

export const ACTIONS = [
  "check", "send", "send_no_queue", "ask", "wait", "abort", "approve", "deny", "queue", "resume", "kill", "mode", "about", "ls",
] as const;
export type Action = (typeof ACTIONS)[number];

export type Effect = "none" | "delivered" | "queued" | "refused" | "answered" | "interrupted" | "killed" | "mode_set";
export type After = 0 | 3 | 6 | 1 | "gone";
export interface Cell { exit: number; effect: Effect; after: After; note?: string }

const c = (exit: number, effect: Effect, after: After, note?: string): Cell => ({ exit, effect, after, ...(note ? { note } : {}) });

/** The whole table. Rows are states, columns are actions. */
export const TABLE: Record<State, Record<Action, Cell>> = {
  gone: {
    check: c(1, "none", "gone"), send: c(1, "refused", "gone"), send_no_queue: c(1, "refused", "gone"), ask: c(1, "refused", "gone"),
    wait: c(1, "none", "gone"), abort: c(1, "none", "gone"), approve: c(1, "none", "gone"), deny: c(1, "none", "gone"),
    queue: c(1, "none", "gone"), resume: c(1, "none", "gone"), kill: c(1, "none", "gone"), mode: c(1, "none", "gone"),
    about: c(1, "none", "gone"), ls: c(0, "none", "gone", "listed nowhere"),
  },
  daemon_down: {
    check: c(1, "none", 1), send: c(1, "refused", 1), send_no_queue: c(1, "refused", 1), ask: c(1, "refused", 1),
    wait: c(1, "none", 1), abort: c(1, "none", 1), approve: c(1, "none", 1), deny: c(1, "none", 1),
    queue: c(1, "none", 1), resume: c(1, "none", 1), kill: c(1, "none", 1), mode: c(1, "none", 1),
    about: c(1, "none", 1), ls: c(1, "none", 1, "\"daemon not running\""),
  },
  ended: {
    check: c(1, "none", 1, "prints ended (process_exited)"),
    send: c(1, "refused", 1, "a detached session takes no text: session_ended"),
    send_no_queue: c(1, "refused", 1), ask: c(1, "refused", 1), wait: c(1, "none", 1, "gone: the session ended"),
    abort: c(1, "none", 1, "nothing runs on a detached session; the daemon says ok:false"),
    approve: c(0, "none", 1, "no pending approvals"), deny: c(0, "none", 1),
    queue: c(0, "none", 1, "queue empty"), resume: c(0, "none", 1),
    kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 1, "recorded for the next start"),
    about: c(0, "none", 1), ls: c(0, "none", 1, "listed as ended"),
  },
  idle: {
    check: c(0, "none", 0), send: c(0, "delivered", 3), send_no_queue: c(0, "delivered", 3), ask: c(0, "answered", 0),
    wait: c(0, "none", 0, "already idle"), abort: c(0, "interrupted", 0, "a session-wide interrupt (Escape) goes out even with nothing attributable — a turn started in the terminal is invisible to the daemon; exit 0"),
    approve: c(0, "none", 0, "no pending approvals"), deny: c(0, "none", 0),
    queue: c(0, "none", 0), resume: c(0, "none", 0), kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 0),
    about: c(0, "none", 0), ls: c(0, "none", 0, "listed idle"),
  },
  busy: {
    check: c(3, "none", 3), send: c(0, "queued", 3), send_no_queue: c(3, "refused", 3, "exclusive: busy"),
    ask: c(0, "answered", 0, "queued behind the turn; the reply is its OWN turn's text once it runs"),
    wait: c(0, "none", 0, "returns when the turn ends"), abort: c(0, "interrupted", 0),
    approve: c(0, "none", 3), deny: c(0, "none", 3), queue: c(0, "none", 3, "the running command is not a queued row"),
    resume: c(0, "none", 3), kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 3),
    about: c(0, "none", 3), ls: c(0, "none", 3, "listed busy"),
  },
  busy_queued: {
    check: c(3, "none", 3, "busy, 1 queued"), send: c(0, "queued", 3), send_no_queue: c(3, "refused", 3),
    ask: c(0, "answered", 0, "runs after the row ahead of it; the reply is its own"),
    wait: c(0, "delivered", 0, "returns once the turn AND the queued row are done — the row is delivered during the wait"),
    abort: c(0, "interrupted", 3, "the queued row survives the interrupt and runs next"),
    approve: c(0, "none", 3), deny: c(0, "none", 3), queue: c(0, "none", 3, "lists the queued row"),
    resume: c(0, "none", 3), kill: c(0, "killed", "gone", "the queued row is dropped with the session"), mode: c(0, "mode_set", 3),
    about: c(0, "none", 3), ls: c(0, "none", 3),
  },
  paused: {
    check: c(0, "none", 0, "check reads idle with 1 queued — it does not name the pause (see cli.sequences for the resume)"),
    send: c(0, "queued", 0, "queued behind the stuck row; nothing drains"),
    send_no_queue: c(3, "refused", 0, "a pending row counts as busy for an exclusive send"),
    ask: c(4, "queued", 0, "nothing drains a paused queue: the ask times out, its row stays"),
    wait: c(0, "none", 0, "wait reads idle — a paused queue is invisible to it"),
    abort: c(0, "interrupted", 0, "session-wide Escape; the paused row stays put"), approve: c(0, "none", 0), deny: c(0, "none", 0),
    queue: c(0, "none", 0, "lists the row and says (queue paused)"),
    resume: c(0, "delivered", 3, "joy queue <s> resume: the stuck row is dispatched"),
    kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 0), about: c(0, "none", 0), ls: c(0, "none", 0),
  },
  approval: {
    check: c(6, "none", 6, "needs input — approval: <title>"), send: c(0, "queued", 6), send_no_queue: c(3, "refused", 6),
    ask: c(6, "queued", 6, "the row is queued; the wait ends at once because the session needs a human"),
    wait: c(6, "none", 6), abort: c(0, "interrupted", 0, "the interrupt drops the approval with the turn"),
    approve: c(0, "answered", 3, "the agent carries on with its turn"), deny: c(0, "answered", 0, "the agent stops and ends its turn"),
    queue: c(0, "none", 6), resume: c(0, "none", 6), kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 6),
    about: c(0, "none", 6), ls: c(0, "none", 6, "listed needs input"),
  },
  permission: {
    check: c(6, "none", 6, "needs input — a permission prompt in the terminal"), send: c(0, "queued", 6), send_no_queue: c(3, "refused", 6),
    ask: c(6, "queued", 6), wait: c(6, "none", 6), abort: c(0, "interrupted", 0),
    approve: c(0, "none", 6, "a hook-reported prompt is answered in the terminal or the app; the CLI has no approval to answer"),
    deny: c(0, "none", 6), queue: c(0, "none", 6), resume: c(0, "none", 6), kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 6),
    about: c(0, "none", 6), ls: c(0, "none", 6),
  },
  question: {
    check: c(6, "none", 6, "needs input — question: … [A | B]"),
    send: c(0, "delivered", 3, "the answer (\"2\") goes straight in: the session is idle underneath"),
    send_no_queue: c(0, "delivered", 3), ask: c(0, "answered", 0, "the reply replaces the question"),
    wait: c(6, "none", 6, "waiting on a question is waiting on you"), abort: c(0, "interrupted", 6, "session-wide Escape; the question is still the last reply"),
    approve: c(0, "none", 6), deny: c(0, "none", 6), queue: c(0, "none", 6), resume: c(0, "none", 6),
    kill: c(0, "killed", "gone"), mode: c(0, "mode_set", 6), about: c(0, "none", 6), ls: c(0, "none", 6),
  },
  unscriptable: {
    check: c(0, "none", 0), send: c(0, "delivered", 3, "a plain send never looks at the mode"),
    send_no_queue: c(5, "refused", 0, "exclusive sends drive only yolo / read-only sessions"),
    ask: c(0, "answered", 0), wait: c(0, "none", 0), abort: c(0, "interrupted", 0, "session-wide Escape"), approve: c(0, "none", 0), deny: c(0, "none", 0),
    queue: c(0, "none", 0), resume: c(0, "none", 0), kill: c(0, "killed", "gone"),
    mode: c(0, "mode_set", 0, "→ yolo: the next exclusive send is accepted"), about: c(0, "none", 0), ls: c(0, "none", 0),
  },
};

export function expected(state: State, action: Action): Cell { return TABLE[state][action]; }

/** Every (state, action) pair — the matrix walks this. */
export function cells(): Array<{ state: State; action: Action; cell: Cell }> {
  const out: Array<{ state: State; action: Action; cell: Cell }> = [];
  for (const state of STATES) for (const action of ACTIONS) out.push({ state, action, cell: TABLE[state][action] });
  return out;
}
