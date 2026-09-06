// The lane's sealing trust boundary, end to end against a fake relay:
//   #579 — a session that has a content key dispatches ONLY authenticated
//          v2e1 prompts; plaintext offered to it fails the turn, never enqueues.
//   #582 — pending output keeps its sealing identity in the spool, so a replay
//          after the session's window record (and key) is gone still seals —
//          or drops — and never sends a sealed session's content in plaintext.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import nacl from "tweetnacl";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNucleusLane, decodeRecord, encodeContent, type NucleusLaneHandle } from "./nucleusLane";
import { RelaySession, encodeTextEvent } from "./relay";
import { joyStateDir } from "../paths";

// Never the live daemon's state: each test gets its own JOY_HOME_DIR (the
// lane reads joyStateDir() when it starts).
const freshHome = () => { process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-seal-test-")); };
freshHome();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const b64 = (k: Uint8Array) => Buffer.from(k).toString("base64");
const adapterFor = (localId: string) => new RelaySession({ client: { creds: { machineId: "m" } } as any, relaySessionId: localId, metadata: {} });

function makeFakeRelay(sessions: any[] = []) {
    const calls: Array<{ path: string; body: any }> = [];
    let workOffers: any[] = [];
    const state = { failFacts: false };
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
            const body = raw ? JSON.parse(raw) : {};
            const path = req.url!.replace(/^\/joy\/v2/, "");
            const send = (obj: any, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
            if (/^\/daemon\/leases\/[^/]+$/.test(path) && req.method === "PUT") return send({ ok: true });
            if (path.endsWith("/claims/work")) { const o = workOffers; workOffers = []; return send({ offers: o }); }
            if (path.endsWith("/claims/control")) return send({ offers: [] });
            if (path === "/sessions") return send({ sessions });
            if (state.failFacts && path.endsWith("/facts") && body.type === "output") return send({ error: "unavailable" }, 503);
            calls.push({ path, body });
            send({ ok: true });
        });
    });
    return {
        server, calls, state,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        pushWork: (o: any) => workOffers.push(o),
        outputs: () => calls.filter(c => c.path.endsWith("/facts") && c.body.type === "output"),
    };
}

function makeFakeSession(id: string) {
    const s: any = {
        id, status: "active", cwd: "/tmp", claudeSessionId: undefined,
        _busy: false, _pending: 0, enqueued: [] as string[],
        busy: () => s._busy,
        queueState: () => ({ pendingCount: s._pending, paused: false }),
        enqueue: (text: string) => { s.enqueued.push(text); s._pending = 1; return { id: "q1" }; },
        cancelQueued: () => true,
        abort: async () => ({ ok: true }),
    };
    return s;
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; freshHome(); });

