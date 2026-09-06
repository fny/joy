// SessionCoordinator contract (design §2.2–2.7). One named test per rule
// R1–R20, plus the failure-order harnesses from test-scenarios/ replayed
// through a FakeDriver with the SAME interleavings (their names are kept in
// the test titles), and the C1 crash row "submitting at the crash" re-run
// through adopt/reconcile. Every test opens its own ledger in a temp dir.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ledger, LedgerWriteError, SessionEndedError } from "./ledger";
import { SessionCoordinator, SessionNotAdoptedError, type CoordinatorEvent } from "./coordinator";
import { FakeDriver, FakeClock, settle, deferred, CODEX_LIKE, OPENCODE_LIKE, CLAUDE_LIKE } from "./coordinator.fakeDriver";

let dir: string;
let ledger: Ledger;
let clock: FakeClock;
let coord: SessionCoordinator;
let events: CoordinatorEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coordinator-"));
  clock = new FakeClock();
  ledger = Ledger.open(dir, { now: () => clock.now });
  coord = new SessionCoordinator({ ledger, now: () => clock.now, schedule: clock.schedule, log: () => {} });
  events = [];
  coord.subscribe((e) => events.push(e));
});
afterEach(() => { vi.restoreAllMocks(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });

function session(id: string, caps = CODEX_LIKE, agent = "codex"): FakeDriver {
  const gen = ledger.openGeneration(id, agent);
  const d = new FakeDriver(id, gen, caps);
  coord.adopt(id, d);
  d.ready();
  return d;
}
const accept = (sid: string, text: string, extra: Record<string, unknown> = {}) =>
  coord.accept({ sessionId: sid, text, source: "rpc", visible: true, mirrorToRelay: true, ...extra });
const stateOf = (id: string) => coord.state(id);
const turnInterrupts = (d: FakeDriver) => d.interrupts.filter((i) => i.attempt?.runtimeTurnId).map((i) => i.attempt!.runtimeTurnId);

// ── R1 / R19: acceptance is the commit ──────────────────────────────────────

test("R1: accept returns after the commit; a failed commit throws and leaves no row", () => {
  session("s1");
  const ok = accept("s1", "durable", { seq: 1, source: "relay" });
  expect(ledger.getCommand(ok.id)?.state).toBe("queued");
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql === "COMMIT") throw new Error("SQLITE_FULL");
    return exec.call(this, sql);
  });
  expect(() => accept("s1", "lost", { seq: 2, source: "relay" })).toThrow(LedgerWriteError);
  vi.restoreAllMocks();
  expect(ledger.commandForSeq("s1", 2)).toBeNull();
});

test("R19: a killed session refuses new commands; a session with no driver is refused too", () => {
  session("s1");
  coord.retire("s1", "killed");
  expect(() => accept("s1", "late")).toThrow(SessionEndedError);
  expect(() => accept("nope", "x")).toThrow(SessionNotAdoptedError);
});

// ── R4 / R15 / the happy path ───────────────────────────────────────────────

test("R4: a refused attempt commit holds the send; the commit is retried and the prompt is sent once", async () => {
  const d = session("s1");
  const real = ledger.recordAttempt.bind(ledger);
  let refusals = 1;
  vi.spyOn(ledger, "recordAttempt").mockImplementation((...args) => {
    if (refusals-- > 0) throw new LedgerWriteError("attempt", new Error("ENOSPC"));
    return real(...args);
  });
  const c = accept("s1", "hello");
  await settle();
  expect(d.submits).toHaveLength(0);
  expect(stateOf(c.id)).toBe("queued");
  await clock.advance(2_000);
  expect(d.submits).toHaveLength(1);
  expect(stateOf(c.id)).toBe("submitting");
  expect(ledger.getCommand(c.id)?.activeOp).toBe(d.lastSubmit.attempt.token);
});

