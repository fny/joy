// One agy turn's execution, as an explicit machine. The run used to be a
// record of six booleans and nullables (sawResult, turnEnded, exit,
// stdoutDone, finalized, cancelled) reconciled by hand in #maybeFinalize
// and #finalize: exit, stdout EOF, the stream's own `result`, an abort and
// the session's end can each arrive in any order (#466), and every handler
// had to re-derive what the others had done. Here the order is the
// machine's: `nextRunState(state, event)` answers every pair, and the
// EFFECTS it hands back — the turn-end row (once, #467 text flushed before
// it), the failure notice, the coordinator's terminal — are performed by
// the session. Tabled exhaustively in agyRun.test.ts.
//
//   running      the child is up; nothing has said how it ends
//   result_seen  the stream announced its end (`result`): the turn-end row
//                went out with the stream's status
//   cancelled    abort()/end() pre-empted the run: the row went out
//                `cancelled`; the child is being killed
//   finalized    settled — exit AND stdout EOF both arrived (or the run was
//                retired / never spawned); the coordinator was told
//
// Transcribed, not reconciled: a run whose stream announced FAILED settles
// with the coordinator as `completed` (the old #maybeFinalize passed
// "completed" whenever sawResult was true, whatever `result.status` said);
// the turn-end ROW carries the stream's status. Kept as the code's
// behaviour; `finalizeOutcome` names it.
export type TurnStatus = "completed" | "failed" | "cancelled";

export interface RunState {
  phase: "running" | "result_seen" | "cancelled" | "finalized";
  /** Exit observed (code null = signal). */
  exit: { code: number | null } | null;
  /** stdout reached EOF and readline emitted every line. */
  stdoutDone: boolean;
  /** The turn-end row went out (exactly once). */
  turnEnded: boolean;
  /** What the stream's `result` said (result_seen), or what the pre-emption was. */
  streamStatus: "completed" | "failed" | null;
  /** finalized only. */
  outcome: TurnStatus | null;
  why: string;
}
export type RunPhase = RunState["phase"];
export const RUN_PHASES: readonly RunPhase[] = ["running", "result_seen", "cancelled", "finalized"];

export type RunEvent =
  /** The stream's `result` line. */
  | { type: "result"; success: boolean }
  | { type: "exit"; code: number | null }
  | { type: "stdout_done" }
  /** abort(): the child is being killed; the turn ends cancelled. */
  | { type: "cancel" }
  /** end(): the session is over; whatever the child still says is not ours. */
  | { type: "retire" }
  /** spawn() threw: nothing ran. */
  | { type: "spawn_failed"; error: string }
  /** The child emitted `error` (spawn/kill failure): there may never be an
   *  exit and stdout may never open — the run settles now. */
  | { type: "process_error"; error: string };
export const RUN_EVENT_TYPES: ReadonlyArray<RunEvent["type"]> = ["result", "exit", "stdout_done", "cancel", "retire", "spawn_failed", "process_error"];

export type RunEffect =
  /** Emit the turn-end row (flushing buffered text first, #467). */
  | { type: "end_turn"; status: TurnStatus }
  /** A failure the stream did not announce: say why, before the row. */
  | { type: "warn"; why: string }
  /** The run is settled: tell the coordinator (advance the queue). */
  | { type: "finalize"; outcome: TurnStatus; why: string };

export interface RunTransition { to: RunState; effects: RunEffect[] }

export const initialRunState = (): RunState => ({ phase: "running", exit: null, stdoutDone: false, turnEnded: false, streamStatus: null, outcome: null, why: "" });

/** The terminal the coordinator is told once exit and stdout EOF are both
 *  in — the old #maybeFinalize's decision. */
export function finalizeOutcome(s: RunState): { status: "completed" | "failed"; why: string } {
  if (s.phase === "running") {
    // Nothing announced the end: the exit code decides (killed, crashed, timed out).
    const code = s.exit?.code ?? null;
    return { status: code === 0 ? "completed" : "failed", why: code === null ? "terminated" : `exit ${code}` };
  }
  return { status: "completed", why: "" };
}

/** The one answer for every (phase, event) pair, or null = the event
 *  changes nothing (a settled run's stragglers, a second `result`). */
export function nextRunState(s: RunState, ev: RunEvent): RunTransition | null {
  if (s.phase === "finalized") return null;
  switch (ev.type) {
    case "spawn_failed":
      return s.phase === "running"
        ? { to: { ...s, phase: "finalized", turnEnded: true, outcome: "failed", why: ev.error }, effects: s.turnEnded ? [] : [{ type: "end_turn", status: "failed" }] }
        : null;
    case "retire": {
      const effects: RunEffect[] = s.turnEnded ? [] : [{ type: "end_turn", status: "cancelled" }];
      return { to: { ...s, phase: "finalized", turnEnded: true, outcome: "cancelled", why: "retired" }, effects };
    }
    case "cancel":
      if (s.phase !== "running") return null;
      return { to: { ...s, phase: "cancelled", turnEnded: true, streamStatus: null }, effects: s.turnEnded ? [] : [{ type: "end_turn", status: "cancelled" }] };
    case "result": {
      if (s.phase !== "running") return null;
      const status = ev.success ? "completed" : "failed";
      return { to: { ...s, phase: "result_seen", turnEnded: true, streamStatus: status }, effects: s.turnEnded ? [] : [{ type: "end_turn", status }] };
    }
    case "exit": return settle({ ...s, exit: { code: ev.code } });
    case "stdout_done": return settle({ ...s, stdoutDone: true });
    case "process_error": {
      const effects: RunEffect[] = [];
      if (!s.turnEnded) effects.push({ type: "warn", why: ev.error }, { type: "end_turn", status: "failed" });
      const outcome: TurnStatus = s.phase === "cancelled" ? "cancelled" : "failed";
      effects.push({ type: "finalize", outcome, why: ev.error });
      return { to: { ...s, phase: "finalized", turnEnded: true, outcome, why: ev.error }, effects };
    }
  }
}

/** Exit status AND stdout EOF both in: the run settles, once. */
function settle(s: RunState): RunTransition {
  if (!s.exit || !s.stdoutDone) return { to: s, effects: [] };
  const { status, why } = finalizeOutcome(s);
  const effects: RunEffect[] = [];
  if (status === "failed" && !s.turnEnded) effects.push({ type: "warn", why });
  if (!s.turnEnded) effects.push({ type: "end_turn", status });
  const outcome: TurnStatus = s.phase === "cancelled" ? "cancelled" : status;
  effects.push({ type: "finalize", outcome, why });
  return { to: { ...s, phase: "finalized", turnEnded: true, outcome, why }, effects };
}
