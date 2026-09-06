// #614 / #612 relay-contract follow-ups on the nucleus lane:
//  - /submitted and /start can answer 409 session_archived / session_failed:
//    cancel-class — nothing dispatched, no retry, never a `failed` terminal.
//  - every spawn-failed report names its delivery (attempt) and the relay's
//    `{ok, applied:false, reason}` is logged, not treated as an error.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { fakeCoordinatedSession } from "../domain/coordinator.fakeDriver";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { DirectoryCreationApprovalRequired } from "../domain/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-gone-test-"));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string) => JSON.stringify({ v: 1, t: "spawn", cwd, agent: "claude" });
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

/** Scripted relay like nucleusLane.test.ts, plus per-path answer overrides. */
function makeFakeRelay() {
    const calls: Array<{ path: string; body: any }> = [];
    const answers = new Map<string, { status: number; body: unknown }>();
    let workOffers: any[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            const path = req.url!.replace(/^\/joy\/v2/, "");
            const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
            if (/^\/daemon\/leases\/[^/]+$/.test(path) && req.method === "PUT") return send({ ok: true });
            if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
            if (path.endsWith("/claims/control")) return send({ offers: [] });
            if (path === "/sessions") return send({ sessions: [] });
            calls.push({ path, body });
            const a = answers.get(path);
            if (a) return send(a.body, a.status);
            send({ ok: true });
        });
    });
    return {
        server, calls, answers,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        pushWork: (o: any) => workOffers.push(o),
        facts: (turn: string) => calls.filter(c => c.path === `/daemon/turns/${turn}/facts`).map(c => c.body),
    };
}

function makeFakeSession(id: string) {
    const f = fakeCoordinatedSession(id, { agent: "claude" });
    f.driver.onInterrupt = () => ({ kind: "sent" });
    const s: any = f.s;
    s.accepted = f.accepted; s.complete = f.complete; s.driver = f.driver; s.coordinator = f.coordinator;
    return s;
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane: session_archived / session_failed (#614)", () => {
    it("/submitted 409 session_archived: nothing enqueued, no terminal posted, the lane goes on serving", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc1");
        const registry: any = { get: (i: string) => (i === "loc1" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        const logs: string[] = [];
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: (l) => logs.push(l) });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.calls.some(c => c.path.endsWith("/bind")));

        relay.answers.set("/daemon/turns/t1/submitted", { status: 409, body: { error: "session_archived" } });
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("late prompt") });
        await until(() => relay.calls.some(c => c.path === "/daemon/turns/t1/submitted"));
        await sleep(1500);
        expect(session.accepted()).toEqual([]);                        // never accepted
        expect(relay.facts("t1")).toEqual([]);                         // no terminal of any kind — the relay resolved it
        expect(logs.some(l => /t1.*\/submitted refused \(session_archived\)/.test(l))).toBe(true);
        expect(logs.some(l => /turn t1.* error/.test(l))).toBe(false); // not the generic lane_error path

        // The lane is not wedged: a turn for a live session still runs its lifecycle.
        relay.pushWork({ deliveryId: "d2", commandId: "c2", sessionId: "v2s1", kind: "prompt", turnId: "t2", ciphertext: enc("next") });
        await until(() => relay.calls.some(c => c.path === "/daemon/turns/t2/submitted"));
        await until(() => session.accepted().includes("next"));
    }, 25_000);

    it("/start 409 session_failed: the admitted prompt is plucked + aborted and the turn closes `cancelled`, never `failed`", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc2");
        const registry: any = { get: (i: string) => (i === "loc2" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.calls.some(c => c.path.endsWith("/bind")));

        relay.answers.set("/daemon/turns/t3/start", { status: 409, body: { error: "session_failed" } });
        relay.pushWork({ deliveryId: "d3", commandId: "c3", sessionId: "v2s2", kind: "prompt", turnId: "t3", ciphertext: enc("hi") });
        await until(() => session.accepted().includes("hi"));            // accepted + echoed → running → the lane posts /start
        await until(() => relay.facts("t3").some(b => b.type === "terminal"));
        const terminals = relay.facts("t3").filter(b => b.type === "terminal");
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({ terminalState: "cancelled", meta: { reason: "session_failed" } });
        // The admitted prompt is cancelled durably and the runtime interrupted.
        const row = session.coordinator.commandForRelayTurn("t3");
        expect(["cancelling", "cancelled"]).toContain(row?.state);
        await until(() => session.driver.interrupts.length >= 1);
    }, 25_000);
});

describe("nucleusLane: spawn-failed names its attempt (#612)", () => {
    it("posts deliveryId with the reason and logs an `applied:false` answer instead of failing", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const registry: any = {
            get: () => undefined,
            create: async () => { throw new DirectoryCreationApprovalRequired("/tmp/nope-does-not-exist"); },
            chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
        };
        const logs: string[] = [];
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: (l) => logs.push(l) });
        relay.answers.set("/daemon/sessions/v2s9/spawn-failed", { status: 200, body: { ok: true, applied: false, reason: "stale_attempt" } });
        relay.pushWork({ deliveryId: "dA1", commandId: "sp9", sessionId: "v2s9", kind: "spawn_session", ciphertext: spawnSpec("/tmp/nope-does-not-exist") });
        await until(() => relay.calls.some(c => c.path === "/daemon/sessions/v2s9/spawn-failed"));
        const report = relay.calls.find(c => c.path === "/daemon/sessions/v2s9/spawn-failed")!;
        expect(report.body).toEqual({ reason: "dir_missing:/tmp/nope-does-not-exist", deliveryId: "dA1" });
        await until(() => logs.some(l => /dir_missing report not applied \(stale_attempt\)/.test(l)));
        expect(logs.some(l => /failed to report dir_missing/.test(l))).toBe(false);
    }, 15_000);
});
