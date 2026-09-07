// Restart recovery against the REAL relay (HTTP + PGlite, joy-relay's test
// harness): the daemon's lease expires and is swept while a relay turn is
// mid-flight, the runtime survives, a new driver generation confirms it
// running, and a fresh lane boots over the same ledger. Astra's C9 review
// (b1d5baf7) showed the boot pass interrupting the orphaned turn on the
// relay before the ledger was consulted: /start then 409'd and the lane
// cancelled a live agent — or, with a durable ack, left the relay idle while
// the agent kept working. Every case here asserts the opposite: the local
// command stays running, the relay adopts the turn under the new lease
// (cancellation preserved), at most one /start is posted, and exactly one
// terminal is published when the runtime ends.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startRelay } from "../../../joy-relay/test/harness.mjs";
import { ledgerFor, closeAllLedgers, LedgerWriteError, type NewOutbound } from "../domain/ledger";
import { coordinatorFor, resetCoordinators } from "../domain/coordinator";
import { FakeDriver, settle } from "../domain/coordinator.fakeDriver";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) { if (Date.now() > end) throw new Error("timeout waiting"); await sleep(40); }
}

type Prior =
  | "dispatching"     // died after the runtime's echo, before POST /start
  | "running"         // /start applied on the relay, the ack receipt lost
  | "acknowledged"    // /start applied AND acknowledged (durable ack)
  | "cancelling"      // acknowledged, then the app requested a cancel before the crash
  | "closed_remotely" // before /start; an intermediate generation already closed the turn `interrupted`
  | "adoption_unavailable_twice" // before /start; the relay answers reconcile{running} 503 twice, then normally
  | "adoption_unavailable"       // before /start; the relay answers reconcile{running} 503 for good
  | "parked_then_terminal"       // before /start; parked adoption_pending, then the relay answers the retry with a terminal it holds (the turn was closed `completed` elsewhere) while the runtime keeps running
  | "parked_then_cancelling"     // before /start; parked adoption_pending, then the app requests a cancel — the retry adopts `cancelling`
  | "terminal_before_outbox"     // /start applied; the command COMPLETED in the ledger, the process died before its terminal row was committed
  | "terminal_record_only"       // as above, and the session exists only as a window record now — no live handle (the window died with the daemon)
  | "terminal_record_read_failure"  // record-only + a saved terminal, and the ledger's COMMAND SCAN throws (SQLITE_IOERR) until the test heals it
  | "terminal_record_write_failure" // record-only + a saved terminal, and the terminal's outbox WRITE is refused (held in memory) until the test heals it
  | "sweep_then_cancelled"       // before /start; the loop parks adoption_pending for good, and the ORPHAN SWEEP's own reconcile is answered terminal/cancelled (the turn closed between the sweep's GET and its reconcile)
  | "sweep_during_retry"         // as above, but the loop's OWN adoption retry is IN FLIGHT (held) while the sweep answers cancelled — the two answers overlap (F30)
  | "retry_before_sweep_cancelled"; // the REVERSE order: both reconciles begin while the turn is orphaned, the loop's retry adopts it `running` FIRST and takes its /start ack, and only then does the held sweep observe a real terminal/cancelled close (F31)