describe("#579 sealed sessions accept only authenticated prompts", () => {
    it("plaintext on a keyed session fails the turn with a reason and never enqueues; a sealed prompt dispatches", async () => {
        const key = nacl.randomBytes(32);
        const account = nacl.box.keyPair();
        // Bound on the relay, key in the window record: what a restart rebuilds.
        const relay = makeFakeRelay([{ sessionId: "v2s", daemonId: "m1", state: "active", localSessionId: "loc" }]);
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc");
        const registry: any = {
            get: (i: string) => (i === "loc" ? session : undefined), create: async () => session, chatHistory: () => [],
            listRecords: () => [{ id: "loc", v2SessionId: "v2s", v2SessionKey: b64(key), socket: null }], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", accountContentPublicKey: account.publicKey, log: () => {} });
        await sleep(1200);

        // A compromised relay swaps the ciphertext for ordinary JSON.
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2s", kind: "prompt", turnId: "tplain", ciphertext: JSON.stringify({ v: 1, t: "plain", text: "rm -rf /" }) });
        await sleep(1500);
        expect(session.enqueued).toEqual([]);
        const facts = relay.calls.find(c => c.path.includes("/turns/tplain/facts"));
        expect(facts).toBeTruthy();
        expect(facts!.body.terminalState).toBe("failed");
        expect(facts!.body.meta.reason).toBe("plaintext_on_sealed_session");

        // The real thing, sealed under the session key, still goes through.
        relay.pushWork({ deliveryId: "d2", commandId: "c2", sessionId: "v2s", kind: "prompt", turnId: "tsealed", ciphertext: encodeContent("hello", key) });
        await sleep(1500);
        expect(session.enqueued).toEqual(["hello"]);
    }, 15_000);
});

describe("#582 spooled output keeps its sealing identity", () => {
    it("a sealed session's live output is spooled WITH its key, and posts sealed", async () => {
        const key = nacl.randomBytes(32);
        const account = nacl.box.keyPair();
        const relay = makeFakeRelay([{ sessionId: "v2s", daemonId: "m2", state: "active", localSessionId: "loc" }]);
        const url = await relay.listen(); srv = relay.server;
        const session = makeFakeSession("loc");
        const registry: any = {
            get: (i: string) => (i === "loc" ? session : undefined), create: async () => session, chatHistory: () => [],
            listRecords: () => [{ id: "loc", v2SessionId: "v2s", v2SessionKey: b64(key), socket: null }], saveRecord: () => {},
        };
        const spoolPath = join(joyStateDir(), "v2-outbound.json");
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m2", accountContentPublicKey: account.publicKey, log: () => {} });
        await sleep(1200);

        relay.state.failFacts = true; // hold the record in the spool so we can look at it
        adapterFor("loc").send(encodeTextEvent("private answer", { turn: "t" }), "loc:text:1");
        await sleep(400);
        const spooled = JSON.parse(readFileSync(spoolPath, "utf8"));
        expect(spooled).toHaveLength(1);
        expect(spooled[0]).toMatchObject({ kind: "output", v2SessionId: "v2s", sealed: true, key: b64(key) });

        relay.state.failFacts = false;
        await sleep(2500); // first retry after 1s backoff
        const posted = relay.outputs();
        expect(posted).toHaveLength(1);
        expect(posted[0].body.ciphertext.startsWith("v2e1:")).toBe(true);
        expect((decodeRecord(posted[0].body.ciphertext, key) as any)?.content?.data?.ev?.text).toBe("private answer");
    }, 15_000);

    it("replay after the window record (and its key) is gone: seals from the spooled key, drops what it cannot seal, never plaintext", async () => {
        const key = nacl.randomBytes(32);
        const account = nacl.box.keyPair();
        const wire = (text: string) => encodeTextEvent(text, { turn: "t" });
        // What a daemon restart finds: the session was killed and its record
        // removed, but its output never drained.
        mkdirSync(joyStateDir(), { recursive: true });
        const spoolPath = join(joyStateDir(), "v2-outbound.json");
        writeFileSync(spoolPath, JSON.stringify([
            { kind: "output", id: "e1", localId: "gone", v2SessionId: "v2s", turnId: null, wire: wire("still sealable"), runtimeEventId: "rec:e1", at: Date.now(), sealed: true, key: b64(key) },
            { kind: "output", id: "e2", localId: "gone", v2SessionId: "v2s", turnId: null, wire: wire("sealed, key lost"), runtimeEventId: "rec:e2", at: Date.now(), sealed: true },
            { kind: "output", id: "e3", localId: "gone", v2SessionId: "v2s", turnId: null, wire: wire("pre-flag entry"), runtimeEventId: "rec:e3", at: Date.now() },
        ]));
        const relay = makeFakeRelay([]);
        const url = await relay.listen(); srv = relay.server;
        const registry: any = { get: () => undefined, create: async () => { throw new Error("no"); }, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m3", accountContentPublicKey: account.publicKey, log: () => {} });
        await sleep(2500);

        const posted = relay.outputs();
        expect(posted.map(p => p.body.runtimeEventId)).toEqual(["rec:e1"]);
        expect(posted[0].body.ciphertext.startsWith("v2e1:")).toBe(true);
        expect((decodeRecord(posted[0].body.ciphertext, key) as any)?.content?.data?.ev?.text).toBe("still sealable");
        // nothing that left this daemon was readable without the key
        expect(relay.calls.every(c => !JSON.stringify(c.body).includes("key lost") && !JSON.stringify(c.body).includes("pre-flag"))).toBe(true);
        // the undeliverable entries were dropped, not left to retry forever
        const left = existsSync(spoolPath) ? JSON.parse(readFileSync(spoolPath, "utf8")) : [];
        expect(left).toEqual([]);
    }, 15_000);

    it("a daemon that never sealed (no account key) still replays a legacy plaintext entry", async () => {
        mkdirSync(joyStateDir(), { recursive: true });
        writeFileSync(join(joyStateDir(), "v2-outbound.json"), JSON.stringify([
            { kind: "output", id: "e3", localId: "gone", v2SessionId: "v2p", turnId: null, wire: encodeTextEvent("legacy plain", { turn: "t" }), runtimeEventId: "rec:legacy", at: Date.now() },
        ]));
        const relay = makeFakeRelay([]);
        const url = await relay.listen(); srv = relay.server;
        const registry: any = { get: () => undefined, create: async () => { throw new Error("no"); }, chatHistory: () => [], listRecords: () => [], saveRecord: () => {} };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m4", log: () => {} });
        await sleep(2000);
        const posted = relay.outputs();
        expect(posted.map(p => p.body.runtimeEventId)).toEqual(["rec:legacy"]);
        expect((decodeRecord(posted[0].body.ciphertext) as any)?.content?.data?.ev?.text).toBe("legacy plain");
    }, 15_000);
});
