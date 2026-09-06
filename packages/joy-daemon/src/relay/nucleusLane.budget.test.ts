// #130 — the relay's per-session event budget, made visible.
//
// At 50,000 events the relay answers `429 session_event_budget_exhausted` and
// never clears it (docs/API.md): the lane drops that session's further output
// so the turn can still terminalize. That drop was announced in one daemon
// log line and nowhere else — the user saw a conversation that simply stopped
// growing, with no way to tell a quiet agent from a truncated one and no idea
// that a fresh session was the way out. The budget SEMANTICS are unchanged
// here (still permanent, still dropped, the turn still terminalizes); what is
// asserted is that the loss is now counted and carried on the card.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-budget-test-"));
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { createRelaySession, encodeTextEvent } from "./relay";
import { closeAllLedgers } from "../domain/ledger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spawnSpec = (cwd: string) => JSON.stringify({ v: 1, t: "spawn", cwd, agent: "claude" });
async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

function makeFakeRelay() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let budgetOut = false;
  let workOffers: any[] = [];
  // What GET /sessions lists for this daemon — a fresh lane rebuilds its
  // bindings from it (refreshBindings), the way a restarted daemon does.
  const bindings: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "");
      const method = req.method!;
      const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
      if (path.endsWith("/claims/control")) return send({ offers: [] });
      if (path === "/sessions" && method === "GET") return send({ sessions: bindings });
      calls.push({ method, path, body });
      // Every session fact refused for good, the way a full session answers.
      if (budgetOut && /\/facts$/.test(path)) return send({ error: "session_event_budget_exhausted" }, 429);
      send({ ok: true });
    });
  });
  return {
    server, calls,
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    pushWork: (o: any) => workOffers.push(o),
    exhaust: () => { budgetOut = true; },
    bind: (row: any) => bindings.push(row),
    cards: () => calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/daemon/sessions/")).map((c) => c.body),
    facts: () => calls.filter((c) => /\/facts$/.test(c.path)),
  };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane: relay event budget exhausted (#130)", () => {
  it("counts the dropped output and carries it on the card", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const session: any = { id: "bud00001", status: "active", cwd: "/tmp/x", busy: () => false, queueState: () => ({ pendingCount: 0, paused: false }), enqueue: () => ({ id: "q1" }), abort: async () => ({ ok: true }) };
    const registry: any = { get: (i: string) => (i === "bud00001" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mb1", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2b1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
    await until(() => relay.calls.some((c) => c.path.endsWith("/bind")));

    // The card holder the adapters use — the same one the lane reaches for.
    const rs = createRelaySession({ creds: { machineId: "mb1" } } as any, { cwd: "/tmp/x", id: "bud00001" });
    // Healthy first: output lands, no banner.
    rs.send(encodeTextEvent("before the wall", { turn: "a1" }), "bud00001:1");
    await until(() => relay.facts().length >= 1);
    expect(handle.eventBudgetDrops()).toEqual([]);
    expect(rs.metadataSnapshot?.joy__eventBudget).toBeUndefined();

    relay.exhaust();
    for (let i = 2; i <= 6; i++) rs.send(encodeTextEvent(`dropped ${i}`, { turn: "a1" }), `bud00001:${i}`);
    await until(() => handle!.eventBudgetDrops()[0]?.dropped >= 5, 15_000);
    const [drop] = handle.eventBudgetDrops();
    expect(drop).toMatchObject({ v2SessionId: "v2b1", localSessionId: "bud00001" });
    expect(drop.dropped).toBeGreaterThanOrEqual(5);
    expect(drop.since).toBeGreaterThan(0);

    // The budget SEMANTICS are unchanged: nothing is retried against the
    // relay after the refusal — the drop is permanent, just no longer silent.
    const factsAfter = relay.facts().length;
    await sleep(1_500);
    expect(relay.facts().length).toBe(factsAfter);

    // And the loss reached the card: one coalesced PATCH carrying the banner.
    await until(() => rs.metadataSnapshot?.joy__eventBudget != null, 10_000);
    expect(rs.metadataSnapshot!.joy__eventBudget).toMatchObject({ dropped: drop.dropped });
  }, 40_000);

  // The warning is the ONLY trace of the loss, and a full session is exactly
  // the one no further output ever reaches the relay from — so nothing after
  // a restart would re-count it. The lane persists the count in the ledger
  // and re-asserts the card when a fresh lane (fresh holder, fresh maps)
  // rebinds the session.
  it("survives a lane replacement: a fresh lane over the same ledger republishes the card", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const session: any = { id: "bud00002", status: "active", cwd: "/tmp/y", busy: () => false, queueState: () => ({ pendingCount: 0, paused: false }), enqueue: () => ({ id: "q1" }), abort: async () => ({ ok: true }) };
    const registry: any = { get: (i: string) => (i === "bud00002" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mb2", log: () => {} });
    relay.pushWork({ deliveryId: "d0", commandId: "spawnc2", sessionId: "v2b2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/y") });
    await until(() => relay.calls.some((c) => c.path.endsWith("/bind")));
    const rs = createRelaySession({ creds: { machineId: "mb2" } } as any, { cwd: "/tmp/y", id: "bud00002" });
    relay.exhaust();
    for (let i = 1; i <= 4; i++) rs.send(encodeTextEvent(`dropped ${i}`, { turn: "a1" }), `bud00002:${i}`);
    await until(() => handle!.eventBudgetDrops()[0]?.dropped >= 4, 15_000);
    await until(() => rs.metadataSnapshot?.joy__eventBudget != null, 10_000);
    const [drop] = handle.eventBudgetDrops();

    // Replace everything in-process that knew about the loss: the lane (its
    // maps and timers), the card holder (a fresh one carries no banner), and
    // the cached ledger handle (the next lane reopens the file from disk).
    await handle.stop(); handle = null;
    closeAllLedgers();
    const rs2 = createRelaySession({ creds: { machineId: "mb2" } } as any, { cwd: "/tmp/y", id: "bud00002" });
    expect(rs2.metadataSnapshot?.joy__eventBudget).toBeUndefined();
    relay.bind({ sessionId: "v2b2", daemonId: "mb2", state: "active", localSessionId: "bud00002" });
    const cardsBefore = relay.cards().length;
    const factsBefore = relay.facts().length;

    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mb2", log: () => {} });
    // No new drop happened, yet the fresh holder's card carries the same loss…
    await until(() => rs2.metadataSnapshot?.joy__eventBudget != null, 15_000);
    expect(rs2.metadataSnapshot!.joy__eventBudget).toEqual({ since: drop.since, dropped: drop.dropped });
    expect(relay.cards().length).toBeGreaterThan(cardsBefore);
    // …the diagnostic sees it too…
    expect(handle.eventBudgetDrops()).toEqual([{ v2SessionId: "v2b2", localSessionId: "bud00002", since: drop.since, dropped: drop.dropped }]);
    // …and the refusal is still treated as permanent: a record sent after the
    // restart is counted, not re-offered to the relay.
    rs2.send(encodeTextEvent("after restart", { turn: "a2" }), "bud00002:9");
    await until(() => handle!.eventBudgetDrops()[0]?.dropped === drop.dropped + 1, 15_000);
    await sleep(500);
    expect(relay.facts().length).toBe(factsBefore);
  }, 60_000);
});