let dir = "";
let prevHome: string | undefined;
let relay: Awaited<ReturnType<typeof startRelay>> | null = null;
let lane: NucleusLaneHandle | null = null;
let restoreFetch: (() => void) | null = null;
let retire: (() => Promise<void>) | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lane-restart-"));
  prevHome = process.env.JOY_HOME_DIR;
  process.env.JOY_HOME_DIR = dir;
  resetCoordinators();
  closeAllLedgers();
});
afterEach(async () => {
  await lane?.stop(); lane = null;
  restoreFetch?.(); restoreFetch = null;
  vi.restoreAllMocks();
  await retire?.(); retire = null;
  resetCoordinators();
  closeAllLedgers();
  await relay?.close(); relay = null;
  if (prevHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

/** Wrap global fetch (the lane uses it): count POST …/start requests and
 *  successful adoptions (reconcile{running} answered 2xx), and — when
 *  `unavailable` says so for the n-th such request — answer reconcile{running}
 *  with a 503 instead of forwarding it (the relay is unreachable for THAT
 *  question only; everything else reaches the real relay). */
function interceptFetch(
  unavailable: (n: number) => boolean = () => false,
  closeRemotely: (n: number) => boolean = () => false,
  closeOnSweep = false,
  holdRetry = false,
  holdSweep = false,
): { starts: () => number; adoptions: () => number; reconcileRunning: () => number; terminalAnswers: () => number; sweepClosed: () => boolean; retryHeld: () => boolean; releaseRetry: () => void; sweepHeld: () => boolean; releaseSweep: () => void } {
  const real = globalThis.fetch;
  let starts = 0, adoptions = 0, reconciles = 0, terminalAnswers = 0, sweepClosed = false;
  // The loop's OWN adoption retry, parked mid-flight so the sweep's answer
  // and the loop's overlap (F30). `releaseRetry` lets it reach the relay.
  let retryHeld = false, retryReleased = false;
  let releaseRetry: () => void = () => {};
  const retryGate = new Promise<void>((res) => { releaseRetry = () => { retryReleased = true; res(); }; });
  // The SWEEP's reconcile, parked AFTER its GET read the turn `orphaned` — so
  // the loop's own retry can win the adoption first and the sweep's answer
  // arrive afterwards, over a turn the relay has closed meanwhile (F31).
  let sweepHeld = false, sweepReleased = false;
  let releaseSweep: () => void = () => {};
  const sweepGate = new Promise<void>((res) => { releaseSweep = () => { sweepReleased = true; res(); }; });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/daemon\/turns\/[^/]+\/start$/.test(url)) starts++;
    const body = JSON.parse(String(init?.body ?? "{}")) as { resolution?: string; meta?: { reason?: string } };
    const isReconcileRunning = method === "POST" && /\/daemon\/turns\/[^/]+\/reconcile$/.test(url)
      && body.resolution === "running";
    if (isReconcileRunning) {
      reconciles++;
      if (closeOnSweep) {
        if (body.meta?.reason === "orphan_sweep") {
          // The ORPHAN SWEEP asks. Between the sweep's GET (which read the
          // turn `orphaned`) and this reconcile, the turn is closed
          // `cancelled` on the relay — so the sweep's OWN answer is
          // terminal/cancelled. Only the sweep ever gets an answer here.
          // HELD first when the test wants the LOOP to adopt before the close
          // happens at all (F31's reverse order).
          if (holdSweep && !sweepReleased) { sweepHeld = true; await sweepGate; }
          if (!sweepClosed) {
            const closed = await real(input, { ...init, body: JSON.stringify({ resolution: "terminal", terminalState: "cancelled", meta: { reason: "closed_while_orphaned" } }) });
            if (!closed.ok) throw new Error(`the racing close failed: ${closed.status}`);
            sweepClosed = true;
          }
        } else if (holdRetry && body.meta?.reason === "adoption_retry") {
          // The LOOP's own retry reconcile is HELD here — in flight, awaiting
          // the relay — for as long as the test wants: the sweep above
          // answers `cancelled` and clears the pending marker underneath it.
          // Released, it reaches the real relay (which now holds the turn
          // terminal/cancelled), so BOTH sides have a resolved answer.
          if (!retryReleased) { retryHeld = true; await retryGate; }
        } else {
          // The LOOP's own adoption (daemon_restart / adoption_retry) never
          // reaches the relay: the turn stays parked `adoption_pending`
          // there, so only the sweep's carried answer can resolve it.
          return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
        }
      }
      if (unavailable(reconciles)) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      if (closeRemotely(reconciles)) {
        // The turn is closed on the relay under the lane's own lease the
        // moment it asks (an operator, another generation): the relay's
        // answer to the lane's question is `{state: "terminal", terminalState: "completed"}`.
        init = { ...init, body: JSON.stringify({ resolution: "terminal", terminalState: "completed", meta: { reason: "closed_remotely" } }) };
      }
    }
    const res = await real(input, init);
    if (isReconcileRunning && res.ok) {
      const body = (await res.clone().json().catch(() => null)) as { state?: string } | null;
      if (body?.state === "terminal") terminalAnswers++; else adoptions++;
    }
    return res;
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; releaseRetry(); releaseSweep(); };
  return { starts: () => starts, adoptions: () => adoptions, reconcileRunning: () => reconciles, terminalAnswers: () => terminalAnswers, sweepClosed: () => sweepClosed, retryHeld: () => retryHeld, releaseRetry: () => releaseRetry(), sweepHeld: () => sweepHeld, releaseSweep: () => releaseSweep() };
}

async function scenario(prior: Prior) {
  relay = await startRelay();
  const r = relay;
  const id = "c9session";
  const machine = `c9-${prior}`;
  const ledger = ledgerFor();
  // Daemon generation 1 on the relay side (a fake daemon: lease, claim,
  // submitted, maybe /start) and on ours (a coordinator over the ledger,
  // whose driver confirms the delivery — the row is `running`).
  const d1 = r.makeDaemon(machine);
  await d1.acquire();
  const create = await r.call("POST", "/joy/v2/sessions", { body: { mode: "announce_existing", creationIntentId: randomUUID(), daemonId: machine, localSessionId: id, sessionKeyEnvelope: "v2:plaintext" } });
  expect(create.status).toBe(200);
  const sid = create.json.sessionId as string;
  const post = await r.post(sid, { clientIntentId: randomUUID(), ciphertext: JSON.stringify({ v: 1, t: "plain", text: "continue this turn" }) });
  expect(post.status).toBe(202);
  const offer = r.offerFor(await d1.claim("work"), sid);
  expect(offer).toBeTruthy();
  expect((await d1.received(offer.deliveryId)).status).toBe(200);
  expect((await d1.submitted(offer.turnId)).status).toBe(200);
  const turnId = offer.turnId as string;
  const beforeStart: readonly Prior[] = ["dispatching", "closed_remotely", "adoption_unavailable_twice", "adoption_unavailable", "parked_then_terminal", "parked_then_cancelling", "sweep_then_cancelled", "sweep_during_retry"];
  const parked = prior === "parked_then_terminal" || prior === "parked_then_cancelling";
  if (!beforeStart.includes(prior)) {
    expect((await d1.start(turnId, { runtimeEventId: `start:${turnId}` })).status).toBe(200);
  }
  const first = new FakeDriver(id, ledger.openGeneration(id, "codex"));
  let c = coordinatorFor(ledger);
  c.adopt(id, first);
  first.ready();
  const row = c.accept({ sessionId: id, text: "continue this turn", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: turnId, relayCommandId: offer.commandId });
  await settle();
  first.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "RuntimeTurn" });
  await settle();
  first.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "RuntimeTurn" });
  expect(c.state(row.id)).toBe("running");
  const recordFailure = prior === "terminal_record_read_failure" || prior === "terminal_record_write_failure";
  const savedTerminal = prior === "terminal_before_outbox" || prior === "terminal_record_only" || recordFailure;
  if (savedTerminal) {
    // The runtime finished and the ledger committed `completed`; the process
    // died before the lane committed the terminal outbox row.
    first.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
    expect(c.state(row.id)).toBe("completed");
    expect(ledger.hasOutboundEvent(`term:${turnId}`)).toBe(false);
  }
  // The receipts the previous lane left: the /start intent always (it was
  // about to post, or did); the ack only when the answer was recorded.
  ledger.addReceipt(id, { kind: "relay_start_intent", ref: turnId, commandId: row.id });
  if (prior === "acknowledged" || prior === "cancelling") ledger.addReceipt(id, { kind: "relay_start", ref: turnId, commandId: row.id });
  if (prior === "cancelling") {
    const cxl = await r.call("POST", `/joy/v2/sessions/${sid}/turns/${turnId}/cancellations`, { body: {} });
    expect(cxl.status).toBe(200);
  }
  // The crash: the lease expires, the relay sweeps it — the turn is orphaned.
  await r.db.query("UPDATE daemon_leases SET expires_at = now() - interval '1 second' WHERE id = $1", [d1.leaseId]);
  await r.core.sweepExpiredLeases();
  expect((await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution.state).toBe("orphaned");
  const sweepAdopts = prior === "sweep_then_cancelled" || prior === "sweep_during_retry" || prior === "retry_before_sweep_cancelled";
  if (sweepAdopts) {
    // A queued successor is what makes the ordinary every-tick sweep inspect
    // this orphan at all: from the session list it looks wedged — work
    // queued, nothing executing.
    expect((await r.post(sid, { clientIntentId: randomUUID(), ciphertext: JSON.stringify({ v: 1, t: "plain", text: "successor" }) })).status).toBe(202);
  }
  if (prior === "closed_remotely") {
    // An intermediate daemon generation (an old build's orphan pass) closed
    // the turn `interrupted` on the relay; the runtime never noticed.
    const mid = r.makeDaemon(machine);
    await mid.acquire();
    const closed = await r.call("POST", `/joy/v2/daemon/turns/${turnId}/reconcile`, { body: { resolution: "terminal", terminalState: "interrupted", meta: { reason: "daemon_restart" } }, headers: mid.headers() });
    expect(closed.status).toBe(200);
    await r.db.query("UPDATE daemon_leases SET expires_at = now() - interval '1 second' WHERE id = $1", [mid.leaseId]);
    expect((await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution.state).toBe("idle");
  }
  // Daemon generation 2: a new driver generation over the same ledger whose
  // reconcile confirms the runtime is still executing the attempt.
  resetCoordinators();
  const next = new FakeDriver(id, ledger.openGeneration(id, "codex"));
  next.onReconcile = (call) => call.pending.map((a) => ({ attemptId: a.attemptId, outcome: "running" as const, runtimeTurnId: "RuntimeTurn" }));
  next.onInterrupt = () => ({ kind: "sent" });
  c = coordinatorFor(ledger);
  c.adopt(id, next);
  next.ready();
  await until(() => c.state(row.id) === (savedTerminal ? "completed" : "running"));
  const s: any = { id, status: "active", cwd: dir, agentFlavor: "codex", busy: () => c.busy(id), abort: () => c.abortRunning(id), toJSON: () => ({ id, cwd: dir, status: "active", agent: "codex" }) };
  // Record-only: the registry has NO handle for the session — its window
  // record (and the relay's row) is all that names it.
  const recordOnly = prior === "terminal_record_only" || recordFailure;
  const registry: any = { get: (x: string) => (x === id && !recordOnly ? s : undefined), list: () => (recordOnly ? [] : [s]), create: async () => s, chatHistory: () => [], listRecords: () => [{ id, v2SessionId: sid, launchCwd: dir }], saveRecord: () => {} };
  retire = async () => { c.retire(id, "restart"); await settle(); };
  const logs: string[] = [];
  // Injected STORAGE failures, healed by the test when it has observed that
  // no archive happened (Astra, F28): the command scan throws, or the
  // terminal's outbox write is refused and the row is held in memory.
  const faults = { readFails: prior === "terminal_record_read_failure", writeFails: prior === "terminal_record_write_failure" };
  if (prior === "terminal_record_read_failure") {
    const realList = ledger.listCommands.bind(ledger);
    vi.spyOn(ledger, "listCommands").mockImplementation((sessionId: string) => {
      if (faults.readFails && sessionId === id) throw new Error("SQLITE_IOERR: injected command read failure");
      return realList(sessionId);
    });
  }
  if (prior === "terminal_record_write_failure") {
    const realEnqueue = ledger.enqueueOutbound.bind(ledger);
    vi.spyOn(ledger, "enqueueOutbound").mockImplementation((rows: NewOutbound[]) => {
      if (faults.writeFails && rows.some((x) => x.kind === "terminal" && x.runtimeEventId === `term:${turnId}`)) {
        throw new LedgerWriteError("tx", new Error("SQLITE_IOERR: injected outbox write failure"));
      }
      return realEnqueue(rows);
    });
  }
  // Parked priors: the bounded backoff (1 + 2 retries) is refused, the turn
  // parks `adoption_pending`; the slow retry then gets a real answer.
  const unavailable = prior === "adoption_unavailable" ? () => true : prior === "adoption_unavailable_twice" ? (n: number) => n <= 2 : parked ? (n: number) => n <= 3 : undefined;
  const closeRemotely = prior === "parked_then_terminal" ? (n: number) => n === 4 : undefined;
  const { starts, adoptions, reconcileRunning, terminalAnswers, sweepClosed, retryHeld, releaseRetry, sweepHeld, releaseSweep } = interceptFetch(unavailable, closeRemotely, sweepAdopts, prior === "sweep_during_retry" || prior === "retry_before_sweep_cancelled", prior === "retry_before_sweep_cancelled");
  const execution = async () => (await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution as { state: string; turnId: string | null; cancelRequested: boolean };
  const events = async (kind: string) => (await r.db.query("SELECT count(*)::int AS n FROM session_events WHERE session_id = $1 AND kind = $2", [sid, kind])).rows[0].n as number;
  const turnRow = async () => (await r.db.query("SELECT state, terminal_state, lease_epoch FROM turns WHERE id = $1", [turnId])).rows[0] as { state: string; terminal_state: string | null; lease_epoch: string | number };
  // The in-loop adoption backoff is shortened (a test seam); production waits 1s, 2s, 4s, 8s.
  // The slow (parked) retry cadence is shortened too: production asks every 30s.
  // The owed-archive backoff is shortened for the record-only case: production waits 2s…60s.
  lane = startNucleusLane({ registry, relayUrl: r.base, token: "app-token", machineId: machine, log: (x: string) => logs.push(x), adoptionRetryMs: [200, 400], ...(parked ? { adoptionPendingRetryMs: 300 } : {}), ...(prior === "sweep_then_cancelled" ? { adoptionPendingRetryMs: 1_000 } : {}), ...(prior === "sweep_during_retry" || prior === "retry_before_sweep_cancelled" ? { adoptionPendingRetryMs: 150 } : {}), ...(recordOnly ? { archiveRetryMs: { min: 200, max: 400 } } : {}) });
  return { id, sid, turnId, row, ledger, next, logs, faults, starts, adoptions, reconcileRunning, terminalAnswers, sweepClosed, retryHeld, releaseRetry, sweepHeld, releaseSweep, execution, events, turnRow, lane: () => lane!, coordinator: () => c, r };
}

test.each(["dispatching", "running", "acknowledged"] as const)(
  "real relay, lease expired + swept, new driver generation confirms running, fresh lane (%s): the turn is adopted, the local command keeps running, one /start at most, one terminal when the runtime ends",
  async (prior) => {
    const t = await scenario(prior);
    // The boot pass never interrupts a turn the ledger still owns; the
    // resumed loop adopts it under the new lease instead.
    await until(async () => (await t.execution()).state === "running");
    expect(await t.execution()).toMatchObject({ state: "running", turnId: t.turnId, cancelRequested: false });
    expect(t.coordinator().state(t.row.id)).toBe("running");
    expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
    expect(t.logs.some((l) => /adopted on the relay under this lease/.test(l))).toBe(true);
    await sleep(400);
    expect(t.coordinator().state(t.row.id)).toBe("running"); // nothing cancelled it
    expect(t.starts()).toBeLessThanOrEqual(1);
    if (prior === "acknowledged") expect(t.starts()).toBe(0); // the ack is the durable fact
    expect(await t.events("turn.started")).toBe(1); // adoption + a replayed /start are ONE start
    expect(t.ledger.hasReceipt(t.id, "relay_start", t.turnId)).toBe(true);
    // Fenced to the lane's lease (epoch 2), not the swept one.
    expect(String((await t.turnRow()).lease_epoch)).toBe("2");
    expect(await t.events("turn.terminal")).toBe(0);
    // The runtime ends → the command's terminal is the turn's, published once.
    t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
    await until(async () => (await t.execution()).state === "idle");
    await until(() => t.coordinator().state(t.row.id) === "completed");
    await sleep(300);
    expect(await t.events("turn.terminal")).toBe(1);
    expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
    expect(t.starts()).toBeLessThanOrEqual(1);
  }, 30_000);

test("real relay: a cancel the app requested before the crash survives the adoption — the resumed loop cancels locally and publishes one cancelled terminal", async () => {
  const t = await scenario("cancelling");
  await until(async () => (await t.execution()).state === "cancelling");
  expect(await t.execution()).toMatchObject({ state: "cancelling", turnId: t.turnId, cancelRequested: true });
  // The adoption carried the relay's cancel to the coordinator: the runtime is interrupted…
  await until(() => t.next.interrupts.length > 0);
  expect(t.starts()).toBe(0);
  // …and confirms it; the turn closes cancelled, once.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(async () => (await t.execution()).state === "idle");
  await until(() => t.coordinator().state(t.row.id) === "cancelled");
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
}, 30_000);

test("real relay: /start answers 409 turn_terminal for a turn the relay already closed (not cancelled) while the runtime confirms it running — the local command is NOT cancelled; its outcome posts as the terminal fact when it ends", async () => {
  const t = await scenario("closed_remotely");
  await until(() => t.logs.some((l) => /the relay already closed this turn interrupted/.test(l)));
  expect(t.coordinator().state(t.row.id)).toBe("running");
  await sleep(500);
  expect(t.coordinator().state(t.row.id)).toBe("running"); // no blind cancel on the recovery 409
  expect(t.logs.some((l) => /→ cancelled locally/.test(l))).toBe(false);
  expect(t.next.interrupts).toHaveLength(0);
  expect(await t.execution()).toMatchObject({ state: "idle" });
  // The runtime ends: the local outcome is reported through the terminal
  // fact (the relay's first terminal stands; the fact is acknowledged as a replay).
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
  await until(() => t.coordinator().state(t.row.id) === "completed");
  await until(() => t.ledger.hasOutboundEvent(`term:${t.turnId}`));
  await until(() => t.logs.some((l) => /\] completed$/.test(l)));
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "interrupted" });
  expect(t.starts()).toBeLessThanOrEqual(1);
}, 30_000);

