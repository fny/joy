// A relay spawn with a gitUrl clones BEFORE the agent launches, exactly like
// the `create` op does (#151): the app's "new session from a repository URL"
// used to bind an agent in an empty directory. A clone that fails is reported
// as a spawn failure and nothing is launched.
import { describe, it, expect, afterEach, vi } from "vitest";
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
    abort: async () => ({ ok: true }),
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

    it("#549 residual: a `~/…` spawn cwd is canonicalised ONCE — the clone lands in the home path and the agent launches THERE", async () => {
        const { homedir } = await import("node:os");
        const { realpathSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
        const { execFileSync } = await import("node:child_process");
        const { randomBytes } = await import("node:crypto");
        const { canonicalCwd } = await import("../paths");
        // A local origin reached through git's url.<base>.insteadOf rewrite (the URL regex refuses bare paths).
        const root = mkdtempSync(join(tmpdir(), "joy-giturl-549-"));
        const origin = join(root, "origin"); mkdirSync(origin);
        const git = (...a: string[]) => execFileSync("git", a, { cwd: origin, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
        git("init", "-q"); writeFileSync(join(origin, "README"), "local origin\n"); git("add", "."); git("commit", "-qm", "seed");
        const envKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
        const saved = envKeys.map((k) => [k, process.env[k]] as const);
        Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://local.test/origin" });
        const raw = `~/joy-giturl-549-${randomBytes(4).toString("hex")}`;
        const expected = join(realpathSync.native(homedir()), raw.slice(2));
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
        try {
            const relay = makeFakeRelay();
            const url = await relay.listen(); srv = relay.server;
            const created: any[] = [];
            const registry: any = {
                get: () => undefined, create: async (spec: any) => { created.push(spec); return fakeSession("x"); },
                chatHistory: () => [], listRecords: () => [], saveRecord: () => {},
            };
            handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "mg3", log: () => {} });
            relay.pushWork({ deliveryId: "d1", commandId: "c1", sessionId: "v2tilde", kind: "spawn_session", ciphertext: JSON.stringify({ v: 1, t: "spawn", cwd: raw, agent: "claude", gitUrl: "https://local.test/origin" }) });
            await until(() => created.length > 0 || relay.calls.some(c => c.path.endsWith("/spawn-failed")));
            expect(relay.calls.filter(c => c.path.endsWith("/spawn-failed"))).toEqual([]);
            expect(created).toHaveLength(1);
            expect(created[0].cwd).toBe(expected);                       // the path create() launches in …
            expect(created[0].cwd).toBe(canonicalCwd(raw));
            expect(existsSync(join(expected, ".git"))).toBe(true);       // … is where the checkout is
            expect(existsSync(join(root, "~"))).toBe(false);             // old code: `<daemon cwd>/~/joy-giturl-…`
        } finally {
            cwdSpy.mockRestore();
            for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
            rmSync(expected, { recursive: true, force: true });
            rmSync(root, { recursive: true, force: true });
        }
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
