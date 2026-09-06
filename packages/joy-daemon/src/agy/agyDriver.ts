// The agy RuntimeDriver (Wave C2): ONE headless `agy --print` process per
// turn. A submission spawns the turn's process and writes the prompt on its
// stdin — that write is the delivery (echo "process"); the run's settlement
// (exit status + stdout EOF, #466) is the turn's terminal. An interrupt
// kills the turn's process (targeted: the attempt's turn IS the process).
// No resident process survives a restart, so an attempt the old daemon left
// in flight is `absent`: the turn is re-run, at least once.
import type { RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand } from "../domain/coordinator";

export interface AgyRuntimePort {
  readonly sessionId: string;
  /** Spawn the turn's process and hand it the prompt. */
  startTurn(text: string, attempt: AttemptRef): { ok: true; turn: string } | { ok: false; error: string };
  /** Kill the named turn's process (or the current one). `noop` = nothing runs. */
  abortTurn(turn: string | null): "sent" | "noop";
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null;
  mirrorAccepted(cmd: CommandView): void;
}

export const AGY_CAPABILITIES: DriverCapabilities = {
  steer: false, targetedInterrupt: true, ambiguousSubmit: false, terminalDraft: false, echo: "process", concurrentSubmit: false,
};

export class AgyDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  readonly capabilities = AGY_CAPABILITIES;
  #port: AgyRuntimePort;
  #sinks = new Set<(o: Observation) => void>();

  constructor(port: AgyRuntimePort, generation: number) {
    this.sessionId = port.sessionId;
    this.generation = generation;
    this.#port = port;
  }

  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }
  handleCommand(text: string, opts: { source: string; mirrorToRelay: boolean; seq?: number | null }): HandledCommand | null { return this.#port.handleCommand(text, opts); }
  accepted(cmd: CommandView): void { this.#port.mirrorAccepted(cmd); }

  async submit(cmd: CommandView, attempt: AttemptRef): Promise<SubmitResult> {
    const r = this.#port.startTurn(cmd.text, attempt);
    if (!r.ok) return { kind: "rejected", permanent: true, detail: r.error.slice(0, 200) };
    // The prompt is with the harness: delivered. Its RESULT is the turn's
    // outcome, reported as turn_ended when the run settles.
    this.emit({ kind: "echo", runtimeRef: attempt.runtimeRef, runtimeTurnId: r.turn });
    return { kind: "accepted", runtimeTurnId: r.turn };
  }

  async interrupt(target: { attempt: AttemptRef | null }): Promise<InterruptResult> {
    return { kind: this.#port.abortTurn(target.attempt?.runtimeTurnId ?? null) };
  }

  async reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    return pending.map((p) => ({ attemptId: p.attemptId, outcome: "absent" as const }));
  }
}