test("happy path: submitting → accepted → running (echo) → completed (turn_ended) with receipts and the attempt done", async () => {
  const d = session("s1");
  const c = accept("s1", "hello", { seq: 7, source: "relay", visible: false });
  await settle();
  expect(d.submits).toHaveLength(1);
  expect(d.lastSubmit.attempt.runtimeRef).toBe(c.id);
  expect(stateOf(c.id)).toBe("submitting");
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T1" });
  await settle();
  expect(stateOf(c.id)).toBe("accepted");
  expect(ledger.latestAttempt(c.id)).toMatchObject({ state: "accepted", runtimeTurnId: "T1" });
  d.emit({ kind: "turn_started", runtimeTurnId: "T1" });
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T1", receiptKind: "codex_client" });
  expect(stateOf(c.id)).toBe("running");
  expect(coord.snapshot("s1")).toMatchObject({ busy: true, provenance: "command", running: { id: c.id }, pendingCount: 0 });
  expect(ledger.hasReceipt("s1", "codex_client", c.id)).toBe(true);
  expect(ledger.hasReceipt("s1", "seq", "7")).toBe(true);
  d.emit({ kind: "turn_ended", runtimeTurnId: "T1", status: "completed" });
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "completed", terminalReason: "completed", activeOp: null });
  expect(ledger.latestAttempt(c.id)?.state).toBe("done");
  expect(coord.snapshot("s1")).toMatchObject({ busy: false, provenance: null, running: null });
  // A redelivery of the same seq is answered by the retained receipt, never dispatched again (R5).
  expect(accept("s1", "hello", { seq: 7, source: "relay", visible: false })).toMatchObject({ id: c.id, deduped: "receipt" });
  await settle();
  expect(d.submits).toHaveLength(1);
});

test("R15: one driver operation per session; FIFO order; the next head goes only after the turn ended", async () => {
  const d = session("s1");
  const a = accept("s1", "A"); const b = accept("s1", "B");
  await settle();
  expect(d.submits.map((s) => s.cmd.text)).toEqual(["A"]);
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "TA" });
  await settle();
  expect(d.submits).toHaveLength(1); // accepted, awaiting evidence: still the op in flight
  d.emit({ kind: "echo", runtimeRef: a.id, runtimeTurnId: "TA" });
  await settle();
  expect(d.submits).toHaveLength(1); // running and concurrentSubmit=false
  d.emit({ kind: "turn_ended", runtimeTurnId: "TA", status: "completed" });
  await settle();
  expect(d.submits.map((s) => s.cmd.text)).toEqual(["A", "B"]);
  expect(stateOf(b.id)).toBe("submitting");
});

test("concurrentSubmit (opencode-like): the next command is submitted while a turn runs; an awaiting attempt still serializes", async () => {
  const d = session("s1", OPENCODE_LIKE, "opencode");
  const a = accept("s1", "A"); accept("s1", "B");
  await settle();
  expect(d.submits).toHaveLength(1);
  d.lastSubmit.settle.resolve({ kind: "accepted" });
  await settle();
  expect(d.submits).toHaveLength(1);
  d.emit({ kind: "echo", runtimeRef: a.id, receiptKind: "opencode_msg" });
  await settle();
  expect(d.submits.map((s) => s.cmd.text)).toEqual(["A", "B"]);
});

// ── R7 / R17: terminal = the attempt's outcome ──────────────────────────────

test("R17/#463: an idle runtime with no terminal for the running attempt → interrupted(idle_without_terminal), never completed", async () => {
  const d = session("s1");
  const c = accept("s1", "x");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  d.emit({ kind: "idle" });
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "interrupted", terminalReason: "idle_without_terminal" });
});

test("R7/#584: a turn the runtime ended as failed terminalizes failed; a late duplicate changes nothing (R14)", async () => {
  const d = session("s1");
  const c = accept("s1", "x");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "T", status: "failed" });
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "failed", terminalReason: "agent_reported_failed" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "T", status: "completed" });
  expect(stateOf(c.id)).toBe("failed");
});

test("R16/#40: a turn_ended with no ids applies to every executing command (an id-less runtime's run ended); one naming a turn ends every command that rode it", async () => {
  const d = session("s1", OPENCODE_LIKE, "opencode");
  const a = accept("s1", "A"); const b = accept("s1", "B");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: a.id });
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted" }); // B went out while A ran (concurrentSubmit)
  await settle();
  d.emit({ kind: "echo", runtimeRef: b.id });
  d.emit({ kind: "turn_ended", status: "completed" });
  expect(stateOf(a.id)).toBe("completed");
  expect(stateOf(b.id)).toBe("completed");
  // Shared turn ids: a steer joined the running turn.
  const c = accept("s1", "C"); const s2 = accept("s1", "S");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T-shared" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T-shared" });
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T-shared" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: s2.id, runtimeTurnId: "T-shared" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "T-shared", status: "failed" });
  expect(stateOf(c.id)).toBe("failed");
  expect(stateOf(s2.id)).toBe("failed");
});