test("real relay: reconcile{running} answers 503 twice, then normally — the local command stays running, ONE adoption lands, no /start-refusal cancel (F14)", async () => {
  const t = await scenario("adoption_unavailable_twice");
  // The bounded backoff rides out the outage; the third answer adopts.
  await until(() => t.logs.some((l) => /adopted on the relay under this lease/.test(l)), 15_000);
  expect(t.reconcileRunning()).toBe(3);
  expect(t.adoptions()).toBe(1);
  expect(t.logs.filter((l) => /adoption unavailable .* retrying/.test(l))).toHaveLength(2);
  await until(async () => (await t.execution()).state === "running");
  expect(await t.execution()).toMatchObject({ state: "running", turnId: t.turnId, cancelRequested: false });
  expect(String((await t.turnRow()).lease_epoch)).toBe("2");
  // The owed /start is posted once the adoption is in (a replay: one start event, the ack recorded).
  await until(() => t.ledger.hasReceipt(t.id, "relay_start", t.turnId));
  expect(t.starts()).toBe(1);
  expect(await t.events("turn.started")).toBe(1);
  await sleep(400);
  expect(t.coordinator().state(t.row.id)).toBe("running");
  expect(t.next.interrupts).toHaveLength(0);
  expect(t.logs.some((l) => /→ cancelled locally/.test(l))).toBe(false);
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({ turnId: t.turnId, commandId: t.row.id, state: "running" })]);
  // The runtime ends → one terminal, the runtime's own.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
  await until(() => t.coordinator().state(t.row.id) === "completed");
  await until(async () => (await t.execution()).state === "idle");
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
}, 30_000);

