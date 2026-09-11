// The pi session's process, as an explicit machine. pi runs as ONE child
// per session (`pi --mode rpc`, JSONL on stdio); a restart is a new session
// object over the same on-disk conversation, so the only two-process moment
// is the handover: end() SIGTERMs the old child and the replacement's
// awaitExit() waits for it to be gone (two writers on one conversation is
// how history gets corrupted — codex review, 2026-09-04). That handover used
// to be two slots on the session (`#proc`, the live child; `#dying`, the one
// end() signalled) plus `#started`, and the turn bookkeeping pi's events
// drive (`#turn` / `#turnSeq` / `#thinking`) was set from five handlers.
// Here it is one value, stepped by `nextPiProcess` (the pattern of
// relay/leaseMachine.ts and domain/coordinator.ts; tabled exhaustively in
// piProcess.test.ts). The session keeps the ChildProcess HANDLE — that is
// I/O — and asks the machine what the handle means.
//
//   idle      constructed, nothing spawned
//   running   the child is up (`pid`); a turn may be open; pi may be thinking
//   ended     the session is over (`reason`). `dying`: the child end()
//             signalled has not exited yet — awaitExit's subject. A child
//             that exited on its own (or was never alive) leaves nothing to
//             wait for.
//
// Turn ids carry a monotonic seq (pi's turn_start has no id); the SESSION
// formats them (`pi:<id>:<boot>:t<seq>`, #575) — the machine holds the seq
// and whether a turn is open. `thinking` is what the relay is told: set on
// turn_start, cleared on agent_end, a pi error, an abort, or the end.
//
// The coordinator owns the command/turn machine (domain/coordinator.ts);
// this one owns only the process and what the session derives from it.

export type PiEndReason = "killed" | "process_exited" | "restart";
export type PiPhase = "idle" | "running" | "ended";
export const PI_PHASES: readonly PiPhase[] = ["idle", "running", "ended"];

export interface PiProcessState {
  phase: PiPhase;
  /** running: the live child's pid (undefined when spawn gave none).
   *  ended: the pid awaitExit waits on while `dying`; else null. */
  pid: number | null | undefined;
  /** ended: end() signalled a live child and its exit has not been seen. */
  dying: boolean;
  reason: PiEndReason | null;
  /** Monotonic turn counter; the open turn (if any) is turn `turnSeq`. */
  turnSeq: number;
  turnOpen: boolean;
  thinking: boolean;
}

export type PiProcessEvent =
  /** spawn() returned a child (pid may be unknown until it starts). */
  | { type: "spawned"; pid: number | undefined }
  | { type: "spawn_failed"; error: string }
  /** The child's exit (or a spawn/stdin error, which the session treats the same). */
  | { type: "exited"; pid: number | null | undefined }
  /** end(reason): `alive` = the child has no exit code yet (it must be signalled). */
  | { type: "end"; reason: PiEndReason; alive: boolean }
  | { type: "turn_start" }
  | { type: "turn_end" }
  /** pi's `agent_end`: the run settled, every queued steer delivered. */
  | { type: "agent_end" }
  /** pi's `error` row: the open turn (if any) failed. */
  | { type: "error" }
  /** The coordinator's abort reached pi: the open turn (if any) is cancelled. */
  | { type: "abort_ok" };
export const PI_EVENT_TYPES: ReadonlyArray<PiProcessEvent["type"]> = [
  "spawned", "spawn_failed", "exited", "end", "turn_start", "turn_end", "agent_end", "error", "abort_ok",
];

/** What the session must DO alongside the state change, in order. */
export type PiEffect =
  /** SIGTERM the live child; `exited` for its pid ends `dying`. */
  | { type: "kill_process"; pid: number | undefined }
  /** The open turn's relay row closes with this status (turn `seq`). */
  | { type: "turn_end"; seq: number; status: "cancelled" | "failed" }
  /** The relay's thinking flag changed. */
  | { type: "notify_thinking"; on: boolean }
  /** The driver learns the turn it was running is over (abort only: the
   *  other terminal edges — agent_end, error — are reported by the session
   *  whether or not a turn was open, so they are not state-dependent). */
  | { type: "driver_turn_ended"; status: "cancelled" };

