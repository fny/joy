// #107: the app seals `POST /joy/v2/sessions` spawnSpec under the machine's
// "Joy Spawn Spec" key; the nucleus lane opens it. Three things are pinned:
//   - the daemon's deriveSpawnSpecKey is byte for byte the app's
//     deriveKey(machineKey, 'Joy Spawn Spec', [machineId]) — re-implemented
//     here on node crypto exactly as encryption/deriveKey.ts does it;
//   - a sealed spec from the app's encoder launches; a plain-JSON spec (an
//     app that predates the seal) still launches;
//   - a sealed spec under the WRONG key fails the spawn with a clear
//     `bad_spawn_spec` reason and never launches — no hang until the app's
//     deadline, no agent started from a spec nobody could vouch for.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { startNucleusLane, decodeSpawnSpec, isSealedSpawnSpec, type NucleusLaneHandle } from "./nucleusLane";
import { deriveSpawnSpecKey, deriveTunnelKey } from "../tunnel/sealedStream";

process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-spawnspec-test-"));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await sleep(100);
}

// ── the APP side, re-implemented (packages/joy-app/sources/encryption/deriveKey.ts
// + sync/v2/spawnSpec.ts) so this test fails if either end drifts ───────────
const hmac512 = (key: Uint8Array, data: Uint8Array) => new Uint8Array(createHmac("sha512", Buffer.from(key)).update(Buffer.from(data)).digest());
function appDeriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    let I = hmac512(new TextEncoder().encode(usage + " Master Seed"), master);
    let state = { key: I.slice(0, 32), chainCode: I.slice(32) };
    for (const index of path) {
        I = hmac512(state.chainCode, new Uint8Array([0x0, ...new TextEncoder().encode(index)]));
        state = { key: I.slice(0, 32), chainCode: I.slice(32) };
    }
    return state.key;
}
const appSpawnSpecKey = (machineKey: Uint8Array, machineId: string) => appDeriveKey(machineKey, "Joy Spawn Spec", [machineId]);
/** encodeSpawnSpec(spec, key): 'v2e1:' + b64(nonce24 ‖ secretbox(utf8(json))). */
function appEncodeSpawnSpec(spec: Record<string, unknown>, key: Uint8Array | null): string {
    const json = JSON.stringify({ v: 1, t: "spawn", ...spec });
    if (!key) return json;
    const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
    const ct = nacl.secretbox(new Uint8Array(Buffer.from(json, "utf8")), nonce, key);
    return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

const machineKey = new Uint8Array(32).fill(7);
const MACHINE = "machine-107";

describe("deriveSpawnSpecKey matches the app's derivation", () => {
    it("equals deriveKey(machineKey, 'Joy Spawn Spec', [machineId]) byte for byte, per machine, and is not the tunnel key", () => {
        const daemon = deriveSpawnSpecKey(machineKey, MACHINE);
        expect(Buffer.from(daemon).toString("hex")).toBe(Buffer.from(appSpawnSpecKey(machineKey, MACHINE)).toString("hex"));
        expect(daemon.length).toBe(32);
        expect(Buffer.from(deriveSpawnSpecKey(machineKey, "other")).toString("hex")).toBe(Buffer.from(appSpawnSpecKey(machineKey, "other")).toString("hex"));
        expect(Buffer.from(deriveSpawnSpecKey(machineKey, "other")).toString("hex")).not.toBe(Buffer.from(daemon).toString("hex"));
        expect(Buffer.from(deriveTunnelKey(machineKey, MACHINE)).toString("hex")).not.toBe(Buffer.from(daemon).toString("hex"));
        // The tunnel leaf is still the app's 'Joy Tunnel' leaf (unchanged by the refactor).
        expect(Buffer.from(deriveTunnelKey(machineKey, MACHINE)).toString("hex")).toBe(Buffer.from(appDeriveKey(machineKey, "Joy Tunnel", [MACHINE])).toString("hex"));
    });
});

describe("decodeSpawnSpec", () => {
    const key = deriveSpawnSpecKey(machineKey, MACHINE);
    const spec = { cwd: "/home/u/proj", agent: "claude", model: "opus", extraArgs: "--flag" };

    it("opens the app's sealed envelope under the spawn-spec key and nothing of it is readable on the wire", () => {
        const wire = appEncodeSpawnSpec(spec, key);
        expect(isSealedSpawnSpec(wire)).toBe(true);
        expect(wire).not.toContain("/home/u/proj");
        expect(wire).not.toContain("--flag");
        expect(decodeSpawnSpec(wire, key)).toEqual({ v: 1, t: "spawn", ...spec });
    });

    it("still parses the plain-JSON form, with or without a key (old apps keep spawning)", () => {
        const wire = appEncodeSpawnSpec(spec, null);
        expect(isSealedSpawnSpec(wire)).toBe(false);
        expect(decodeSpawnSpec(wire, key)).toEqual({ v: 1, t: "spawn", ...spec });
        expect(decodeSpawnSpec(wire, null)).toEqual({ v: 1, t: "spawn", ...spec });
    });

    it("refuses a sealed spec under the wrong key, with no key, when tampered, or when the payload is not a spawn", () => {
        const wire = appEncodeSpawnSpec(spec, key);
        expect(decodeSpawnSpec(wire, deriveSpawnSpecKey(machineKey, "other-machine"))).toBeNull();
        expect(decodeSpawnSpec(wire, deriveTunnelKey(machineKey, MACHINE))).toBeNull();
        expect(decodeSpawnSpec(wire, null)).toBeNull();
        const raw = Buffer.from(wire.slice(5), "base64");
        raw[raw.length - 1] ^= 1;
        expect(decodeSpawnSpec("v2e1:" + raw.toString("base64"), key)).toBeNull();
        expect(decodeSpawnSpec("v2e1:AAAA", key)).toBeNull();
        const notSpawn = (() => {
            const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
            const ct = nacl.secretbox(new Uint8Array(Buffer.from(JSON.stringify({ v: 1, t: "plain", text: "hi" }), "utf8")), nonce, key);
            return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
        })();
        expect(decodeSpawnSpec(notSpawn, key)).toBeNull();
    });
});

// ── the lane, end to end against a fake relay ────────────────────────────────
function makeFakeRelay() {
    const calls: Array<{ path: string; body: any }> = [];
    let workOffers: any[] = [];
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
            if (path.endsWith("/claims/control")) return send({ offers: [] });
            if (path === "/sessions") return send({ sessions: [] });
            calls.push({ path, body });
            send({ ok: true });
        });
    });
    return {
        server, calls,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        pushWork: (o: any) => workOffers.push(o),
        failed: () => calls.filter(c => c.path.endsWith("/spawn-failed")),
        bound: () => calls.filter(c => c.path.endsWith("/bind")),
    };
}