test("a driver may choose the runtime ref: an idempotent id is reused across resends", async () => {
  const d = session("s1");
  (d as unknown as { runtimeRef: (cmd: { id: string }) => string }).runtimeRef = (cmd) => `msg_${cmd.id}`;
  d.onSubmit = () => ({ kind: "rejected", permanent: false, detail: "nope" });
  const c = accept("s1", "x");
  await settle();
  await clock.advance(2_000);
  expect(d.submits.map((x) => x.attempt.runtimeRef)).toEqual([`msg_${c.id}`, `msg_${c.id}`]);
});

// ── R14: rejections ─────────────────────────────────────────────────────────

test("R14: a permanent rejection fails the command with the detail; it is never re-submitted", async () => {
  const d = session("s1");
  const c = accept("s1", "bad");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "rejected", permanent: true, detail: "-32602: invalid argument" });
  await settle();
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "failed", terminalReason: "-32602: invalid argument" });
  await clock.advance(60_000);
  expect(d.submits).toHaveLength(1);
});

test("harness w2e-queue: 'Codex non-busy refusal self-retries three times then fails' (no outside intake)", async () => {
  const d = session("s1");
  d.onSubmit = () => ({ kind: "rejected", permanent: false, detail: "invalid input" });
  const c = accept("s1", "reject");
  await settle();
  expect(d.submits).toHaveLength(1);
  expect(stateOf(c.id)).toBe("queued");
  await clock.advance(2_000);
  expect(d.submits).toHaveLength(2);
  await clock.advance(4_000);
  expect(d.submits).toHaveLength(3);
  expect(stateOf(c.id)).toBe("failed");
  expect(d.submits.map((s) => s.attempt.runtimeRef)).toEqual([c.id, `${c.id}#a2`, `${c.id}#a3`]);
});

test("harness w2e-queue: 'Codex busy refusals do not consume non-busy budget' (2 busy + 3 non-busy = 5 starts)", async () => {
  const d = session("s1");
  let starts = 0;
  d.onSubmit = () => { starts++; return { kind: "rejected", permanent: false, detail: starts <= 2 ? "turn already active" : "bad request", busy: starts <= 2 }; };
  const c = accept("s1", "busy twice");
  await settle();
  expect(starts).toBe(1); expect(stateOf(c.id)).toBe("queued");
  coord.resume("s1"); await settle();
  expect(starts).toBe(2); expect(stateOf(c.id)).toBe("queued");
  coord.resume("s1"); await settle();
  expect(starts).toBe(3);
  expect(ledger.attemptsForCommand(c.id).filter((a) => a.state === "rejected" && !a.detail?.startsWith("busy:"))).toHaveLength(1);
  await clock.advance(2_000); await clock.advance(4_000);
  expect(starts).toBe(5);
  expect(stateOf(c.id)).toBe("failed");
});

// ── R9 / R10: cancellation ──────────────────────────────────────────────────

test("R9: a queued command cancels at once and is never submitted; the next head moves up", async () => {
  const d = session("s1");
  const a = accept("s1", "A"); const b = accept("s1", "B"); const c = accept("s1", "C");
  await settle();
  expect(coord.cancel(b.id)).toMatchObject({ kind: "cancelled", state: "cancelled" });
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "TA" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: a.id, runtimeTurnId: "TA" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "TA", status: "completed" });
  await settle();
  expect(d.submits.map((s) => s.cmd.id)).toEqual([a.id, c.id]);
  expect(coord.cancel(b.id)).toMatchObject({ kind: "already" });
  expect(coord.cancel("nope")).toMatchObject({ kind: "unknown" });
});

test("harness w2d-queue: 'Codex delayed successful start: tombstone caused interrupt' (#35/#66)", async () => {
  const d = session("s1");
  const q = accept("s1", "cancel");
  await settle();
  expect(coord.cancel(q.id)).toMatchObject({ kind: "cancelling" });
  expect(stateOf(q.id)).toBe("cancelling");
  await clock.advance(0);
  expect(d.interrupts).toHaveLength(0); // the submit is still in flight: nothing to interrupt yet
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "late" });
  await settle();
  await clock.advance(0);
  expect(turnInterrupts(d)).toEqual(["late"]);
  d.lastInterrupt.settle.resolve({ kind: "sent" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "late", status: "cancelled" });
  expect(ledger.getCommand(q.id)).toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
});

