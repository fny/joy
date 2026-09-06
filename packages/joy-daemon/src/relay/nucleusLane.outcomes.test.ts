// Lane contracts from the 2026-09-05 review wave, against a scripted relay:
//  #584 — a turn the adapter ended with status `failed` terminalizes `failed`
//         (idle only proves execution STOPPED);
//  #581 — a spawn is marked abandoned only once its failure report is ACKED,
//         so a transient 503 on spawn-failed does not silence the retry;
//  #115 — (lane side) a prompt the adapter reports as handled:"command" is an
//         immediately-terminal turn, never parked for 180s;
//  #120 — a bound session whose relay row is gone (card deleted while the
//         daemon was unreachable) is unbound and re-announced under a fresh
//         row, both when the loss shows up as a 404 on a card PATCH and when a
//         recovered record names a row the relay no longer has.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { RelaySession, encodeTurnEnd, encodeTextEvent } from "./relay";
import { publishV2Card } from "./v2Card";
import { DirectoryCreationApprovalRequired } from "../domain/registry";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-outcomes-test-"));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const enc = (t: string) => JSON.stringify({ v: 1, t: "plain", text: t });
const spawnSpec = (cwd: string) => JSON.stringify({ v: 1, t: "spawn", cwd, agent: "claude" });
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}
const adapterFor = (localId: string) => new RelaySession({ client: { creds: { machineId: "m" } } as any, relaySessionId: localId, metadata: {} });

/** Scripted relay: method-aware answer overrides (`answers` key = "METHOD path"), records every call. */
function makeFakeRelay(sessions: any[] = []) {
    const calls: Array<{ method: string; path: string; body: any }> = [];
    const answers = new Map<string, { status: number; body: unknown } | ((body: any) => { status: number; body: unknown })>();
    let workOffers: any[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            const path = req.url!.replace(/^\/joy\/v2/, "");
            const method = req.method!;
            const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            const a = answers.get(`${method} ${path}`);
            if (a) { calls.push({ method, path, body }); const r = typeof a === "function" ? a(body) : a; return send(r.body, r.status); }
            if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
            if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
            if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
            if (path.endsWith("/claims/control")) return send({ offers: [] });
            if (path === "/sessions" && method === "GET") return send({ sessions });
            calls.push({ method, path, body });
            send({ ok: true });
        });
    });
    return {
        server, calls, answers,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        pushWork: (o: any) => workOffers.push(o),
        facts: (turn: string) => calls.filter(c => c.path === `/daemon/turns/${turn}/facts`).map(c => c.body),
        count: (method: string, path: string) => calls.filter(c => c.method === method && c.path === path).length,
    };
}

