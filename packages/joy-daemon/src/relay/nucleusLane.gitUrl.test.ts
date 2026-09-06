// A relay spawn with a gitUrl clones BEFORE the agent launches, exactly like
// the `create` op does (#151): the app's "new session from a repository URL"
// used to bind an agent in an empty directory. A clone that fails is reported
// as a spawn failure and nothing is launched.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";

process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-giturl-test-"));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Poll for `cond` — under a loaded full-suite run the lane's first claim and
 *  git's refusal take longer than any fixed sleep we would want to pick. */
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond() && Date.now() < deadline) await sleep(100);
}

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
    };
}

const fakeSession = (id: string): any => ({
    id, status: "active", busy: () => false, queueState: () => ({ pendingCount: 0, paused: false }),
    enqueue: () => ({ id: "q" }), cancelQueued: () => true, abort: async () => ({ ok: true }),
});

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });

describe("#151 gitUrl spawns over the relay", () => {
    it("an unreachable repository is a clone_failed spawn failure: nothing launched, no directory left", async () => {
        const cwd = join(mkdtempSync(join(tmpdir(), "joy-clone-")), "repo");
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        const registry: any = {
            get: () => undefined, create: async (spec: any) => { created.push(spec); return fakeSession("x"); },
            chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mg", log: () => {} });
        // Port 1 on loopback: connection refused, so git fails at once.
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2g", kind: "spawn_session", ciphertext: JSON.stringify({ v: 1, t: "spawn", cwd, agent: "claude", gitUrl: "https://127.0.0.1:1/nobody/repo.git" }) });
        await until(() => relay.calls.some(c => c.path.endsWith("/spawn-failed")));
        await sleep(300); // let anything that would wrongly follow (create/bind) show up
        const failed = relay.calls.filter(c => c.path.endsWith("/spawn-failed"));
        expect(failed.length).toBe(1);
        expect(String(failed[0].body.reason)).toMatch(/^clone_failed:git clone failed/);
        expect(created).toEqual([]);           // the agent was never launched
        expect(existsSync(cwd)).toBe(false);   // and no half-made working copy remains
        expect(relay.calls.some(c => c.path.endsWith("/bind"))).toBe(false);
        // the command is abandoned, not hot-retried: a re-offer is ignored
        relay.pushWork({ deliveryId: "d1b", commandId: "c1", sessionId: "v2g", kind: "spawn_session", ciphertext: JSON.stringify({ v: 1, t: "spawn", cwd, gitUrl: "https://127.0.0.1:1/nobody/repo.git" }) });
        await sleep(1500);
        expect(relay.calls.filter(c => c.path.endsWith("/spawn-failed")).length).toBe(1);
    }, 30_000);

    it("a malformed gitUrl is a clone_failed spawn failure, never a launch", async () => {
        const relay = makeFakeRelay();
        const url = await relay.listen(); srv = relay.server;
        const created: any[] = [];
        const registry: any = {
            get: () => undefined, create: async (spec: any) => { created.push(spec); return fakeSession("x"); },
            chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
        };
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mg2", log: () => {} });
        relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2bad", kind: "spawn_session", ciphertext: JSON.stringify({ v: 1, t: "spawn", cwd: "/tmp/never", gitUrl: "ftp://nope" }) });
        await until(() => relay.calls.some(c => c.path.endsWith("/spawn-failed")));
        await sleep(300);
        const failed = relay.calls.find(c => c.path.endsWith("/spawn-failed"));
        expect(failed?.body.reason).toBe("clone_failed:invalid git url");
        expect(created).toEqual([]);
        expect(relay.calls.some(c => c.path.endsWith("/bind"))).toBe(false);
    }, 30_000);
});