test("real relay: reconcile{running} answers 503 for good — the turn is adoption_pending in the lane state, the command keeps running, nothing is cancelled and no /start is posted; the runtime's outcome still lands as the ONE terminal (F14)", async () => {
  const t = await scenario("adoption_unavailable");
  await until(() => t.logs.some((l) => /adoption_pending, the command keeps running/.test(l)), 15_000);
  expect(t.reconcileRunning()).toBe(3); // the bounded backoff: 1 + 2 retries
  expect(t.adoptions()).toBe(0);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({
    turnId: t.turnId, localSessionId: t.id, commandId: t.row.id, state: "adoption_pending", attempts: 1, lastError: expect.stringMatching(/503/),
  })]);
  await sleep(600);
  // Unresolved is not permission to cancel — or to guess a /start.
  expect(t.coordinator().state(t.row.id)).toBe("running");
  expect(t.next.interrupts).toHaveLength(0);
  expect(t.starts()).toBe(0);
  expect(t.logs.some((l) => /→ cancelled locally/.test(l))).toBe(false);
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
  expect(await t.execution()).toMatchObject({ state: "orphaned", turnId: t.turnId }); // still the relay's picture; nothing invented
  expect(await t.events("turn.terminal")).toBe(0);
  // The runtime ends while the adoption is still pending: the recorded
  // outcome is the turn's terminal — published once, never `interrupted`.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
  await until(() => t.coordinator().state(t.row.id) === "completed");
  await until(async () => (await t.turnRow()).state === "terminal");
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  expect(t.lane().relayTurns()).toEqual([]);
}, 30_000);