function makeFakeSession(id: string, extra: Record<string, unknown> = {}) {
    const s: any = {
        id, status: "active", cwd: "/tmp/x", claudeSessionId: undefined,
        _busy: false, _pending: 0, _aborts: 0, _cancelQueued: 0, enqueued: [] as string[],
        busy: () => s._busy,
        queueState: () => ({ pendingCount: s._pending, paused: false }),
        enqueue: (text: string) => { s.enqueued.push(text); s._pending = 1; return { id: "q1" }; },
        cancelQueued: () => { s._cancelQueued++; return true; },
        abort: async () => { s._aborts++; s._busy = false; return { ok: true }; },
        ...extra,
    };
    return s;
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("nucleusLane: adapter turn outcome (#584)", () => {
    it("a turn the adapter ended as `failed` terminalizes failed, not completed", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc1");
        const registry: any = { get: (i: string) => (i === "loc1" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s1", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.calls.some(c => c.path.endsWith("/bind")));
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s1", kind: "prompt", turnId: "t1", ciphertext: enc("do it") });
        await until(() => session.enqueued.includes("do it"));
        session._pending = 0; session._busy = true;                     // dispatched + running → /start
        await until(() => relay.calls.some(c => c.path === "/daemon/turns/t1/start"));
        const adapter = adapterFor("loc1");
        adapter.send(encodeTextEvent("partial", { turn: "a1" }), "loc1:text:1");
        adapter.send(encodeTurnEnd("failed", { turn: "a1" }), "loc1:a1:end"); // provider error, per the adapter
        await sleep(300);
        session._busy = false;                                          // execution stopped
        await until(() => relay.facts("t1").some(b => b.type === "terminal"), 10_000);
        const terminal = relay.facts("t1").find(b => b.type === "terminal");
        expect(terminal).toMatchObject({ terminalState: "failed", meta: { reason: "agent_reported_failed" } });
        // The failure record itself was forwarded before the terminal.
        const idxOut = relay.calls.findIndex(c => c.path === "/daemon/turns/t1/facts" && c.body.type === "output");
        const idxTerm = relay.calls.findIndex(c => c.path === "/daemon/turns/t1/facts" && c.body.type === "terminal");
        expect(idxOut).toBeGreaterThanOrEqual(0);
        expect(idxOut).toBeLessThan(idxTerm);
    }, 25_000);

    it("a turn the adapter ended as `completed` still terminalizes completed (control)", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc2");
        const registry: any = { get: (i: string) => (i === "loc2" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s2", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.calls.some(c => c.path.endsWith("/bind")));
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s2", kind: "prompt", turnId: "t2", ciphertext: enc("ok") });
        await until(() => session.enqueued.includes("ok"));
        session._pending = 0; session._busy = true;
        await until(() => relay.calls.some(c => c.path === "/daemon/turns/t2/start"));
        adapterFor("loc2").send(encodeTurnEnd("completed", { turn: "a2" }), "loc2:a2:end");
        await sleep(300);
        session._busy = false;
        await until(() => relay.facts("t2").some(b => b.type === "terminal"), 10_000);
        expect(relay.facts("t2").find(b => b.type === "terminal")).toMatchObject({ terminalState: "completed" });
    }, 25_000);
});

describe("nucleusLane: spawn-failed report acknowledged before abandoning (#581)", () => {
    it("a 503 on spawn-failed leaves the spawn retryable; the next offer reports again", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const registry: any = {
            get: () => undefined,
            create: async () => { throw new DirectoryCreationApprovalRequired("/tmp/nope-missing"); },
            chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        const report = "POST /daemon/sessions/v2s9/spawn-failed";
        relay.answers.set(report, { status: 503, body: { error: "unavailable" } });
        const offer = { deliveryId: "dA1", commandId: "sp9", sessionId: "v2s9", kind: "spawn_session", ciphertext: spawnSpec("/tmp/nope-missing") };
        relay.pushWork(offer);
        await until(() => relay.count("POST", "/daemon/sessions/v2s9/spawn-failed") === 1);
        // The relay recovers; the command is re-offered (same commandId, no createDir).
        relay.answers.delete(report);
        relay.pushWork({ ...offer, deliveryId: "dA2" });
        await until(() => relay.count("POST", "/daemon/sessions/v2s9/spawn-failed") === 2, 10_000);
        const second = relay.calls.filter(c => c.path === "/daemon/sessions/v2s9/spawn-failed")[1];
        expect(second.body).toEqual({ reason: "dir_missing:/tmp/nope-missing", deliveryId: "dA2" });
        // Acknowledged now → abandoned: a third offer gets only its receipt.
        relay.pushWork({ ...offer, deliveryId: "dA3" });
        await until(() => relay.calls.some(c => c.path === "/daemon/deliveries/dA3/received"));
        await sleep(800);
        expect(relay.count("POST", "/daemon/sessions/v2s9/spawn-failed")).toBe(2);
    }, 25_000);

    // #581 residual (Astra on 4a69e55c): the relay answers 200 with
    // `{ok:true, applied:false, reason:'stale_attempt'}` — it did NOT apply
    // the failure, the spawn command is still live and still queued. Reading
    // that as an acknowledgement abandoned the command anyway, so the app
    // never saw the directory approval it needed: the same dead end the 503
    // fix closed, one HTTP round trip later.
    it("a report the relay did not apply to a still-live command is reported again", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const registry: any = {
            get: () => undefined,
            create: async () => { throw new DirectoryCreationApprovalRequired("/tmp/nope-missing"); },
            chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        const report = "POST /daemon/sessions/v2s8/spawn-failed";
        relay.answers.set(report, { status: 200, body: { ok: true, applied: false, reason: "stale_attempt" } });
        const offer = { deliveryId: "dB1", commandId: "sp8", sessionId: "v2s8", kind: "spawn_session", ciphertext: spawnSpec("/tmp/nope-missing") };
        relay.pushWork(offer);
        await until(() => relay.count("POST", "/daemon/sessions/v2s8/spawn-failed") === 1);
        // A current delivery of the SAME command: the stale answer retired the
        // delivery, never the command.
        relay.pushWork({ ...offer, deliveryId: "dB2" });
        await until(() => relay.count("POST", "/daemon/sessions/v2s8/spawn-failed") === 2, 10_000);
        expect(relay.calls.filter(c => c.path === "/daemon/sessions/v2s8/spawn-failed")[1].body)
            .toEqual({ reason: "dir_missing:/tmp/nope-missing", deliveryId: "dB2" });
        // `already_bound` DOES settle the command — a later attempt won it.
        relay.answers.set(report, { status: 200, body: { ok: true, applied: false, reason: "already_bound" } });
        relay.pushWork({ ...offer, deliveryId: "dB3" });
        await until(() => relay.count("POST", "/daemon/sessions/v2s8/spawn-failed") === 3, 10_000);
        relay.pushWork({ ...offer, deliveryId: "dB4" });
        await until(() => relay.calls.some(c => c.path === "/daemon/deliveries/dB4/received"));
        await sleep(800);
        expect(relay.count("POST", "/daemon/sessions/v2s8/spawn-failed")).toBe(3);
    }, 25_000);
});

describe("nucleusLane: a handled joy command is an immediately-terminal turn (#115, lane side)", () => {
    it("enqueue → handled:'command' closes the turn completed without waiting for busy()", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc5", { enqueue: (text: string) => ({ id: "cmd1", text, createdAt: Date.now(), handled: "command" }) });
        const registry: any = { get: (i: string) => (i === "loc5" ? session : undefined), create: async () => session, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2s5", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.calls.some(c => c.path.endsWith("/bind")));
        const t0 = Date.now();
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s5", kind: "prompt", turnId: "t5", ciphertext: enc("/title Renamed") });
        await until(() => relay.facts("t5").some(b => b.type === "terminal"));
        expect(Date.now() - t0).toBeLessThan(5_000);                    // not the 180s no_agent_activity wait
        expect(relay.facts("t5").find(b => b.type === "terminal")).toMatchObject({ terminalState: "completed", meta: { reason: "handled_as_command" } });
    }, 15_000);
});

describe("nucleusLane: a deleted relay row behind a live session (#120)", () => {
    it("card PATCH 404 → unbound, re-announced under a fresh row, record updated, card republished", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const saved: Array<Record<string, unknown>> = [];
        const session = makeFakeSession("loc7", { cardMetadata: () => ({ path: "/tmp/x", joy__state: "running" }) });
        let records: any[] = [];
        const registry: any = {
            get: (i: string) => (i === "loc7" ? session : undefined), create: async () => session, chatHistory: () => [],
            list: () => [session],
            listRecords: () => records,
            saveRecord: (id: string, patch: Record<string, unknown>) => { saved.push({ id, ...patch }); records = [{ id, launchCwd: "/tmp/x", ...(records[0] ?? {}), ...patch }]; },
        };
        const logs: string[] = [];
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: (l) => logs.push(l) });
        relay.pushWork({ deliveryId: "d0", commandId: "spawnc", sessionId: "v2gone", kind: "spawn_session", ciphertext: spawnSpec("/tmp/x") });
        await until(() => relay.count("PATCH", "/daemon/sessions/v2gone") >= 1);   // bound; first card published

        // The app deleted the card while a kill never reached us: the row is gone.
        relay.answers.set("PATCH /daemon/sessions/v2gone", { status: 404, body: { error: "session_not_found" } });
        relay.answers.set("POST /sessions", (body: any) => ({ status: 200, body: { sessionId: body.creationIntentId.includes("after:") ? "v2fresh" : "v2wrong" } }));
        await publishV2Card("loc7", { path: "/tmp/x", joy__state: "running", summary: { text: "still alive" } });

        await until(() => relay.count("PATCH", "/daemon/sessions/v2fresh") >= 1, 10_000);
        const announce = relay.calls.find(c => c.method === "POST" && c.path === "/sessions")!;
        expect(announce.body).toMatchObject({ mode: "announce_existing", localSessionId: "loc7", daemonId: "m1" });
        expect(announce.body.creationIntentId).toContain("after:v2gone");          // a NEW intent, not the dead row's replay
        expect(saved.some(p => p.id === "loc7" && p.v2SessionId === "v2fresh")).toBe(true);
        expect(logs.some(l => /loc7: relay row v2gone is gone \(card PATCH 404\)/.test(l))).toBe(true);
        // Nothing else was written to the dead row after the detection.
        const deadWrites = relay.calls.filter(c => c.path === "/daemon/sessions/v2gone" && c.method === "PATCH").length;
        await sleep(500);
        expect(relay.calls.filter(c => c.path === "/daemon/sessions/v2gone" && c.method === "PATCH").length).toBe(deadWrites);
    }, 25_000);

    it("boot: a recovered record naming a row the relay no longer has is verified (GET 404) and re-announced", async () => {
        const relay = makeFakeRelay([]);                                   // the relay lists nothing for this daemon
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc8", { cardMetadata: () => ({ path: "/tmp/x", joy__state: "running" }) });
        const saved: Array<Record<string, unknown>> = [];
        let records: any[] = [{ id: "loc8", launchCwd: "/tmp/x", v2SessionId: "v2dead", socket: null }];
        const registry: any = {
            get: (i: string) => (i === "loc8" ? session : undefined), create: async () => session, chatHistory: () => [],
            list: () => [session],
            listRecords: () => records,
            saveRecord: (id: string, patch: Record<string, unknown>) => { saved.push({ id, ...patch }); records = [{ ...records[0], ...patch }]; },
        };
        relay.answers.set("GET /sessions/v2dead", { status: 404, body: { error: "session_not_found" } });
        relay.answers.set("POST /sessions", (body: any) => ({ status: 200, body: { sessionId: body.creationIntentId.includes("after:v2dead") ? "v2new" : "v2wrong" } }));
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        // The announce pass runs on the sweep cadence (8s).
        await until(() => relay.count("PATCH", "/daemon/sessions/v2new") >= 1, 15_000);
        expect(relay.count("GET", "/sessions/v2dead")).toBeGreaterThanOrEqual(1);
        expect(saved.some(p => p.id === "loc8" && p.v2SessionId === "v2new")).toBe(true);
        expect(relay.count("PATCH", "/daemon/sessions/v2dead")).toBe(0);        // never bound to the dead row
    }, 25_000);

    it("a kill that lands during the recovered-row GET ends the announce: no replacement row, no record resurrected", async () => {
        const relay = makeFakeRelay([]);
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc9", { cardMetadata: () => (session.status === "ended" ? null : { joy__state: "running" }) });
        let records: any[] = [{ id: "loc9", launchCwd: "/tmp/x", v2SessionId: "v2del", socket: null }];
        const saved: Array<Record<string, unknown>> = [];
        const registry: any = {
            get: (i: string) => (i === "loc9" ? session : undefined), create: async () => session, chatHistory: () => [],
            list: () => [session], listRecords: () => records,
            saveRecord: (id: string, patch: Record<string, unknown>) => { saved.push({ id, ...patch }); records = [{ id, ...(records[0] ?? {}), ...patch }]; },
        };
        // The user kills the session while the row check is outstanding: the
        // registry ends it and deletes its record before the 404 comes back.
        relay.answers.set("GET /sessions/v2del", (() => { session.status = "ended"; records = []; return { status: 404, body: { error: "session_not_found" } }; }) as any);
        let announces = 0;
        relay.answers.set("POST /sessions", () => { announces++; return { status: 200, body: { sessionId: "ghost" } }; });
        const logs: string[] = [];
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: (l) => logs.push(l) });
        await until(() => relay.count("GET", "/sessions/v2del") >= 1, 15_000);
        await sleep(1_500);
        expect(announces).toBe(0);                                              // used to POST a replacement for the killed session
        expect(saved).toEqual([]);                                              // the deleted record stays deleted
        expect(records).toEqual([]);
        expect(relay.count("PATCH", "/daemon/sessions/ghost")).toBe(0);
        expect(logs.some(l => /loc9: ended while its relay row was being checked/.test(l))).toBe(true);
    }, 25_000);

    it("a kill that lands during the announce POST archives the replacement row instead of binding it", async () => {
        const relay = makeFakeRelay([]);
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc10", { cardMetadata: () => (session.status === "ended" ? null : { joy__state: "running" }) });
        let records: any[] = [{ id: "loc10", launchCwd: "/tmp/x", v2SessionId: "v2del2", socket: null }];
        const saved: Array<Record<string, unknown>> = [];
        const registry: any = {
            get: (i: string) => (i === "loc10" ? session : undefined), create: async () => session, chatHistory: () => [],
            list: () => [session], listRecords: () => records,
            saveRecord: (id: string, patch: Record<string, unknown>) => { saved.push({ id, ...patch }); records = [{ id, ...(records[0] ?? {}), ...patch }]; },
        };
        relay.answers.set("GET /sessions/v2del2", { status: 404, body: { error: "session_not_found" } });
        // The relay creates the replacement — and the kill lands before the reply is processed.
        relay.answers.set("POST /sessions", (() => { session.status = "ended"; records = []; return { status: 200, body: { sessionId: "ghost2" } }; }) as any);
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });
        await until(() => relay.count("PATCH", "/daemon/sessions/ghost2") >= 1, 15_000);
        await sleep(1_000);
        const patches = relay.calls.filter(c => c.method === "PATCH" && c.path === "/daemon/sessions/ghost2");
        expect(patches).toHaveLength(1);                                        // the archive — never the card publisher
        expect(patches[0].body.state).toBe("archived");
        expect(JSON.parse(patches[0].body.encryptedMetadata).metadata).toMatchObject({ joy__state: "archived", joy__sessionId: "loc10" });
        expect(saved.some(p => p.v2SessionId === "ghost2")).toBe(false);       // the killed identity is not rebound
        expect(records).toEqual([]);
    }, 25_000);
});