test("harness w2e-queue: 'Codex turn/started after timeout alone misses the tombstoned item; the later correlated echo interrupts it'", async () => {
  const d = session("s1");
  d.onInterrupt = (call) => (call.attempt?.runtimeTurnId ? { kind: "sent" } : { kind: "noop" });
  const q = accept("s1", "cancel lost response");
  await settle();
  coord.cancel(q.id);
  d.lastSubmit.settle.resolve({ kind: "unknown", detail: "request timed out" });
  await settle();
  await clock.advance(0);
  // Nothing attributable ran: the cancel holds as a tombstone.
  expect(turnInterrupts(d)).toEqual([]);
  expect(stateOf(q.id)).toBe("cancelled");
  d.emit({ kind: "turn_started", runtimeTurnId: "late-own" }); // a turn/started alone is not attributable (Astra on caf47165)
  await settle();
  expect(turnInterrupts(d)).toEqual([]);
  expect(coord.snapshot("s1")).toMatchObject({ busy: true, provenance: "terminal" });
  d.emit({ kind: "echo", runtimeRef: q.id, runtimeTurnId: "late-own", receiptKind: "codex_client" });
  await settle();
  expect(turnInterrupts(d)).toEqual(["late-own"]);
  expect(stateOf(q.id)).toBe("cancelled");
  expect(coord.snapshot("s1").provenance).toBeNull(); // the echo claimed the turn: not foreign after all
});

test("harness w3b-queue: 'Codex unrelated TUI turn survives tombstone and busy rejection' (#32)", async () => {
  const d = session("s1");
  const q = accept("s1", "not admitted");
  await settle();
  coord.cancel(q.id);
  d.emit({ kind: "turn_started", runtimeTurnId: "unrelated-tui" });
  d.lastSubmit.settle.resolve({ kind: "rejected", permanent: false, detail: "turn already active", busy: true });
  await settle();
  await clock.advance(0);
  expect(turnInterrupts(d)).toEqual([]);
  expect(stateOf(q.id)).toBe("cancelled"); // never ran
  expect(coord.snapshot("s1")).toMatchObject({ busy: true, provenance: "terminal" });
});

test("R10: cancel of a running command → cancelling; the interrupt is retried with backoff until confirmed", async () => {
  const d = session("s1");
  d.onInterrupt = () => ({ kind: "failed", error: "socket busy" });
  const c = accept("s1", "x");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  coord.cancel(c.id);
  await clock.advance(0);
  expect(d.interrupts).toHaveLength(1);
  await clock.advance(1_000);
  expect(d.interrupts).toHaveLength(2);
  await clock.advance(2_000);
  expect(d.interrupts).toHaveLength(3);
  expect(stateOf(c.id)).toBe("cancelling");
  d.emit({ kind: "interrupted", runtimeTurnId: "T" });
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
  await clock.advance(60_000);
  expect(d.interrupts).toHaveLength(3); // confirmed: no more tries
});

test("R10: an interrupt budget spent without confirmation is surfaced as unresolved, never faked as cancelled", async () => {
  const d = session("s1");
  d.onInterrupt = () => ({ kind: "sent" });
  const c = accept("s1", "x");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  coord.cancel(c.id);
  for (let i = 0; i < 8; i++) await clock.advance(30_000);
  expect(d.interrupts).toHaveLength(5);
  expect(stateOf(c.id)).toBe("cancelling");
  expect(coord.snapshot("s1").unresolvedCancels).toEqual([c.id]);
  expect(events.some((e) => e.type === "cancel_unresolved" && e.commandId === c.id)).toBe(true);
  expect(ledger.listObservations("s1", "cancel_unresolved")).toHaveLength(1);
  // The runtime finally answers: the verdict lands and the flag clears.
  d.emit({ kind: "turn_ended", runtimeTurnId: "T", status: "completed" });
  expect(stateOf(c.id)).toBe("completed"); // the work finished before the interrupt landed: its own verdict stands
  expect(coord.snapshot("s1").unresolvedCancels).toEqual([]);
});

test("abortRunning cancels every command in flight and returns the driver's verdict; a foreign turn gets a session-wide interrupt", async () => {
  const d = session("s1");
  d.onInterrupt = () => ({ kind: "sent" });
  const c = accept("s1", "x");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  expect(await coord.abortRunning("s1")).toEqual({ ok: true });
  expect(stateOf(c.id)).toBe("cancelling");
  d.emit({ kind: "turn_ended", runtimeTurnId: "T", status: "interrupted" });
  expect(stateOf(c.id)).toBe("cancelled");
  d.emit({ kind: "turn_started", runtimeTurnId: "tui" });
  d.onInterrupt = () => ({ kind: "failed", error: "no" });
  expect(await coord.abortRunning("s1")).toEqual({ ok: false, error: "no" });
  expect(d.lastInterrupt.attempt).toBeNull();
});

