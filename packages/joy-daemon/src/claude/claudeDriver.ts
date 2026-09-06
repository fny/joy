// The claude RuntimeDriver (Wave C2, phase 5): the coordinator's view of a
// Claude Code TUI in a tmux pane. A submission is the Session's own
// dispatch path — the pane gate (fresh capture: not generating unless the
// hooks say idle, at the ready prompt, an EMPTY box; a dirty box cleared
// with the verified C-u loop, docs/pane-input-clearing.md), the typed
// lines, the delayed Enter — run under the pane-writer lease, and it
// resolves once the runtime proves delivery (UserPromptSubmit with the
// exact text, the transcript's user echo, a <command-name> / <bash-input>
// echo, a slash command's dialog, or the hook-less turn-start-with-fresh-
// box read) or the echo window closes. Readiness is
// `Session.promptReadiness()`; the turn edges come from the hook-owned turn
// state (UserPromptSubmit / Stop / StopFailure / idle) with the transcript's
// tail as the tie-breaker; interrupt is the Escape path; there is no
// history API, so an attempt a dead process left unanswered is `absent`
// (retyped, as Claude always was) — unless its echo already replayed from
// the transcript, in which case it is already running.
//
// Capability facts the coordinator relies on:
//   - terminalDraft: a human may be typing in the same box — the Session
//     preserves and restores that draft (draft_preserved);
//   - steer: `/steer` and `/btw` are commands of origin `steer`, typed ahead
//     of the FIFO into the running turn through the SAME pane serialization
//     (one pane operation at a time, #34);
//   - the interrupt is a keystroke (Escape) — session-wide, never targeted;
//   - the echo is the runtime ref = the flattened text (identical texts
//     pair in submission order, #437).
import type { RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand } from "../domain/coordinator";

export interface ClaudeRuntimePort {
  readonly sessionId: string;
  /** The pane gate for ONE command: resolves once the box is ready + empty. */
  awaitGate(cmd: CommandView, signal: AbortSignal): Promise<"ready" | "cancelled" | "retired">;
  /** The dispatch path for ONE command (gate already passed); resolves with the runtime's verdict. */
  dispatch(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult>;
  /** /steer: type into the pane NOW (mid-turn), submit after the settle delay. */
  steer(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult>;
  /** The Escape path. */
  interrupt(): Promise<InterruptResult>;
  /** The flattened text an echo is matched on. */
  runtimeRef(text: string): string;
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  /** Lift a queue pause (input_dirty → clear the box first). */
  resume(): void;
}

export const CLAUDE_CAPABILITIES: DriverCapabilities = {
  steer: true, targetedInterrupt: false, ambiguousSubmit: false, terminalDraft: true, echo: "transcript", concurrentSubmit: false,
};

export class ClaudeDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities = CLAUDE_CAPABILITIES;
  #port: ClaudeRuntimePort;
  #sinks = new Set<(o: Observation) => void>();

  constructor(port: ClaudeRuntimePort, generation: number) {
    this.sessionId = port.sessionId;
    this.generation = generation;
    this.#port = port;
  }

  /** The session feeds what the hooks, the transcript and the pane said. */
  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }
  runtimeRef(cmd: CommandView): string { return this.#port.runtimeRef(cmd.text); }
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null { return this.#port.handleCommand(text, opts); }
  resume(): void { this.#port.resume(); }

  prepare(cmd: CommandView, signal: AbortSignal): Promise<"ready" | "cancelled" | "retired"> { return this.#port.awaitGate(cmd, signal); }
  submit(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> { return this.#port.dispatch(cmd, attempt, signal); }
  steer(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> { return this.#port.steer(cmd, attempt, signal); }
  interrupt(): Promise<InterruptResult> { return this.#port.interrupt(); }

  async reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    return pending.map((p) => ({ attemptId: p.attemptId, outcome: "absent" as const }));
  }
}