test("real relay: the command COMPLETED in the ledger but the process died before its terminal row — boot derives the terminal from the command BEFORE orphan cleanup: ONE `completed`, never `interrupted` (F14)", async () => {
  const t = await scenario("terminal_before_outbox");
  await until(() => t.logs.some((l) => /completed in the ledger with no terminal row/.test(l)));
  await until(async () => (await t.turnRow()).state === "terminal");
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
  await sleep(500);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  expect((await t.execution()).state).toBe("idle");
  // The derived row is the stable `term:<turn>`: acked once, never doubled.
  expect(t.ledger.hasOutboundEvent(`term:${t.turnId}`)).toBe(true);
  await until(() => !t.ledger.hasTerminalFor(t.turnId)); // acked
  expect(t.starts()).toBe(0);
  expect(t.adoptions()).toBe(0);
  expect(t.coordinator().state(t.row.id)).toBe("completed");
}, 30_000);

test("real relay: parked adoption_pending, then the retry finds the relay closed the turn `completed` while the runtime still runs — the answer is honoured ONCE (no retry burst, no re-adoption), the marker clears, and the runtime's own outcome is the one terminal publication (F21)", async () => {
  const t = await scenario("parked_then_terminal");
  await until(() => t.logs.some((l) => /adoption_pending, the command keeps running/.test(l)), 15_000);
  expect(t.reconcileRunning()).toBe(3);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({ turnId: t.turnId, state: "adoption_pending" })]);
  // The slow retry asks once more; the relay answers with the terminal it holds.
  await until(() => t.terminalAnswers() === 1, 10_000);
  await until(() => t.logs.some((l) => /the relay already closed this turn completed/.test(l)));
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  // Astra, F21: the marker used to stay set — twelve adoptions in one burst.
  // Now: the marker is off, the loop is in one fresh bounded wait, and the
  // relay is never asked about this turn again.
  await sleep(1_500); // five parked-retry periods
  expect(t.reconcileRunning()).toBe(4);
  expect(t.terminalAnswers()).toBe(1);
  expect(t.adoptions()).toBe(0);
  expect(t.logs.filter((l) => /the relay already closed this turn completed/.test(l))).toHaveLength(1);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({ turnId: t.turnId, state: "running" })]);
  // The runtime was never touched: no cancel, no interrupt, no /start for a closed turn.
  expect(t.coordinator().state(t.row.id)).toBe("running");
  expect(t.next.interrupts).toHaveLength(0);
  expect(t.starts()).toBe(0);
  expect(t.logs.some((l) => /→ cancelled locally/.test(l))).toBe(false);
  expect(await t.events("turn.terminal")).toBe(1);
  // The runtime ends: the fresh wait sees it at once (no stale 30s slice),
  // the outcome is committed once and the relay's first terminal stands.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "completed" });
  await until(() => t.coordinator().state(t.row.id) === "completed");
  await until(() => t.ledger.hasOutboundEvent(`term:${t.turnId}`));
  await until(() => t.logs.some((l) => /\] completed$/.test(l)));
  await until(() => t.lane().relayTurns().length === 0);
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  expect(t.reconcileRunning()).toBe(4);
}, 30_000);

test("real relay: parked adoption_pending, then the app requests a cancel — the retry adopts `cancelling`, the local cancel happens once, no retry burst, one cancelled terminal (F21)", async () => {
  const t = await scenario("parked_then_cancelling");
  await until(() => t.logs.some((l) => /adoption_pending, the command keeps running/.test(l)), 15_000);
  expect(t.reconcileRunning()).toBe(3);
  // The app cancels the (orphaned) turn: the relay records the request and
  // the next adoption answers `cancelling`.
  const cxl = await t.r.call("POST", `/joy/v2/sessions/${t.sid}/turns/${t.turnId}/cancellations`, { body: {} });
  expect(cxl.status).toBe(200);
  await until(() => t.logs.some((l) => /adopted on the relay with a cancel pending/.test(l)), 10_000);
  expect(t.adoptions()).toBe(1);
  await until(async () => (await t.execution()).state === "cancelling");
  expect(await t.execution()).toMatchObject({ state: "cancelling", turnId: t.turnId, cancelRequested: true });
  await until(() => t.next.interrupts.length > 0);
  const asked = t.reconcileRunning();
  // No burst: the marker cleared on the `cancelling` answer, the loop is in
  // a fresh bounded wait — the relay is not asked again while the runtime
  // confirms the interrupt.
  await sleep(1_500);
  expect(t.reconcileRunning()).toBe(asked);
  expect(t.adoptions()).toBe(1);
  expect(t.logs.filter((l) => /→ cancelling locally/.test(l))).toHaveLength(1);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({ turnId: t.turnId, state: "running" })]);
  expect(await t.events("turn.terminal")).toBe(0);
  // The runtime confirms: one cancelled terminal.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(async () => (await t.execution()).state === "idle");
  await until(() => t.coordinator().state(t.row.id) === "cancelled");
  await sleep(300);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
  expect(t.reconcileRunning()).toBe(asked);
}, 30_000);

