// nucleusLane turn-lifecycle tests. A real fake-relay HTTP server answers the
// lane's /joy/v2/daemon/* calls; a fake registry + fake session let us drive
// and observe the loop. Runs at real cadence (POLL_MS=500), so a full turn is
// a few seconds — the tests are bounded and deterministic.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string, agent = "claude") => JSON.stringify({ v: 1, t: "spawn", cwd, agent });

/** Scripted relay: the test pushes offers; the server hands them out once per
 *  claim, records every lifecycle call the lane makes. */
function makeFakeRelay() {
    const calls: Array<{ path: string; body: any }> = [];
    let workOffers: any[] = [];
    let controlOffers: any[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            const path = req.url!.replace(/^\/joy\/v2/, "");
            const send = (obj: any) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
            if (/^\/daemon\/leases\/[^/]+$/.test(path) && req.method === "PUT") return send({ ok: true });
            if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
            if (path.endsWith("/claims/control")) { const o = controlOffers; controlOffers = []; return send({ offers: o }); }
            if (path === "/sessions") return send({ sessions: [] });
            // lifecycle writes: record + ack
            calls.push({ path, body });
            send({ ok: true });
        });
    });
    return {
        server,
        calls,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        pushWork: (o: any) => workOffers.push(o),
        pushControl: (o: any) => controlOffers.push(o),
        pathsHit: () => calls.map(c => c.path),
        countPath: (frag: string) => calls.filter(c => c.path.includes(frag)).length,
    };
}

/** Fake session with controllable busy()/queueState, records enqueue+abort. */
function makeFakeSession(id: string) {
    const s: any = {
        id, status: "active", claudeSessionId: undefined,
        _busy: false, _pending: 0, _paused: false, _aborts: 0, _cancelQueued: 0, enqueued: [] as string[],
        busy: () => s._busy,
        queueState: () => ({ pendingCount: s._pending, paused: s._paused }),
        enqueue: (text: string) => { s.enqueued.push(text); s._pending = 1; return { id: "q1" }; },
        cancelQueued: () => { s._cancelQueued++; return true; },
        abort: async () => { s._aborts++; s._busy = false; return { ok: true }; },
    };
    return s;
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane turn lifecycle", () => {
    it("prompt: received → submitted → start → output → terminal(completed)", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc1");
        let chat: any[] = [];
        const registry: any = {
            get: (i: string) => (i === "loc1" ? session : undefined),
            create: async () => session,
            chatHistory: () => chat,
            listRecords: () => [{ v2SessionId: "v2s1", socket: null, id: "loc1" }],
            saveRecord: () => {},
        };
        // Pre-bind: the lane maps v2s1→loc1 from GET /sessions? No — /sessions
        // returns []. Bind happens via a spawn offer. Send one, then a prompt.
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        // wait for bind
        await sleep(1500);
        expect(relay.countPath("/bind")).toBe(1);

        // now a prompt turn
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("hi") });
        // let the lane: received, enqueue, submitted (pending→0), start (busy), output, terminal
        await sleep(1200);
        session._pending = 0; session._busy = true;            // dispatched + running
        await sleep(1200);
        chat = [{ id: "9", role: "assistant", content: "answer", session_id: "loc1" }]; // agent output
        await sleep(1200);
        session._busy = false;                                  // turn goes idle
        await sleep(2500);                                      // 3 idle polls → terminal

        const paths = relay.pathsHit();
        expect(paths.some(p => p.includes("/deliveries/d1/received"))).toBe(true);
        expect(paths.some(p => p.includes("/turns/t1/submitted"))).toBe(true);
        expect(paths.some(p => p.includes("/turns/t1/start"))).toBe(true);
        const outputs = relay.calls.filter(c => c.path.includes("/turns/t1/facts") && c.body.type === "output");
        expect(outputs.length).toBeGreaterThanOrEqual(1);
        const terminal = relay.calls.find(c => c.path.includes("/turns/t1/facts") && c.body.type === "terminal");
        expect(terminal?.body.terminalState).toBe("completed");
        expect(session.enqueued).toContain("hi");
    }, 20_000);

    it("cancel: aborts local work ONCE despite repeated control re-offers (dedup)", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc2");
        const registry: any = {
            get: () => session, create: async () => session, chatHistory: () => [],
            listRecords: () => [{ v2SessionId: "v2s2", socket: null, id: "loc2" }], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m2", log: () => {} });
        relay.pushWork({ deliveryId: "ds", commandId: "sp", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/y") });
        await sleep(1500);
        // push the SAME cancel offer repeatedly (simulates the relay re-offering
        // an outstanding cancel until the turn terminalizes).
        for (let i = 0; i < 4; i++) { relay.pushControl({ deliveryId: `dc${i}`, commandId: `cc${i}`, sessionId: "v2s2", targetTurnId: "tX" }); await sleep(700); }
        await sleep(1500);
        // exactly ONE abort despite 4 re-offers
        expect(session._aborts).toBe(1);
    }, 20_000);

    it("plaintext content decodes; sealed-without-key stays queued (no crash)", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc3");
        const registry: any = {
            get: () => session, create: async () => session, chatHistory: () => [],
            listRecords: () => [{ v2SessionId: "v2s3", socket: null, id: "loc3" }], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m3", log: () => {} });
        relay.pushWork({ deliveryId: "ds", commandId: "sp", sessionId: "v2s3", kind: "spawn_session", ciphertext: spawnSpec("/tmp/z") });
        await sleep(1500);
        // undecodable (sealed, no key on this machine) prompt → must NOT enqueue
        relay.pushWork({ deliveryId: "dbad", commandId: "cbad", sessionId: "v2s3", kind: "prompt", turnId: "tbad", ciphertext: "v2e1:AAAA" });
        await sleep(1500);
        expect(session.enqueued.length).toBe(0);            // left queued, not fed to the agent
        // no terminal fabricated for an undecodable prompt
        expect(relay.calls.some(c => c.path.includes("/turns/tbad/facts"))).toBe(false);
    }, 15_000);
});