test("an untargeted interrupt (opencode/pi) is refused while uncancelled work runs (collateral) and is surfaced as unresolved; abortRunning sends it ONCE for everything", async () => {
  const d = session("s1", OPENCODE_LIKE, "opencode");
  d.onInterrupt = () => ({ kind: "sent" });
  const a = accept("s1", "A"); const b = accept("s1", "B");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" }); await settle();
  d.emit({ kind: "echo", runtimeRef: a.id, runtimeTurnId: "T" }); await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" }); await settle();
  d.emit({ kind: "echo", runtimeRef: b.id, runtimeTurnId: "T" });
  // Cancel only A while B (same turn) is still wanted: no session-wide
  // interrupt, no budget spent — the cancel resolves with the turn's end.
  coord.cancel(a.id);
  for (let i = 0; i < 8; i++) await clock.advance(30_000);
  expect(d.interrupts).toHaveLength(0);
  expect(stateOf(a.id)).toBe("cancelling");
  expect(coord.snapshot("s1").unresolvedCancels).toEqual([]);
  // Stop everything: one interrupt, both confirmed by the turn's end.
  expect(await coord.abortRunning("s1")).toEqual({ ok: true });
  expect(d.interrupts).toHaveLength(1);
  d.emit({ kind: "turn_ended", runtimeTurnId: "T", status: "cancelled" });
  expect(stateOf(a.id)).toBe("cancelled");
  expect(stateOf(b.id)).toBe("cancelled");
  await clock.advance(60_000);
  expect(d.interrupts).toHaveLength(1);
});

// ── R8 / R16 / R18: attribution ─────────────────────────────────────────────

test("R8/#78: a turn nobody submitted is foreign — busy with provenance 'terminal', no command touched, ended on its turn_ended", async () => {
  const d = session("s1");
  const c = accept("s1", "queued behind");
  await settle();
  d.emit({ kind: "turn_started", runtimeTurnId: "tui-1" });
  expect(coord.snapshot("s1")).toMatchObject({ busy: true, provenance: "terminal" });
  expect(stateOf(c.id)).toBe("submitting"); // a foreign turn never confirms an attempt (#32)
  expect(events.filter((e) => e.type === "foreign_turn").map((e) => (e as { phase: string }).phase)).toEqual(["started"]);
  d.emit({ kind: "turn_ended", runtimeTurnId: "tui-1", status: "completed" });
  expect(coord.snapshot("s1")).toMatchObject({ busy: false, provenance: null });
  expect(stateOf(c.id)).toBe("submitting");
  expect(ledger.listObservations("s1", "turn_ended").every((o) => o.attemptId == null)).toBe(true);
});

test("R18/#513: a fast turn that started AND ended before the submit response is applied when the response names it", async () => {
  const d = session("s1");
  const c = accept("s1", "fast");
  await settle();
  d.emit({ kind: "turn_started", runtimeTurnId: "T9" });
  d.emit({ kind: "turn_ended", runtimeTurnId: "T9", status: "completed" });
  expect(stateOf(c.id)).toBe("submitting");
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T9" });
  await settle();
  expect(ledger.getCommand(c.id)).toMatchObject({ state: "completed", terminalReason: "completed" });
  expect(ledger.latestAttempt(c.id)).toMatchObject({ state: "done", runtimeTurnId: "T9" });
  expect(coord.snapshot("s1").busy).toBe(false);
});

test("R18: an echo that beat the response moves the command to running; the response then only binds the turn id", async () => {
  const d = session("s1");
  const c = accept("s1", "x");
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  expect(stateOf(c.id)).toBe("running");
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  expect(stateOf(c.id)).toBe("running");
  expect(ledger.latestAttempt(c.id)).toMatchObject({ state: "done", runtimeTurnId: "T" });
});

// ── R6 / R19: generations ───────────────────────────────────────────────────

