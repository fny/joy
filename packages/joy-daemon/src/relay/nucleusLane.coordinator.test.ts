// The lane on the session coordinator (Wave C2, phase 3): a prompt offer is
// a command row carrying the relay turn; /start follows the driver's
// delivery echo (no busy() guess, no activity gate); the terminal fact is
// the command's terminal state and reason (#463 #584); a cancel offer is
// the row's durable cancel (retried until the runtime confirms; a re-offer
// is not new work); a restart mid-turn ends the turn interrupted{restart}
// (design table). A FakeDriver stands in for the adapter; the fake relay is
// the same scripted server the other lane tests use.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-coord-test-"));
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { ledgerFor, closeAllLedgers } from "../domain/ledger";
import { coordinatorFor, resetCoordinators } from "../domain/coordinator";
import { FakeDriver, settle } from "../domain/coordinator.fakeDriver";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string) => JSON.stringify({ v: 1, t: "spawn", cwd, agent: "codex" });
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

function makeFakeRelay() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const answers = new Map<string, { status: number; body: unknown }>();
  let workOffers: any[] = [];
  let controlOffers: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "");
      const method = req.method!;
      const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const a = answers.get(`${method} ${path}`);
      if (a) { calls.push({ method, path, body }); return send(a.body, a.status); }
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
      if (path.endsWith("/claims/control")) { const o = controlOffers; controlOffers = []; return send({ offers: o }); }
      if (path === "/sessions" && method === "GET") return send({ sessions: [] });
      calls.push({ method, path, body });
      send({ ok: true });
    });
  });
  return {
    server, calls, answers,
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    pushWork: (o: any) => workOffers.push(o),
    pushControl: (o: any) => controlOffers.push(o),
    facts: (turn: string) => calls.filter((c) => c.path === `/daemon/turns/${turn}/facts`).map((c) => c.body),
    terminal: (turn: string) => calls.find((c) => c.path === `/daemon/turns/${turn}/facts` && c.body.type === "terminal")?.body,
    count: (frag: string) => calls.filter((c) => c.path.includes(frag)).length,
  };
}

