// Local-only sessions never touch the relay (domain/localOnly.ts): the lane
// does not announce them, and their records go to the local event log instead
// of the outbox. A normal session in the same lane is the control — it IS
// announced in the same window, so the test would catch the guard going away.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCoordinatedSession } from "../domain/coordinator.fakeDriver";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { RelaySession, encodeTextEvent } from "./relay";
import { ledgerFor } from "../domain/ledger";
import { markLocalOnly, _resetLocalOnly } from "../domain/localOnly";
import { pageLocalRecords, _resetLocalLog } from "../domain/localLog";

const freshHome = () => { process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-localonly-test-")); };
freshHome();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const adapterFor = (localId: string) => new RelaySession({ client: { creds: { machineId: "m" } } as any, relaySessionId: localId, metadata: {} });

function makeFakeRelay() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "").split("?")[0];
      const send = (obj: any, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      calls.push({ method: req.method!, path, body });
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && req.method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work") || path.endsWith("/claims/control")) return send({ offers: [] });
      if (path === "/sessions" && req.method === "GET") return send({ sessions: [] });
      send({ ok: true });
    });
  });
  return {
    server, calls,
    listen: () => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    announcesFor: (localId: string) => calls.filter(c => c.method === "POST" && c.path === "/sessions" && c.body?.localSessionId === localId),
  };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; _resetLocalOnly(); _resetLocalLog(); freshHome(); });

describe("local-only sessions stay off the relay", () => {
  it("is never announced (a normal session in the same lane is), and its records land in the local log, not the outbox", async () => {
    const relay = makeFakeRelay();
    const url = await relay.listen(); srv = relay.server;
    const local = fakeCoordinatedSession("loc", { agent: "claude", cwd: "/tmp" }).s as any;
    const normal = fakeCoordinatedSession("nrm", { agent: "claude", cwd: "/tmp" }).s as any;
    markLocalOnly("loc");
    const registry: any = {
      get: (i: string) => (i === "loc" ? local : i === "nrm" ? normal : undefined),
      list: () => [local, normal], create: async () => local, chatHistory: () => [],
      listRecords: () => [{ id: "loc", socket: null }, { id: "nrm", socket: null }], saveRecord: () => {},
    };
    handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m1", log: () => {} });

    adapterFor("loc").send(encodeTextEvent("private answer", { turn: "t" }), "loc:text:1");
    await sleep(9_500); // past one 8s sweep tick, which announces unbound live sessions

    expect(relay.announcesFor("nrm").length).toBeGreaterThan(0); // the control
    expect(relay.announcesFor("loc")).toEqual([]);
    expect(relay.calls.some(c => JSON.stringify(c.body).includes("private answer"))).toBe(false);
    expect(ledgerFor().pendingOutbound("loc")).toEqual([]);
    const logged = pageLocalRecords("loc", {});
    expect(logged).toHaveLength(1);
    expect(logged[0].seq).toBe(1);
    expect((logged[0].record as any)?.content?.data?.ev?.text).toBe("private answer");
  }, 20_000);
});
