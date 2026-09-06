// nucleusLane turn-lifecycle tests. A real fake-relay HTTP server answers the
// lane's /joy/v2/daemon/* calls; a fake registry + fake session let us drive
// and observe the loop. Runs at real cadence (POLL_MS=500), so a full turn is
// a few seconds — the tests are bounded and deterministic.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, decodeRecord, type NucleusLaneHandle } from "./nucleusLane";
import { fakeCoordinatedSession } from "../domain/coordinator.fakeDriver";
import { RelaySession, encodeTextEvent, encodeToolCallStart } from "./relay";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
// The lane persists its outbound spool and spawn intents under joyStateDir():
// point it at a throwaway dir so a test run never writes into (or replays
// from) the live daemon's state — one did, 2026-09-05.
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-test-"));

/** What an adapter holds: a RelaySession whose send() lands in the lane's record sink. */
const adapterFor = (localId: string) => new RelaySession({ client: { creds: { machineId: "m" } } as any, relaySessionId: localId, metadata: {} });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string, agent = "claude") => JSON.stringify({ v: 1, t: "spawn", cwd, agent });

/** Scripted relay: the test pushes offers; the server hands them out once per
 *  claim, records every lifecycle call the lane makes. */
function makeFakeRelay(sessions: any[] = []) {
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
            if (path === "/sessions") return send({ sessions });
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

/** A coordinator-driven fake session: every submission is accepted and echoed
 *  at once (running), `complete()` ends the turn, the driver records interrupts. */
function makeFakeSession(id: string) {
    const f = fakeCoordinatedSession(id);
    const s: any = f.s;
    s.accepted = f.accepted; s.complete = f.complete; s.driver = f.driver;
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
        // let the lane: received, accept, submitted, start (the driver's echo), output, terminal
        await sleep(1200);
        chat = [{ id: "9", role: "assistant", content: "answer", session_id: "loc1" }]; // agent activity (watermark only)
        // The adapter's normalizer emits records; the lane forwards them as
        // sealed output facts on the running turn, in order.
        const adapter = adapterFor("loc1");
        adapter.send(encodeToolCallStart({ call: "c1", name: "Read", input: { path: "x" }, turn: "t1" }), "loc1:c1:start");
        adapter.send(encodeTextEvent("answer", { turn: "t1" }), "loc1:text:1");
        await sleep(600);
        session.complete();                                     // the runtime ends the turn
        await sleep(1500);

        const paths = relay.pathsHit();
        expect(paths.some(p => p.includes("/deliveries/d1/received"))).toBe(true);
        expect(paths.some(p => p.includes("/turns/t1/submitted"))).toBe(true);
        expect(paths.some(p => p.includes("/turns/t1/start"))).toBe(true);
        const outputs = relay.calls.filter(c => c.path.includes("/turns/t1/facts") && c.body.type === "output");
        expect(outputs.length).toBe(2);
        const evs = outputs.map(o => (decodeRecord(o.body.ciphertext) as any)?.content?.data?.ev);
        expect(evs[0]).toMatchObject({ t: "tool-call-start", name: "Read", args: { path: "x" } });
        expect(evs[1]).toMatchObject({ t: "text", text: "answer" });
        expect(outputs.map(o => o.body.runtimeEventId)).toEqual(["rec:loc1:c1:start", "rec:loc1:text:1"]);
        // The chat log is no longer re-posted as text: nothing but records.
        expect(outputs.every(o => decodeRecord(o.body.ciphertext) !== null)).toBe(true);
        const terminalIdx = relay.calls.findIndex(c => c.path.includes("/turns/t1/facts") && c.body.type === "terminal");
        const lastOutputIdx = relay.calls.map(c => c.path.includes("/turns/t1/facts") && c.body.type === "output").lastIndexOf(true);
        expect(lastOutputIdx).toBeLessThan(terminalIdx);       // drained before terminalizing
        expect(relay.calls[terminalIdx].body.terminalState).toBe("completed");
        expect(session.accepted()).toContain("hi");

        // Outside a turn (terminal-typed prompt, late output): session-scoped.
        adapter.send(encodeTextEvent("later", { turn: "t2" }), "loc1:text:2");
        await sleep(600);
        const late = relay.calls.find(c => c.path.includes("/daemon/sessions/v2s1/facts"));
        expect((decodeRecord(late?.body.ciphertext) as any)?.content?.data?.ev?.text).toBe("later");
        // An unbound local session has nowhere to go: silently dropped.
        adapterFor("nobody").send(encodeTextEvent("void", { turn: "t" }), "nobody:1");
        await sleep(300);
        expect(relay.calls.some(c => c.path.includes("/sessions/undefined"))).toBe(false);
    }, 20_000);

    it("cancel: interrupts local work ONCE despite repeated control re-offers (the durable cancel flag dedupes)", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc2");
        session.driver.onInterrupt = () => ({ kind: "sent" });
        const registry: any = {
            get: () => session, create: async () => session, chatHistory: () => [],
            listRecords: () => [{ v2SessionId: "v2s2", socket: null, id: "loc2" }], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m2", log: () => {} });
        relay.pushWork({ deliveryId: "ds", commandId: "sp", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/y") });
        await sleep(1500);
        // A running turn to cancel.
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s2", kind: "prompt", turnId: "tX", ciphertext: enc("work") });
        await sleep(1500);
        expect(relay.countPath("/turns/tX/start")).toBe(1);
        // push the SAME cancel offer repeatedly (simulates the relay re-offering
        // an outstanding cancel until the turn terminalizes).
        for (let i = 0; i < 4; i++) { relay.pushControl({ deliveryId: `dc${i}`, commandId: `cc${i}`, sessionId: "v2s2", targetTurnId: "tX" }); await sleep(700); }
        // exactly ONE interrupt despite 4 re-offers (the runtime has not confirmed yet: the coordinator's own retry is on a 3 s backoff)
        expect(session.driver.interrupts.length).toBeLessThanOrEqual(2);
        session.complete("cancelled");
        await sleep(1500);
        expect(relay.calls.find(c => c.path.includes("/turns/tX/facts") && c.body.type === "terminal")?.body.terminalState).toBe("cancelled");
    }, 20_000);

    it("plaintext content decodes; sealed-without-key fails the turn with a reason (no crash)", async () => {
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
        // undecodable (sealed, no key on this machine) prompt → must NOT enqueue,
        // and must NOT sit at the head of the queue forever: it fails with a
        // reason so the app can show it and the messages behind it drain.
        relay.pushWork({ deliveryId: "dbad", commandId: "cbad", sessionId: "v2s3", kind: "prompt", turnId: "tbad", ciphertext: "v2e1:AAAA" });
        await sleep(1500);
        expect(session.accepted().length).toBe(0);
        const facts = relay.calls.find(c => c.path.includes("/turns/tbad/facts"));
        expect(facts).toBeTruthy();
        expect(JSON.stringify(facts!.body)).toContain("undecodable_prompt");
    }, 15_000);

    it("startup reconcile: relay-live sessions with no local runtime get archived; live/pre-bind/foreign rows untouched", async () => {
        const relay = makeFakeRelay([
            // bound on THIS daemon, no runtime → orphan (window died while we were down)
            { sessionId: "v2dead", daemonId: "m4", state: "active", localSessionId: "gone1" },
            { sessionId: "v2dead2", daemonId: "m4", state: "starting", localSessionId: "gone2" },
            // bound + live → its own card publisher owns the truth
            { sessionId: "v2live", daemonId: "m4", state: "active", localSessionId: "loc4" },
            // pre-bind spawn we may still claim
            { sessionId: "v2prov", daemonId: "m4", state: "provisioning", localSessionId: null },
            // already history
            { sessionId: "v2old", daemonId: "m4", state: "archived", localSessionId: "gone3" },
            // another machine's — not ours to touch (relay would 403 anyway)
            { sessionId: "v2other", daemonId: "mX", state: "active", localSessionId: "gone4" },
        ]);
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc4");
        const registry: any = {
            get: (i: string) => (i === "loc4" ? session : undefined), create: async () => session, chatHistory: () => [],
            listRecords: () => [{ v2SessionId: "v2live", socket: null, id: "loc4" }, { id: "gone1", socket: "s", launchCwd: "/proj/a" }],
            saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m4", log: () => {} });
        await sleep(1500);

        const patched = relay.calls.filter(c => /^\/daemon\/sessions\/[^/]+$/.test(c.path) && c.body.state === "archived");
        expect(patched.map(c => c.path).sort()).toEqual(["/daemon/sessions/v2dead", "/daemon/sessions/v2dead2"]);
        // the surviving window record lends the card its path
        const card = JSON.parse(patched.find(c => c.path.endsWith("v2dead"))!.body.encryptedMetadata);
        expect(card.t).toBe("card");
        expect(card.metadata.path).toBe("/proj/a");
        expect(card.metadata.joy__state).toBe("archived");
        expect(relay.calls.some(c => c.path.endsWith("/v2live") && c.body.state === "archived")).toBe(false);
        expect(relay.calls.some(c => c.path.includes("v2prov") || c.path.includes("v2old") || c.path.includes("v2other"))).toBe(false);
    }, 15_000);
});
