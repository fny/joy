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
import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startRelay } from "../../../joy-relay/test/harness.mjs";
import { ledgerFor, closeAllLedgers } from "../domain/ledger";
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
  | "terminal_before_outbox";    // /start applied; the command COMPLETED in the ledger, the process died before its terminal row was committed

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
function interceptFetch(unavailable: (n: number) => boolean = () => false): { starts: () => number; adoptions: () => number; reconcileRunning: () => number } {
  const real = globalThis.fetch;
  let starts = 0, adoptions = 0, reconciles = 0;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    if (method === "POST" && /\/daemon\/turns\/[^/]+\/start$/.test(url)) starts++;
    const isReconcileRunning = method === "POST" && /\/daemon\/turns\/[^/]+\/reconcile$/.test(url)
      && (JSON.parse(String(init?.body ?? "{}")) as { resolution?: string }).resolution === "running";
    if (isReconcileRunning) {
      reconciles++;
      if (unavailable(reconciles)) return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const res = await real(input, init);
    if (isReconcileRunning && res.ok) adoptions++;
    return res;
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = real; };
  return { starts: () => starts, adoptions: () => adoptions, reconcileRunning: () => reconciles };
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
  const beforeStart: readonly Prior[] = ["dispatching", "closed_remotely", "adoption_unavailable_twice", "adoption_unavailable"];
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
  if (prior === "terminal_before_outbox") {
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
  await until(() => c.state(row.id) === (prior === "terminal_before_outbox" ? "completed" : "running"));
  const s: any = { id, status: "active", cwd: dir, agentFlavor: "codex", busy: () => c.busy(id), abort: () => c.abortRunning(id), toJSON: () => ({ id, cwd: dir, status: "active", agent: "codex" }) };
  const registry: any = { get: (x: string) => (x === id ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id, v2SessionId: sid }], saveRecord: () => {} };
  retire = async () => { c.retire(id, "restart"); await settle(); };
  const logs: string[] = [];
  const unavailable = prior === "adoption_unavailable" ? () => true : prior === "adoption_unavailable_twice" ? (n: number) => n <= 2 : undefined;
  const { starts, adoptions, reconcileRunning } = interceptFetch(unavailable);
  const execution = async () => (await r.call("GET", `/joy/v2/sessions/${sid}`)).json.execution as { state: string; turnId: string | null; cancelRequested: boolean };
  const events = async (kind: string) => (await r.db.query("SELECT count(*)::int AS n FROM session_events WHERE session_id = $1 AND kind = $2", [sid, kind])).rows[0].n as number;
  const turnRow = async () => (await r.db.query("SELECT state, terminal_state, lease_epoch FROM turns WHERE id = $1", [turnId])).rows[0] as { state: string; terminal_state: string | null; lease_epoch: string | number };
  // The in-loop adoption backoff is shortened (a test seam); production waits 1s, 2s, 4s, 8s.
  lane = startNucleusLane({ registry, relayUrl: r.base, token: "app-token", machineId: machine, log: (x: string) => logs.push(x), adoptionRetryMs: [200, 400] });
  return { id, sid, turnId, row, ledger, next, logs, starts, adoptions, reconcileRunning, execution, events, turnRow, lane: () => lane!, coordinator: () => c };
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
