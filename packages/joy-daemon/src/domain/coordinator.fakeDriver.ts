// Test support for the session coordinator: a scriptable RuntimeDriver and
// a manual clock. Every submit/interrupt/reconcile is a recorded call the
// test settles explicitly, so the failure-order harnesses (test-scenarios/)
// replay with the SAME interleavings against the coordinator's contract.
import type {
  RuntimeDriver, DriverCapabilities, CommandView, AttemptRef, SubmitResult, InterruptResult, ReconcileOutcome, Observation, HandledCommand,
} from "./coordinator";

export interface Deferred<T> { resolve: (v: T) => void; reject: (e: unknown) => void; promise: Promise<T> }
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
}

export const CODEX_LIKE: DriverCapabilities = { steer: false, targetedInterrupt: true, ambiguousSubmit: true, terminalDraft: false, echo: "clientId", concurrentSubmit: false };
export const OPENCODE_LIKE: DriverCapabilities = { steer: true, targetedInterrupt: false, ambiguousSubmit: false, terminalDraft: false, echo: "admission", concurrentSubmit: true };
export const CLAUDE_LIKE: DriverCapabilities = { steer: true, targetedInterrupt: false, ambiguousSubmit: false, terminalDraft: true, echo: "transcript", concurrentSubmit: false };

export interface SubmitCall { cmd: CommandView; attempt: AttemptRef; settle: Deferred<SubmitResult>; steer: boolean; signal: AbortSignal }
export interface InterruptCall { attempt: AttemptRef | null; settle: Deferred<InterruptResult> }
export interface ReconcileCall { pending: AttemptRef[]; settle: Deferred<ReconcileOutcome[]> }

export class FakeDriver implements RuntimeDriver {
  readonly sessionId: string;
  readonly generation: number;
  capabilities: DriverCapabilities;
  submits: SubmitCall[] = [];
  interrupts: InterruptCall[] = [];
  reconciles: ReconcileCall[] = [];
  acceptedViews: CommandView[] = [];
  /** Auto-answer scripts; absent → the call stays pending until the test settles it. */
  onSubmit: ((call: SubmitCall) => SubmitResult | Promise<SubmitResult> | void) | null = null;
  onInterrupt: ((call: InterruptCall) => InterruptResult | void) | null = null;
  onReconcile: ((call: ReconcileCall) => ReconcileOutcome[] | void) | null = null;
  commands: ((text: string) => HandledCommand | null) | null = null;
  #sinks = new Set<(o: Observation) => void>();

  constructor(sessionId: string, generation: number, capabilities: DriverCapabilities = CODEX_LIKE) {
    this.sessionId = sessionId; this.generation = generation; this.capabilities = capabilities;
  }

  handleCommand(text: string): HandledCommand | null { return this.commands ? this.commands(text) : null; }
  accepted(cmd: CommandView): void { this.acceptedViews.push(cmd); }

  submit(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> { return this.#submit(cmd, attempt, signal, false); }
  steer(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal): Promise<SubmitResult> { return this.#submit(cmd, attempt, signal, true); }
  #submit(cmd: CommandView, attempt: AttemptRef, signal: AbortSignal, steer: boolean): Promise<SubmitResult> {
    const call: SubmitCall = { cmd, attempt, settle: deferred<SubmitResult>(), steer, signal };
    this.submits.push(call);
    if (this.onSubmit) {
      const r = this.onSubmit(call);
      if (r && typeof (r as Promise<SubmitResult>).then === "function") (r as Promise<SubmitResult>).then(call.settle.resolve, call.settle.reject);
      else if (r) call.settle.resolve(r as SubmitResult);
    }
    return call.settle.promise;
  }
  interrupt(target: { attempt: AttemptRef | null }): Promise<InterruptResult> {
    const call: InterruptCall = { attempt: target.attempt, settle: deferred<InterruptResult>() };
    this.interrupts.push(call);
    if (this.onInterrupt) { const r = this.onInterrupt(call); if (r) call.settle.resolve(r); }
    return call.settle.promise;
  }
  reconcile(pending: AttemptRef[]): Promise<ReconcileOutcome[]> {
    const call: ReconcileCall = { pending, settle: deferred<ReconcileOutcome[]>() };
    this.reconciles.push(call);
    if (this.onReconcile) { const r = this.onReconcile(call); if (r) call.settle.resolve(r); }
    else if (!pending.length) call.settle.resolve([]);
    return call.settle.promise;
  }
  observe(sink: (o: Observation) => void): () => void {
    this.#sinks.add(sink);
    return () => { this.#sinks.delete(sink); };
  }
  emit(o: Observation): void { for (const s of [...this.#sinks]) s(o); }
  ready(): void { this.emit({ kind: "ready" }); }
  get observed(): boolean { return this.#sinks.size > 0; }
  /** The most recent submit call. */
  get lastSubmit(): SubmitCall { return this.submits[this.submits.length - 1]; }
  get lastInterrupt(): InterruptCall { return this.interrupts[this.interrupts.length - 1]; }
}

/** A manual clock for the coordinator's `schedule`/`now` seams. */
export class FakeClock {
  now = 1_000_000;
  #timers: Array<{ at: number; fn: () => void; id: number }> = [];
  #next = 1;
  schedule = (fn: () => void, ms: number): (() => void) => {
    const id = this.#next++;
    this.#timers.push({ at: this.now + ms, fn, id });
    return () => { this.#timers = this.#timers.filter((t) => t.id !== id); };
  };
  /** Advance time, firing due timers in order (each may schedule more). */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t.id !== due.id);
      this.now = Math.max(this.now, due.at);
      due.fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
  get pending(): number { return this.#timers.length; }
}

/** Let promise chains and microtasks drain (a few macrotask turns). */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}