test("R6/#481/#36: retire(restart) keeps queued rows; in-flight → unknown; the replacement reconciles (absent → resend as a new attempt, running → running)", async () => {
  const d1 = session("s1");
  const a = accept("s1", "A"); const b = accept("s1", "B"); const q = accept("s1", "Q");
  await settle();
  d1.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "TA" });
  await settle();
  d1.emit({ kind: "echo", runtimeRef: a.id, runtimeTurnId: "TA" });
  d1.emit({ kind: "turn_ended", runtimeTurnId: "TA", status: "completed" });
  await settle();
  expect(stateOf(b.id)).toBe("submitting");
  coord.retire("s1", "restart");
  expect(stateOf(b.id)).toBe("unknown");
  expect(stateOf(q.id)).toBe("queued");
  expect(coord.has("s1")).toBe(false);
  // A late result for the OLD op is an orphan: settled, never applied to the row.
  d1.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "TB-old" });
  await settle();
  expect(stateOf(b.id)).toBe("unknown");
  expect(d1.interrupts.map((i) => i.attempt?.runtimeTurnId)).toEqual(["TB-old"]);
  // The replacement: reconcile says the first submission never landed → resend.
  const gen2 = ledger.openGeneration("s1", "codex");
  const d2 = new FakeDriver("s1", gen2);
  d2.onReconcile = (call) => call.pending.map((p) => ({ attemptId: p.attemptId, outcome: "absent" as const }));
  coord.adopt("s1", d2);
  d2.ready();
  await settle();
  expect(d2.reconciles[0].pending.map((p) => p.commandId)).toEqual([b.id]);
  expect(d2.submits.map((s) => [s.cmd.id, s.attempt.runtimeRef])).toEqual([[b.id, `${b.id}#a2`]]);
  expect(ledger.attemptsForCommand(b.id).map((x) => x.state)).toEqual(["superseded", "submitting"]);
});

test("R6: a replacement that finds the turn still running keeps the command running and never resends", async () => {
  const d1 = session("s1");
  const b = accept("s1", "B");
  await settle();
  coord.retire("s1", "process_exited");
  const gen2 = ledger.openGeneration("s1", "codex");
  const d2 = new FakeDriver("s1", gen2);
  d2.onReconcile = (call) => call.pending.map((p) => ({ attemptId: p.attemptId, outcome: "running" as const, runtimeTurnId: "TB" }));
  coord.adopt("s1", d2); d2.ready();
  await settle();
  expect(stateOf(b.id)).toBe("running");
  expect(d2.submits).toHaveLength(0);
  d2.emit({ kind: "turn_ended", runtimeTurnId: "TB", status: "completed" });
  expect(stateOf(b.id)).toBe("completed");
  expect(d1.submits).toHaveLength(1);
});

test("R6: an attempt the replacement cannot place stays unknown (held, at-most-once) and blocks nothing behind it forever: a cancel resolves it", async () => {
  session("s1");
  const b = accept("s1", "B");
  await settle();
  coord.retire("s1", "restart");
  const gen2 = ledger.openGeneration("s1", "codex");
  const d2 = new FakeDriver("s1", gen2);
  d2.onReconcile = (call) => call.pending.map((p) => ({ attemptId: p.attemptId, outcome: "unknown" as const }));
  d2.onInterrupt = () => ({ kind: "noop" });
  coord.adopt("s1", d2); d2.ready();
  await settle();
  expect(stateOf(b.id)).toBe("unknown");
  const c = accept("s1", "C");
  await settle();
  expect(d2.submits).toHaveLength(0); // unknown is the op in flight
  coord.cancel(b.id);
  await clock.advance(0);
  expect(stateOf(b.id)).toBe("cancelled");
  await settle();
  expect(d2.submits.map((s) => s.cmd.id)).toEqual([c.id]);
});

test("R6/#553: retire(killed) interrupts queued rows with the reason; a cancelling row is cancelled by the runtime's death", async () => {
  const d = session("s1");
  const a = accept("s1", "A"); const q = accept("s1", "Q");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "TA" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: a.id, runtimeTurnId: "TA" });
  coord.cancel(a.id);
  coord.retire("s1", "killed");
  expect(ledger.getCommand(a.id)).toMatchObject({ state: "cancelled", terminalReason: "cancelled:killed" });
  expect(ledger.getCommand(q.id)).toMatchObject({ state: "interrupted", terminalReason: "killed" });
  expect(events.filter((e) => e.type === "command" && e.commandId === q.id).map((e) => (e as { state: string }).state)).toContain("interrupted");
});