test("real relay + SQLite: the command COMPLETED in the ledger, the session exists only as a window record (no live handle), no terminal row — boot derives the terminal from the command, the relay turn closes `completed` ONCE, and only THEN is the record-only session archived (F21)", async () => {
  const t = await scenario("terminal_record_only");
  // Derived from the ledger with no handle in the registry…
  await until(() => t.logs.some((l) => /completed in the ledger with no terminal row/.test(l)));
  expect(t.ledger.hasOutboundEvent(`term:${t.turnId}`)).toBe(true);
  // …and the archive waits for it: the boot pass owes it to the retry loop.
  await until(() => t.logs.some((l) => /archive .* deferred — local c9session still owes a saved terminal/.test(l)));
  expect(t.logs.some((l) => /archived orphan/.test(l))).toBe(false);
  // The saved outcome lands first.
  await until(async () => (await t.turnRow()).state === "terminal");
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  await until(() => !t.ledger.hasTerminalFor(t.turnId)); // acked
  // Then the archive.
  await until(() => t.logs.some((l) => /archived replacement row .* for ended session c9session/.test(l)), 10_000);
  const sessionRow = async () => (await t.r.db.query("SELECT state FROM native_sessions WHERE id = $1", [t.sid])).rows[0] as { state: string };
  expect((await sessionRow()).state).toBe("archived");
  // The relay's own clocks agree: the turn was closed before the row was archived.
  const order = await t.r.db.query("SELECT (s.updated_at >= tu.terminal_at) AS after_terminal, tu.terminal_at IS NOT NULL AS closed FROM native_sessions s, turns tu WHERE s.id = $1 AND tu.id = $2", [t.sid, t.turnId]);
  expect(order.rows[0]).toMatchObject({ after_terminal: true, closed: true });
  const iDeferred = t.logs.findIndex((l) => /deferred — local c9session still owes/.test(l));
  const iArchived = t.logs.findIndex((l) => /archived replacement row/.test(l));
  expect(iDeferred).toBeGreaterThanOrEqual(0);
  expect(iArchived).toBeGreaterThan(iDeferred);
  await sleep(500);
  // ONE terminal, the saved `completed` — never `interrupted`, never doubled.
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  expect((await t.execution()).state).toBe("idle");
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
  expect(t.logs.some((l) => /archived orphan/.test(l))).toBe(false);
  expect(t.logs.filter((l) => /archived replacement row/.test(l))).toHaveLength(1);
  expect(t.starts()).toBe(0);
  expect(t.adoptions()).toBe(0);
  expect(t.coordinator().state(t.row.id)).toBe("completed");
  expect(t.lane().relayTurns()).toEqual([]);
}, 30_000);