/** A coordinator-driven session: no queue surface of its own (no enqueue). */
function coordinatedSession(id: string) {
  const ledger = ledgerFor();
  const gen = ledger.openGeneration(id, "codex");
  const driver = new FakeDriver(id, gen);
  const coordinator = coordinatorFor(ledger);
  coordinator.adopt(id, driver);
  driver.ready();
  const s: any = {
    id, status: "active", cwd: "/tmp/x", claudeSessionId: undefined, agentFlavor: "codex",
    busy: () => coordinator.busy(id),
    abort: () => coordinator.abortRunning(id),
    end(reason: "killed" | "process_exited" | "restart") { s.status = "ended"; coordinator.retire(id, reason); return true; },
  };
  return { s, driver, coordinator, ledger };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
beforeEach(() => { closeAllLedgers(); resetCoordinators(); });
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane on the coordinator", () => {
  it("prompt: accept(relayTurnId) → /start on the driver's echo → terminal from the runtime's turn-end (failed stays failed)", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000001");
    const registry: any = { get: (i: string) => (i === "cs000001" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("do it") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t1")!;
    expect(row).toMatchObject({ text: "do it", relayCommandId: "c1", state: "submitting", origin: "relay" });
    expect(relay.count("/turns/t1/submitted")).toBe(1);
    expect(relay.count("/turns/t1/start")).toBe(0); // no delivery proof yet: no start
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T1" });
    await settle();
    expect(relay.count("/turns/t1/start")).toBe(0); // accepted is not running
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T1", receiptKind: "codex_client" });
    await until(() => relay.count("/turns/t1/start") === 1);
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T1", status: "failed" });
    await until(() => !!relay.terminal("t1"), 10_000);
    expect(relay.terminal("t1")).toMatchObject({ terminalState: "failed", meta: { reason: "agent_reported_failed" } });
    expect(ledger.getCommand(row.id)?.state).toBe("failed");
    // A re-offer of the same turn is the same row — never a second submit.
    relay.pushWork({ deliveryId: "d1b", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("do it") });
    await sleep(1_500);
    expect(driver.submits).toHaveLength(1);
  }, 25_000);

  it("cancel: the row's durable cancel → the driver's interrupt (retried) → terminal cancelled; a re-offer is not new work", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000002");
    driver.onInterrupt = () => ({ kind: "sent" });
    const registry: any = { get: (i: string) => (i === "cs000002" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m2", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s2", kind: "prompt", turnId: "t2", ciphertext: enc("long job") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t2")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T2" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T2" });
    await until(() => relay.count("/turns/t2/start") === 1);
    for (let i = 0; i < 3; i++) { relay.pushControl({ deliveryId: `dc${i}`, commandId: `cc${i}`, sessionId: "v2s2", targetTurnId: "t2" }); await sleep(600); }
    await until(() => driver.interrupts.length >= 1);
    expect(ledger.getCommand(row.id)?.state).toBe("cancelling");
    expect(driver.lastInterrupt.attempt?.runtimeTurnId).toBe("T2");
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T2", status: "cancelled" });
    await until(() => !!relay.terminal("t2"), 10_000);
    expect(relay.terminal("t2")).toMatchObject({ terminalState: "cancelled" });
    expect(relay.count("/deliveries/dc0/received")).toBe(1);
    expect(relay.count("/deliveries/dc1/received")).toBe(1); // every offer is received…
    expect(driver.interrupts.length).toBeLessThanOrEqual(2); // …but the interrupt is not re-fired per re-offer
  }, 25_000);

  it("restart mid-turn: the command ends interrupted{restart} and so does the relay turn", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger } = coordinatedSession("cs000003");
    const registry: any = { get: (i: string) => (i === "cs000003" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m3", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s3", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.count("/bind") === 1);
    relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s3", kind: "prompt", turnId: "t3", ciphertext: enc("work") });
    await until(() => driver.submits.length === 1);
    const row = ledger.commandForRelayTurn("t3")!;
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T3" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: "T3" });
    await until(() => relay.count("/turns/t3/start") === 1);
    s.end("restart");
    await until(() => !!relay.terminal("t3"), 10_000);
    expect(relay.terminal("t3")).toMatchObject({ terminalState: "interrupted", meta: { reason: "restart" } });
    expect(ledger.getCommand(row.id)).toMatchObject({ state: "interrupted", terminalReason: "restart" });
  }, 25_000);

  it("boot: a relay turn the ledger still carries gets its loop back and its terminal row (R13)", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const { s, driver, ledger, coordinator } = coordinatedSession("cs000004");
    // A previous daemon accepted the turn and its runtime is still running it.
    const c = coordinator.accept({ sessionId: "cs000004", text: "carried", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: "t4", relayCommandId: "c4" });
    await settle();
    driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: "T4" });
    await settle();
    driver.emit({ kind: "echo", runtimeRef: c.id, runtimeTurnId: "T4" });
    expect(ledger.getCommand(c.id)?.state).toBe("running");
    // …and one that ended while no lane was alive.
    const done = coordinator.accept({ sessionId: "cs000004", text: "ended", source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: "t5", relayCommandId: "c5" });
    coordinator.cancel(done.id);
    expect(ledger.getCommand(done.id)?.state).toBe("cancelled");
    const registry: any = { get: (i: string) => (i === "cs000004" ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [{ id: "cs000004", v2SessionId: "v2s4" }], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m4", log: () => {} });
    await until(() => !!relay.terminal("t5"), 10_000);
    expect(relay.terminal("t5")).toMatchObject({ terminalState: "cancelled" });
    expect(relay.count("/turns/t4/start")).toBe(0); // already running before the restart: not re-started
    driver.emit({ kind: "turn_ended", runtimeTurnId: "T4", status: "completed" });
    await until(() => !!relay.terminal("t4"), 10_000);
    expect(relay.terminal("t4")).toMatchObject({ terminalState: "completed" });
  }, 25_000);

  // #584: the relay lane once chose `completed` for a turn purely because no
  // cancellation had been requested and the session had gone idle — a
  // provider failure the adapter had already reported was relayed as a
  // success. On the coordinator the terminal fact IS the command's state, so
  // idle establishes only that execution STOPPED. Pinned here for the whole
  // outcome vocabulary, and against a session that reports itself idle
  // BEFORE the runtime's verdict arrives (the shape that used to lie).
  it("the terminal fact is the command's state, never an idle guess (#584)", async () => {
    for (const [n, status, terminalState, reason] of [
      [0, "failed", "failed", "agent_reported_failed"],
      [1, "cancelled", "cancelled", "agent_reported_cancelled"],
      [2, "completed", "completed", undefined],
    ] as Array<[number, "failed" | "cancelled" | "completed", string, string | undefined]>) {
      const relay = makeFakeRelay();
      const url = await relay.listen();
      const id = `cs58400${n}`;
      const { s, driver, ledger } = coordinatedSession(id);
      const registry: any = { get: (i: string) => (i === id ? s : undefined), list: () => [s], create: async () => s, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
      const lane = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: `m58${n}`, log: () => {} });
      try {
        const turn = `t58${n}`;
        relay.pushWork({ deliveryId: `ds${n}`, commandId: `sp${n}`, sessionId: `v2s58${n}`, kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.count("/bind") === 1);
        relay.pushWork({ deliveryId: `d${n}`, commandId: `c${n}`, sessionId: `v2s58${n}`, kind: "prompt", turnId: turn, ciphertext: enc("go") });
        await until(() => driver.submits.length === 1);
        const row = ledger.commandForRelayTurn(turn)!;
        driver.lastSubmit.settle.resolve({ kind: "accepted", runtimeTurnId: `T${n}` });
        await settle();
        driver.emit({ kind: "echo", runtimeRef: row.id, runtimeTurnId: `T${n}` });
        await until(() => relay.count(`/turns/${turn}/start`) === 1);
        // Idle first, verdict second: nothing may terminalize on the gap.
        await sleep(600);
        expect(relay.terminal(turn)).toBeUndefined();
        driver.emit({ kind: "turn_ended", runtimeTurnId: `T${n}`, status });
        await until(() => !!relay.terminal(turn), 10_000);
        expect(relay.terminal(turn)!.terminalState, status).toBe(terminalState);
        expect(relay.terminal(turn)!.terminalState).toBe(ledger.getCommand(row.id)!.state);
        expect(relay.terminal(turn)!.meta?.reason).toBe(reason);
      } finally {
        await lane.stop();
        relay.server.close();
      }
    }
  }, 40_000);
});