const fakeSession = (id: string, cwd: string): any => ({
    id, cwd, status: "active", busy: () => false, queueState: () => ({ pendingCount: 0, paused: false }),
    enqueue: () => ({ id: "q" }), cancelQueued: () => true, abort: async () => ({ ok: true }),
});

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

function laneWith(url: string, created: any[], machineKeyOpt: Uint8Array | null = machineKey) {
    const registry: any = {
        get: () => undefined, create: async (spec: any) => { created.push(spec); return fakeSession("loc" + created.length, spec.cwd); },
        chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
    };
    return startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: MACHINE, machineKey: machineKeyOpt, log: () => {} });
}

describe("#107 sealed spawn specs over the relay", () => {
    it("a spec sealed by the app under this machine's spawn-spec key launches with its fields intact", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        handle = laneWith(url, created);
        const wire = appEncodeSpawnSpec({ cwd: "/tmp/sealed-proj", agent: "claude", model: "opus", extraArgs: "--flag" }, appSpawnSpecKey(machineKey, MACHINE));
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2sealed", kind: "spawn_session", ciphertext: wire });
        await until(() => relay.bound().length > 0);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ cwd: "/tmp/sealed-proj", agent: "claude", model: "opus", extraArgs: "--flag" });
        expect(relay.failed()).toEqual([]);
    }, 30_000);

    it("a plain-JSON spec (an app that predates the seal) still launches on a keyed daemon", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        handle = laneWith(url, created);
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2plain", kind: "spawn_session", ciphertext: appEncodeSpawnSpec({ cwd: "/tmp/plain-proj", agent: "claude" }, null) });
        await until(() => relay.bound().length > 0);
        expect(created).toHaveLength(1);
        expect(created[0]).toMatchObject({ cwd: "/tmp/plain-proj", agent: "claude" });
        expect(relay.failed()).toEqual([]);
    }, 30_000);

    it("a spec sealed under the WRONG key is a bad_spawn_spec spawn failure: reported once, never launched, not hot-retried", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        handle = laneWith(url, created);
        const wrong = appEncodeSpawnSpec({ cwd: "/tmp/wrong-key", agent: "claude" }, appSpawnSpecKey(new Uint8Array(32).fill(9), MACHINE));
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2wrong", kind: "spawn_session", ciphertext: wrong });
        await until(() => relay.failed().length > 0);
        await sleep(300); // let anything that would wrongly follow (create/bind) show up
        expect(relay.failed()).toHaveLength(1);
        expect(relay.failed()[0].body).toMatchObject({ deliveryId: "d1" });
        expect(String(relay.failed()[0].body.reason)).toMatch(/^bad_spawn_spec:/);
        expect(created).toEqual([]);
        expect(relay.bound()).toEqual([]);
        // abandoned, not hot-retried: a re-offer of the same command is ignored
        relay.pushWork({ deliveryId: "d1b", commandId: "c1", sessionId: "v2wrong", kind: "spawn_session", ciphertext: wrong });
        await sleep(1200);
        expect(relay.failed()).toHaveLength(1);
        expect(created).toEqual([]);
    }, 30_000);

    it("a sealed spec to a daemon with NO machine key is bad_spawn_spec too — it cannot vouch for it", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        handle = laneWith(url, created, null);
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2nokey", kind: "spawn_session", ciphertext: appEncodeSpawnSpec({ cwd: "/tmp/no-key" }, appSpawnSpecKey(machineKey, MACHINE)) });
        await until(() => relay.failed().length > 0);
        await sleep(300);
        expect(String(relay.failed()[0].body.reason)).toMatch(/^bad_spawn_spec:.*no machine key/);
        expect(created).toEqual([]);
        expect(relay.bound()).toEqual([]);
    }, 30_000);
});