test("real relay: the ORPHAN SWEEP's own reconcile is answered terminal/cancelled (the turn closed between its GET and its reconcile) while the loop's adoption is parked — the sweep CARRIES that answer to the loop, which cancels the local command instead of waiting behind a closed turn (F28)", async () => {
  const t = await scenario("sweep_then_cancelled");
  // The loop's own adoption never reaches the relay: the turn parks.
  await until(() => t.lane().relayTurns().some((x) => x.state === "adoption_pending"), 15_000);
  expect(t.coordinator().state(t.row.id)).toBe("running");
  expect(t.next.interrupts).toHaveLength(0);
  // The every-tick sweep reads the orphan and asks; the turn is closed
  // `cancelled` just before its reconcile lands, so the SWEEP holds the
  // relay's only answer about this turn.
  await until(() => t.sweepClosed(), 25_000);
  await until(() => t.logs.some((l) => /was orphaned but .* still runs it here → adopted \(terminal\)/.test(l)), 10_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
  // Before the fix the sweep cleared the marker and DROPPED the answer: the
  // loop took the fresh terminal wait, swallowed its own /start 409
  // turn_cancelled, and waited out a live command with cancelRequestedAt
  // null and zero interrupts. Now the answer arrives through honourAdoption.
  await until(() => t.logs.some((l) => /the relay closed this turn cancelled \(orphan sweep\) → cancelled locally/.test(l)), 20_000);
  await until(() => t.next.interrupts.length > 0, 10_000);
  expect(t.ledger.getCommand(t.row.id)?.cancelRequestedAt).not.toBeNull();
  expect(t.coordinator().state(t.row.id)).not.toBe("running");
  // No /start was ever posted for a turn the relay had closed.
  expect(t.starts()).toBe(0);
  expect(t.logs.some((l) => /\/start after the adoption refused/.test(l))).toBe(false);
  // The runtime confirms the interrupt: the relay's `cancelled` stands, once.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(() => t.coordinator().state(t.row.id) === "cancelled");
  await until(() => !t.lane().relayTurns().some((x) => x.turnId === t.turnId), 10_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
}, 60_000);

test("real relay: the ORPHAN SWEEP answers terminal/cancelled while the loop's OWN adoption retry is still IN FLIGHT — the two answers overlap and the FIRST complete one wins: no TypeError over the marker the sweep cleared, the local command is cancelled once, and no synthetic `failed` terminal is invented over a live runtime (F30)", async () => {
  const t = await scenario("sweep_during_retry");
  // Every terminal this lane commits for the turn, in order: the F30 defect
  // published a synthetic `failed` from resumeTurn's catch — over a command
  // that was still running, with nothing ever cancelled.
  const terminals: string[] = [];
  const realEnqueue = t.ledger.enqueueOutbound.bind(t.ledger);
  vi.spyOn(t.ledger, "enqueueOutbound").mockImplementation((rows: NewOutbound[]) => {
    for (const x of rows) if (x.kind === "terminal" && x.relayTurnId === t.turnId) terminals.push(String((x.body as { terminalState?: string }).terminalState));
    return realEnqueue(rows);
  });
  // The loop parks (its own daemon_restart adoption is refused), then its
  // slow retry fires — and is HELD mid-flight at the relay.
  await until(() => t.retryHeld(), 20_000);
  expect(t.coordinator().state(t.row.id)).toBe("running");
  // While it hangs there the SWEEP gets the relay's only answer — cancelled —
  // and clears the pending marker the retry is standing on.
  await until(() => t.sweepClosed(), 25_000);
  await until(() => t.logs.some((l) => /was orphaned but .* still runs it here → adopted \(terminal\)/.test(l)), 10_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
  // Now the retry's own reconcile completes. It must NOT read the marker back
  // across its await (`entry.adoptionPending.attempts` threw TypeError here)
  // and must NOT apply a second answer: the sweep's was complete first, so
  // the sweep's is the one honoured — through the same honourAdoption.
  t.releaseRetry();
  await until(() => t.next.interrupts.length > 0, 20_000);
  expect(t.logs.some((l) => /TypeError/.test(l))).toBe(false);
  expect(t.logs.some((l) => / error: /.test(l))).toBe(false);
  await until(() => t.logs.some((l) => /the relay closed this turn cancelled \(orphan sweep, which answered first\) → cancelled locally/.test(l)), 10_000);
  expect(t.ledger.getCommand(t.row.id)?.cancelRequestedAt).not.toBeNull();
  expect(t.next.interrupts).toHaveLength(1);
  // No /start was ever posted for a turn the relay had closed.
  expect(t.starts()).toBe(0);
  // The runtime confirms the interrupt: the turn closes cancelled, and the
  // ONLY terminal ever committed for it is that `cancelled`.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(() => t.coordinator().state(t.row.id) === "cancelled");
  await until(() => !t.lane().relayTurns().some((x) => x.turnId === t.turnId), 10_000);
  expect(terminals).toEqual(["cancelled"]);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
}, 90_000);

test("real relay: the REVERSE order — the loop's retry adopts the orphaned turn `running` FIRST and takes its /start ack, and only then does the sweep observe a real terminal/cancelled close: cancellation is monotone, so the later answer is applied (not dropped behind the epoch) and it wakes the loop's 30-minute terminal wait (F31)", async () => {
  const t = await scenario("retry_before_sweep_cancelled");
  // Every terminal this lane commits for the turn, in order: exactly one
  // `cancelled` — never a second cancel because both sides saw the close.
  const terminals: string[] = [];
  const realEnqueue = t.ledger.enqueueOutbound.bind(t.ledger);
  vi.spyOn(t.ledger, "enqueueOutbound").mockImplementation((rows: NewOutbound[]) => {
    for (const x of rows) if (x.kind === "terminal" && x.relayTurnId === t.turnId) terminals.push(String((x.body as { terminalState?: string }).terminalState));
    return realEnqueue(rows);
  });
  // BOTH reconciles begin while the turn is orphaned: the loop parks (its own
  // daemon_restart adoption is refused), its slow retry fires and is HELD, and
  // the sweep's GET reads `orphaned` before its reconcile is HELD too.
  await until(() => t.retryHeld(), 20_000);
  await until(() => t.sweepHeld(), 25_000);
  expect(t.coordinator().state(t.row.id)).toBe("running");
  // The LOOP wins: released first, it adopts the turn `running` under this
  // lease, posts the owed /start and gets the durable ack. It is now in Phase
  // C's terminal wait — as long as the turn may run (30 minutes).
  t.releaseRetry();
  await until(() => t.logs.some((l) => /adopted on the relay under this lease/.test(l)), 15_000);
  await until(() => t.ledger.hasReceipt(t.id, "relay_start", t.turnId), 15_000);
  await until(async () => (await t.execution()).state === "running", 15_000);
  expect(t.lane().relayTurns()).toEqual([expect.objectContaining({ turnId: t.turnId, commandId: t.row.id, state: "running" })]);
  expect(t.next.interrupts).toHaveLength(0);
  // NOW the sweep's held reconcile lands, over a turn the relay has since
  // closed `cancelled` — an answer NEWER than the loop's `running`.
  const releasedAt = Date.now();
  t.releaseSweep();
  await until(() => t.sweepClosed(), 15_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
  // Before the fix the epoch alone decided: the sweep's answer was logged as
  // dropped because the loop had advanced it, the relay turn stayed
  // terminal/cancelled with the local command running (cancelRequestedAt
  // null, zero interrupts), and the loop's terminal wait had no consumer
  // until the 30-minute cap. Now the later cancellation is carried…
  await until(() => t.logs.some((l) => /was adopted by its own loop first, but the relay has since closed it cancelled — cancellation is monotone/.test(l)), 15_000);
  expect(t.logs.some((l) => /terminal answer is dropped/.test(l))).toBe(false);
  // …and it WAKES the wait: the durable cancel and the interrupt happen
  // within seconds of the answer, not at the cap.
  await until(() => t.next.interrupts.length > 0, 15_000);
  await until(() => t.logs.some((l) => /the relay closed this turn cancelled \(orphan sweep\) → cancelled locally/.test(l)), 10_000);
  expect(Date.now() - releasedAt).toBeLessThan(15_000); // the wait is 30 MINUTES without the wake
  expect(t.ledger.getCommand(t.row.id)?.cancelRequestedAt).not.toBeNull();
  expect(t.next.interrupts).toHaveLength(1);
  expect(t.coordinator().state(t.row.id)).toBe("cancelling"); // not cancelled yet: the runtime has not confirmed
  // No duplicate cancel: the same close, observed by both sides, is applied
  // once — one interrupt, one local terminal, one relay terminal event.
  await sleep(800);
  expect(t.next.interrupts).toHaveLength(1);
  expect(t.logs.filter((l) => /→ cancelled locally/.test(l))).toHaveLength(1);
  expect(t.logs.some((l) => /TypeError/.test(l))).toBe(false);
  expect(t.logs.some((l) => / error: /.test(l))).toBe(false);
  expect(terminals).toEqual(["cancelled"]);
  // The runtime confirms the interrupt: the command reaches `cancelled`, and
  // the relay's `cancelled` stands — one terminal, no synthetic `failed`.
  t.next.emit({ kind: "turn_ended", runtimeTurnId: "RuntimeTurn", status: "cancelled" });
  await until(() => t.coordinator().state(t.row.id) === "cancelled", 10_000);
  await until(() => !t.lane().relayTurns().some((x) => x.turnId === t.turnId), 10_000);
  await sleep(300);
  expect(terminals).toEqual(["cancelled"]);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "cancelled" });
  expect((await t.execution()).state).toBe("idle");
}, 120_000);

test("real relay + SQLite: the ledger's COMMAND SCAN throws while a saved `completed` is still owed — a readable-but-empty outbox after a FAILED scan is not a clean slate: nothing is archived, and once the ledger reads again the derived terminal lands BEFORE the archive (F28)", async () => {
  const t = await scenario("terminal_record_read_failure");
  // The scan failure is reported, and the archive waits on an UNKNOWN.
  await until(() => t.logs.some((l) => /the ledger's commands cannot be read/.test(l)), 15_000);
  await until(() => t.logs.some((l) => /archive .* deferred — local c9session's ledger cannot be read/.test(l)), 15_000);
  await sleep(1_200); // several archive-retry periods
  expect(t.logs.some((l) => /archived orphan/.test(l))).toBe(false);
  expect(t.logs.some((l) => /archived replacement row/.test(l))).toBe(false);
  expect(t.ledger.hasOutboundEvent(`term:${t.turnId}`)).toBe(false);
  expect((await t.turnRow()).state).not.toBe("terminal");
  const sessionRow = async () => (await t.r.db.query("SELECT state FROM native_sessions WHERE id = $1", [t.sid])).rows[0] as { state: string };
  expect((await sessionRow()).state).not.toBe("archived");
  // Storage recovers: derivation retries, the saved outcome lands first…
  t.faults.readFails = false;
  await until(() => t.logs.some((l) => /completed in the ledger with no terminal row/.test(l)), 15_000);
  await until(() => t.ledger.hasOutboundEvent(`term:${t.turnId}`), 10_000);
  await until(async () => (await t.turnRow()).state === "terminal", 15_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  // …and only THEN the archive.
  await until(() => t.logs.some((l) => /archived replacement row .* for ended session c9session/.test(l)), 15_000);
  expect((await sessionRow()).state).toBe("archived");
  const order = await t.r.db.query("SELECT (s.updated_at >= tu.terminal_at) AS after_terminal FROM native_sessions s, turns tu WHERE s.id = $1 AND tu.id = $2", [t.sid, t.turnId]);
  expect(order.rows[0]).toMatchObject({ after_terminal: true });
  await sleep(400);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(t.logs.filter((l) => /archived replacement row/.test(l))).toHaveLength(1);
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
}, 60_000);

test("real relay + SQLite: the derived terminal's outbox WRITE is refused and the row is held in memory — the held intent counts as owed: no archive while it is held, and once the ledger accepts writes the terminal is committed and lands BEFORE the archive (F28)", async () => {
  const t = await scenario("terminal_record_write_failure");
  // The row is derived, refused, and held — the ledger has no terminal row.
  await until(() => t.logs.some((l) => /completed in the ledger with no terminal row/.test(l)), 15_000);
  await until(() => t.logs.some((l) => /outbox commit failed/.test(l)), 15_000);
  expect(t.ledger.hasOutboundEvent(`term:${t.turnId}`)).toBe(false);
  await until(() => t.logs.some((l) => /archive .* deferred — local c9session still owes a saved terminal/.test(l)), 15_000);
  await sleep(1_200); // several archive-retry periods
  expect(t.logs.some((l) => /archived orphan/.test(l))).toBe(false);
  expect(t.logs.some((l) => /archived replacement row/.test(l))).toBe(false);
  expect((await t.turnRow()).state).not.toBe("terminal");
  const sessionRow = async () => (await t.r.db.query("SELECT state FROM native_sessions WHERE id = $1", [t.sid])).rows[0] as { state: string };
  expect((await sessionRow()).state).not.toBe("archived");
  // Storage recovers: the held row is re-committed by the derivation the
  // archive retry drives — no waiting for the slow sweep.
  t.faults.writeFails = false;
  await until(() => t.logs.some((l) => /outbox persistence restored/.test(l)), 15_000);
  expect(t.ledger.hasOutboundEvent(`term:${t.turnId}`)).toBe(true);
  await until(async () => (await t.turnRow()).state === "terminal", 15_000);
  expect(await t.turnRow()).toMatchObject({ state: "terminal", terminal_state: "completed" });
  await until(() => t.logs.some((l) => /archived replacement row .* for ended session c9session/.test(l)), 15_000);
  expect((await sessionRow()).state).toBe("archived");
  const order = await t.r.db.query("SELECT (s.updated_at >= tu.terminal_at) AS after_terminal FROM native_sessions s, turns tu WHERE s.id = $1 AND tu.id = $2", [t.sid, t.turnId]);
  expect(order.rows[0]).toMatchObject({ after_terminal: true });
  await sleep(400);
  expect(await t.events("turn.terminal")).toBe(1);
  expect(t.logs.filter((l) => /archived replacement row/.test(l))).toHaveLength(1);
  expect(t.logs.some((l) => /was orphaned → interrupted/.test(l))).toBe(false);
}, 60_000);