export interface PiTransition { to: PiProcessState; effects: PiEffect[] }

export function initialPiProcess(status: "starting" | "active" | "ended", reason: PiEndReason | null = null): PiProcessState {
  const base = { pid: null, dying: false, reason: null, turnSeq: 0, turnOpen: false, thinking: false };
  // A session constructed already ended (a detached record being listed):
  // nothing to spawn, nothing to wait for.
  if (status === "ended") return { ...base, phase: "ended", reason: reason ?? "process_exited" };
  return { ...base, phase: "idle" };
}

/** The one answer for every (state, event) pair, or null = the event means
 *  nothing in that phase and changes nothing: a second end() (the code
 *  returned false), pi rows that arrive after the process is gone, an exit
 *  of a child that is not the one being waited for. */
export function nextPiProcess(s: PiProcessState, ev: PiProcessEvent): PiTransition | null {
  switch (s.phase) {
    case "idle": switch (ev.type) {
      case "spawned": return { to: { ...s, phase: "running", pid: ev.pid }, effects: [] };
      case "spawn_failed": return { to: { ...s, phase: "ended", reason: "process_exited" }, effects: [] };
      // Ended before it ever started (a kill racing the spawn): no child to signal.
      case "end": return { to: { ...s, phase: "ended", reason: ev.reason }, effects: [] };
      default: return null;
    }
    case "running": switch (ev.type) {
      case "spawned": return null;
      case "spawn_failed": return null;
      // The child went on its own: the session ends process_exited, the
      // open turn closes cancelled, thinking clears. Nothing to wait for.
      case "exited": return closeTurns({ ...s, phase: "ended", pid: null, dying: false, reason: "process_exited" }, s, "cancelled", []);
      case "end": {
        const effects: PiEffect[] = ev.alive ? [{ type: "kill_process", pid: s.pid ?? undefined }] : [];
        return closeTurns({ ...s, phase: "ended", pid: ev.alive ? s.pid : null, dying: ev.alive, reason: ev.reason }, s, "cancelled", effects);
      }
      case "turn_start": {
        const to = { ...s, turnSeq: s.turnSeq + 1, turnOpen: true, thinking: true };
        return { to, effects: s.thinking ? [] : [{ type: "notify_thinking", on: true }] };
      }
      case "turn_end": return { to: { ...s, turnOpen: false }, effects: [] };
      case "agent_end": return { to: { ...s, thinking: false }, effects: s.thinking ? [{ type: "notify_thinking", on: false }] : [] };
      case "error": return closeTurns({ ...s, thinking: false }, s, "failed", []);
      case "abort_ok": {
        if (!s.turnOpen) return null;
        const t = closeTurns({ ...s, thinking: false }, s, "cancelled", []);
        t.effects.push({ type: "driver_turn_ended", status: "cancelled" });
        return t;
      }
      default: return null;
    }
    case "ended": switch (ev.type) {
      // The child end() signalled is gone: awaitExit has its answer.
      case "exited": return s.dying && ev.pid === s.pid ? { to: { ...s, dying: false, pid: null }, effects: [] } : null;
      default: return null;
    }
  }
  return null;
}

/** Close the open turn (if any) with `status` and clear thinking, on top of
 *  `to`: the shared tail of exit, end, error and abort. */
function closeTurns(to: PiProcessState, from: PiProcessState, status: "cancelled" | "failed", effects: PiEffect[]): PiTransition {
  if (from.turnOpen) effects.push({ type: "turn_end", seq: from.turnSeq, status });
  if (from.thinking) effects.push({ type: "notify_thinking", on: false });
  return { to: { ...to, turnOpen: false, thinking: false }, effects };
}

/** Is there a child to write to? */
export const piAlive = (s: PiProcessState): boolean => s.phase === "running";
/** Is there a signalled child still to wait for? */
export const piExiting = (s: PiProcessState): boolean => s.phase === "ended" && s.dying;