test("crash row 2 (C1 §1.6) through the coordinator: an attempt submitting at the crash is unknown after reopen, reconciled, never re-listed as queued", async () => {
  const d = session("s1");
  const c = accept("s1", "mid-flight");
  await settle();
  expect(d.submits).toHaveLength(1);
  // crash: no close(), no settle.
  const l2 = Ledger.open(dir, { now: () => clock.now });
  const c2 = new SessionCoordinator({ ledger: l2, now: () => clock.now, schedule: clock.schedule, log: () => {} });
  const gen2 = l2.openGeneration("s1", "codex");
  expect(l2.getCommand(c.id)?.state).toBe("unknown");
  expect(l2.listPending("s1", ["queued"])).toHaveLength(0);
  const d2 = new FakeDriver("s1", gen2);
  d2.onReconcile = (call) => call.pending.map((p) => ({ attemptId: p.attemptId, outcome: "accepted" as const, runtimeTurnId: "T" }));
  c2.adopt("s1", d2); d2.ready();
  await settle();
  expect(l2.getCommand(c.id)?.state).toBe("accepted");
  expect(d2.submits).toHaveLength(0);
  l2.close();
});

// ── handled commands, dedupe, steer, edits, waits ───────────────────────────

test("a joy-owned command the driver handles completes in the accept transaction; its reinjection is a hidden queued row the caller can cancel", async () => {
  const d = session("s1");
  d.commands = (text) => text.startsWith("/title") ? { handled: true } : text.startsWith("/joy-prompt") ? { handled: true, reinjection: "REINJECT" } : null;
  const t = accept("s1", "/title hello", { relayTurnId: "turn-1" });
  expect(t).toMatchObject({ handled: "command", state: "completed" });
  expect(ledger.getCommand(t.id)).toMatchObject({ state: "completed", terminalReason: "handled_as_command", origin: "command", relayTurnId: "turn-1" });
  await settle();
  expect(d.submits).toHaveLength(0);
  const j = accept("s1", "/joy-prompt");
  expect(j.reinjectionId).toBeDefined();
  expect(ledger.getCommand(j.reinjectionId!)).toMatchObject({ state: "queued", origin: "reinjection", visible: false, text: "REINJECT" });
  expect(coord.cancel(j.reinjectionId!).kind).toBe("cancelled");
  await settle();
  expect(d.submits).toHaveLength(0);
});

test("dedupe: a re-offered relay turn returns the existing row; the driver's accepted hook fires once", () => {
  const d = session("s1");
  const a = accept("s1", "x", { relayTurnId: "T-1", source: "relay", visible: false });
  const b = accept("s1", "x", { relayTurnId: "T-1", source: "relay", visible: false });
  expect(b).toMatchObject({ id: a.id, deduped: "pending" });
  expect(d.acceptedViews).toHaveLength(1);
  expect(coord.commandForRelayTurn("T-1")?.id).toBe(a.id);
});

test("R20/#135: steer-from-queue cancels the queued row and accepts a steer in one transaction; a steer runs ahead of the FIFO through driver.steer while a turn runs", async () => {
  const d = session("s1", OPENCODE_LIKE, "opencode");
  const a = accept("s1", "A");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: a.id });
  await settle();
  const q1 = accept("s1", "queued 1");
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted" }); // concurrentSubmit: it went straight out
  await settle();
  d.emit({ kind: "echo", runtimeRef: q1.id });
  const q2 = accept("s1", "later");
  const s = coord.steerFromQueue(q2.id)!;
  expect(stateOf(q2.id)).toBe("cancelled");
  expect(ledger.getCommand(s.id)).toMatchObject({ origin: "steer", text: "later" });
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted" });
  await settle();
  expect(d.submits.filter((x) => x.steer).map((x) => x.cmd.id)).toEqual([s.id]);
  expect(stateOf(q1.id)).toBe("running");
});

test("edit bumps the payload version of a queued row only; reorder moves within the queued rows", async () => {
  const d = session("s1");
  const a = accept("s1", "A"); const b = accept("s1", "B"); const c = accept("s1", "C");
  await settle();
  expect(coord.edit(a.id, "A2")).toBe(false); // submitting
  expect(coord.edit(b.id, "B2")).toBe(true);
  expect(ledger.getCommand(b.id)).toMatchObject({ text: "B2", payloadVersion: 2 });
  expect(coord.reorder(c.id, 0)).toBe(true);
  expect(coord.snapshot("s1").queue.map((q) => q.id)).toEqual([c.id, b.id]);
  expect(coord.snapshot("s1")).toMatchObject({ pendingCount: 3, inFlight: "A" });
  expect(d.submits).toHaveLength(1);
});

// ── e8f8b2cc review residuals: the editable queue across the pre-attempt gate ──

