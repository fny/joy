// How fast the lane gets back to work after its link to the relay breaks.
// 2026-10-13: a flaky route (a Tailscale exit node) made renews time out now
// and then. The lane forgot its lease on the first failed renew, a claim
// long-polling through the dead link held its lane for minutes, and every
// failure waited 60 s — prompts sat queued for minutes at a time. These run
// at real cadence (the renew loop ticks every 8 s) against a scripted relay.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
// The lane persists its spool under joyStateDir(): keep it off the live daemon's.
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-recovery-"));

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error("timeout waiting"); await sleep(25); }
}

interface Hit { at: number; method: string; path: string }
/** A relay whose answers to renews and claims the test scripts per lease. */
function makeRelay(script: {
    /** Answer to the n-th renew (0-based): a status + error code, or "ok". */
    renew?: (n: number) => "ok" | { status: number; error: string };
    /** True = a claim under this lease never answers (a dead connection). */
    claimHangs?: (leaseId: string) => boolean;
}) {
    const hits: Hit[] = [];
    let leases = 0;
    let renews = 0;
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
            const path = req.url!.replace(/^\/joy\/v2/, "");
            hits.push({ at: Date.now(), method: req.method!, path });
            const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
            if (path === "/daemon/leases") { leases += 1; return send({ leaseId: `L${leases}`, leaseToken: `T${leases}`, epoch: leases }); }
            if (/^\/daemon\/leases\/[^/]+$/.test(path) && req.method === "PUT") {
                const a = script.renew?.(renews++) ?? "ok";
                return a === "ok" ? send({ epoch: String(leases) }) : send({ error: a.error }, a.status);
            }
            const claim = /^\/daemon\/leases\/([^/]+)\/claims\//.exec(path);
            if (claim) {
                if (script.claimHangs?.(claim[1])) return; // never answered
                return setTimeout(() => send({ offers: [] }), 200);
            }
            if (path === "/sessions") return send({ sessions: [] });
            send({ ok: true });
        });
    });
    return {
        server,
        hits,
        listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
        acquires: () => hits.filter(h => h.path === "/daemon/leases"),
        renewHits: () => hits.filter(h => h.method === "PUT"),
        claimsUnder: (leaseId: string) => hits.filter(h => h.path.startsWith(`/daemon/leases/${leaseId}/claims/work`)),
    };
}

const registry: any = {
    get: () => undefined,
    create: async () => undefined,
    chatHistory: () => [],
    listRecords: () => [],
    saveRecord: () => {},
};

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => {
    await handle?.stop(); handle = null;
    srv?.closeAllConnections(); srv?.close(); srv = null;
});

describe("nucleusLane recovery", () => {
    it("a renew that fails inside the TTL is retried and the lease kept", async () => {
        const relay = makeRelay({ renew: (n) => (n === 0 ? { status: 502, error: "bad_gateway" } : "ok") });
        const url = await relay.listen(); srv = relay.server;
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "r1", log: () => {} });
        await until(() => relay.renewHits().length >= 2, 12_000);
        const [failed, retried] = relay.renewHits();
        // Retried about a second later, not at the next 8 s tick…
        expect(retried.at - failed.at).toBeLessThan(2_500);
        // …and the lease was never given up: one acquire, claims still under L1.
        await sleep(500);
        expect(relay.acquires().length).toBe(1);
        expect(relay.claimsUnder("L1").some(h => h.at > retried.at)).toBe(true);
    }, 20_000);

    it("a lease the relay calls expired ends the claim stuck under it and is re-acquired within seconds", async () => {
        // L1's claims hang (the dead connection); its first renew is answered
        // 412 lease_expired. The lane must drop the stuck claim at once and
        // claim again under a new lease — it used to wait out the claim, then
        // 10–20 s more.
        const relay = makeRelay({
            renew: (n) => (n === 0 ? { status: 412, error: "lease_expired" } : "ok"),
            claimHangs: (leaseId) => leaseId === "L1",
        });
        const url = await relay.listen(); srv = relay.server;
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "r2", log: () => {} });
        await until(() => relay.claimsUnder("L2").length > 0, 15_000);
        const expiredAt = relay.renewHits()[0].at;
        const reacquiredAt = relay.acquires()[1].at;
        expect(reacquiredAt - expiredAt).toBeLessThan(2_000);
        expect(relay.claimsUnder("L2")[0].at - expiredAt).toBeLessThan(3_000);
    }, 20_000);

    it("renews that keep failing past the TTL drop the lease, and the lane re-acquires as soon as the relay answers", async () => {
        // Every renew of L1 times out from the lane's side (502s here, the
        // same to the machine): the lease lapses 20 s after it was acquired,
        // the claim stuck under it is dropped, and L2 follows promptly.
        const relay = makeRelay({
            renew: (n) => (n < 100 ? { status: 502, error: "bad_gateway" } : "ok"),
            claimHangs: (leaseId) => leaseId === "L1",
        });
        const url = await relay.listen(); srv = relay.server;
        handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "r3", log: () => {} });
        await until(() => relay.claimsUnder("L2").length > 0, 30_000);
        const [first, second] = relay.acquires();
        expect(second.at - first.at).toBeGreaterThanOrEqual(19_500); // held through the failures…
        expect(second.at - first.at).toBeLessThan(23_000);            // …and not a moment much past the TTL
    }, 35_000);
});