test("pane gate (e8f8b2cc): an edit while the head waits at prepare re-plans — the driver receives the edited text and the attempt records that payload version", async () => {
  const d = session("s1", CLAUDE_LIKE, "claude");
  const gate = deferred<"ready" | "cancelled" | "retired">();
  const prepared: string[] = [];
  d.prepare = (cmd) => { prepared.push(cmd.text); return gate.promise; };
  const row = accept("s1", "before");
  await settle();
  expect(prepared).toEqual(["before"]);
  expect(d.submits).toHaveLength(0);
  expect(coord.edit(row.id, "after")).toBe(true);
  gate.resolve("ready");
  await settle();
  // The stale head is never submitted: the loop re-planned on the edited row.
  expect(d.submits).toHaveLength(1);
  expect(d.lastSubmit.cmd.text).toBe("after");
  expect(d.lastSubmit.cmd.payloadVersion).toBe(2);
  const attempt = ledger.getAttempt(d.lastSubmit.attempt.attemptId)!;
  expect(attempt.payloadVersion).toBe(2);
  expect(attempt.payloadVersion).toBe(d.lastSubmit.cmd.payloadVersion);
  expect(ledger.getCommand(row.id)).toMatchObject({ text: "after", payloadVersion: 2, state: "submitting" });
});

test("pane gate (e8f8b2cc): a reorder while the head waits at prepare re-plans — the new head is submitted first", async () => {
  const d = session("s1", CLAUDE_LIKE, "claude");
  const gate = deferred<"ready" | "cancelled" | "retired">();
  const prepared: string[] = [];
  d.prepare = (cmd) => { prepared.push(cmd.text); return gate.promise; };
  const x = accept("s1", "first");
  const y = accept("s1", "second");
  await settle();
  expect(prepared).toEqual(["first"]);
  expect(coord.reorder(y.id, 0)).toBe(true);
  gate.resolve("ready");
  await settle();
  expect(d.submits).toHaveLength(1);
  expect(d.lastSubmit.cmd.id).toBe(y.id);
  expect(d.lastSubmit.cmd.text).toBe("second");
  expect(stateOf(y.id)).toBe("submitting");
  expect(stateOf(x.id)).toBe("queued");
  // The gate was consulted again for the row that actually went.
  expect(prepared[prepared.length - 1]).toBe("second");
});

test("waitFor resolves on the named state, immediately when already there, and with the current state on timeout", async () => {
  const d = session("s1");
  const c = accept("s1", "x");
  const p = coord.waitFor(c.id, ["running", "completed"]);
  await settle();
  d.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T" });
  await settle();
  d.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T" });
  expect(await p).toBe("running");
  expect(await coord.waitFor(c.id, ["running"])).toBe("running");
  const t = coord.waitFor(c.id, ["completed"], { timeoutMs: 5_000 });
  await clock.advance(5_000);
  expect(await t).toBe("running");
  expect(await coord.waitFor("nope", ["completed"])).toBeNull();
});

test("a driver whose submit throws is an unknown outcome, never a resend", async () => {
  const d = session("s1");
  d.onSubmit = () => Promise.reject(new Error("boom"));
  const c = accept("s1", "x");
  await settle();
  expect(ledger.getCommand(c.id)?.state).toBe("unknown");
  expect(ledger.latestAttempt(c.id)).toMatchObject({ state: "unknown" });
  await clock.advance(60_000);
  expect(d.submits).toHaveLength(1);
});

test("draft_preserved is held for the driver to restore and surfaced in the snapshot; a checkpoint observation lands in the ledger", () => {
  const d = session("s1");
  d.emit({ kind: "draft_preserved", text: "half-typed" });
  expect(coord.snapshot("s1").drafts).toEqual(["half-typed"]);
  expect(coord.takeDrafts("s1")).toEqual(["half-typed"]);
  expect(coord.snapshot("s1").drafts).toEqual([]);
  d.emit({ kind: "checkpoint", checkpointKind: "claude_transcript", ref: "/t.jsonl", offset: 42 });
  expect(ledger.getCheckpoint("s1", "claude_transcript")).toMatchObject({ ref: "/t.jsonl", offset: 42 });
});

test("a paused driver (claude's dirty box) stops the pump; resume lifts it", async () => {
  const d = session("s1");
  d.emit({ kind: "paused", reason: "input_dirty" });
  const c = accept("s1", "x");
  await settle();
  expect(d.submits).toHaveLength(0);
  expect(coord.snapshot("s1")).toMatchObject({ paused: true, pauseReason: "input_dirty" });
  coord.resume("s1");
  await settle();
  expect(d.submits).toHaveLength(1);
  expect(stateOf(c.id)).toBe("submitting");
});
