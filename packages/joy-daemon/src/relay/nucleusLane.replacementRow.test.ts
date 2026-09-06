// #120 residual (Astra on b2aa492d): a session killed while its announce was
// in flight leaves a replacement row on the relay that only THIS daemon can
// archive. The archive used to be one attempt — a transient failure dropped
// the intent, and reconcileOrphans skipped the row because the registry still
// held the killed handle — so the row stayed `starting` forever. Now the
// intent is a ledger job retried with backoff, run again by every boot pass,
// and a killed handle no longer shields its row from the orphan sweep.
import { it, expect, afterEach } from "vitest";
import * as http from "node:http";
import { startNucleusLane, type NucleusLaneHandle } from "./nucleusLane";
import { ledgerFor } from "../domain/ledger";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
process.env.JOY_HOME_DIR = mkdtempSync(joinPath(tmpdir(), "joy-lane-replacement-row-test-"));

const ARCHIVE_JOB_KIND = "archive_relay_row";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) { if (Date.now() > deadline) throw new Error("timeout waiting"); await sleep(50); }
}

/** Scripted relay: method-aware answer overrides (`answers` key = "METHOD path"), records every call. */
function makeFakeRelay(rows: any[]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const answers = new Map<string, { status: number; body: unknown } | ((body: any) => { status: number; body: unknown })>();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url!.replace(/^\/joy\/v2/, "");
      const method = req.method!;
      const send = (obj: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const a = answers.get(`${method} ${path}`);
      if (a) { calls.push({ method, path, body }); const r = typeof a === "function" ? a(body) : a; return send(r.body, r.status); }
      if (path === "/daemon/leases") return send({ leaseId: "L1", leaseToken: "T1", epoch: 1 });
      if (/^\/daemon\/leases\/[^/]+$/.test(path) && method === "PUT") return send({ ok: true });
      if (path.endsWith("/claims/work")) return send({ offers: [] });
      if (path.endsWith("/claims/control")) return send({ offers: [] });
      if (path === "/sessions" && method === "GET") return send({ sessions: rows });
      calls.push({ method, path, body });
      send({ ok: true });
    });
  });
  return {
    server, calls, answers,
    listen: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as any).port}`))),
    count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length,
  };
}

/** A live session whose announce POST kills it (the reviewer's reproduction):
 *  the relay row "ghost" is created for a session that is already gone. */
function scenario(opts: { patchStatus: () => number }) {
  const rows: any[] = [];
  const relay = makeFakeRelay(rows);
  const session: any = { id: "killed", status: "active", cwd: "/tmp/x", cardMetadata: () => (session.status === "ended" ? null : { joy__state: "running" }) };
  let records: any[] = [{ id: "killed", v2SessionId: "deleted", socket: null }];
  let announce!: (s: any) => Promise<void>;
  let saves = 0;
  const logs: string[] = [];
  const registry: any = {
    get: (id: string) => (id === "killed" ? session : undefined),
    list: () => (session.status === "ended" ? [] : [session]),
    listRecords: () => records, chatHistory: () => [],
    saveRecord: () => { saves++; },
    setAnnouncer: (f: any) => { announce = f; },
  };
  relay.answers.set("GET /sessions/deleted", { status: 404, body: { error: "session_not_found" } });
  relay.answers.set("POST /sessions", () => {
    session.status = "ended"; session.endReason = "killed"; records = [];
    rows.push({ sessionId: "ghost", daemonId: "m", localSessionId: "killed", state: "starting" });
    return { status: 200, body: { sessionId: "ghost" } };
  });
  relay.answers.set("PATCH /daemon/sessions/ghost", (body) => {
    const status = opts.patchStatus();
    if (status === 200) { const row = rows.find((r) => r.sessionId === "ghost"); if (row) row.state = body.state; return { status, body: { ok: true } }; }
    return { status, body: { error: status === 404 ? "session_not_found" : "temporarily_unavailable" } };
  });
  return { rows, relay, session, records: () => records, announce: () => announce, saves: () => saves, logs, registry };
}

let handle: NucleusLaneHandle | null = null;
let srv: http.Server | null = null;
afterEach(async () => { await handle?.stop(); handle = null; srv?.close(); srv = null; });
const jobs = () => ledgerFor().listJobs(ARCHIVE_JOB_KIND);

it("a failed archive of the replacement row is persisted and retried with backoff until the relay takes it", async () => {
  let patch = 503;
  const sc = scenario({ patchStatus: () => patch });
  srv = sc.relay.server;
  const url = await sc.relay.listen();
  handle = startNucleusLane({ registry: sc.registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => sc.logs.push(l) });
  await until(() => !!handle?.currentLease());
  await sleep(100);
  await sc.announce()(sc.session);
  // One attempt so far, the intent is on disk, the dead identity was NOT rebound.
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(1);
  expect(sc.logs.some((l) => l.includes("archive ghost failed (attempt 1, will retry)"))).toBe(true);
  expect(jobs().map((j) => j.id)).toEqual(["archive:ghost"]);
  expect(sc.saves()).toBe(0);
  expect(sc.records()).toEqual([]);
  // Connectivity recovers: the lane's own retry lands the archive (2s backoff).
  patch = 200;
  await until(() => sc.rows[0]?.state === "archived", 6_000);
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(2);
  expect(jobs()).toEqual([]);
  expect(sc.logs.some((l) => l.includes("archived replacement row ghost"))).toBe(true);
  expect(sc.records()).toEqual([]);
}, 15_000);

it("the intent survives a lane restart: the boot pass archives the row even though the killed handle is still registered", async () => {
  let patch = 503;
  const sc = scenario({ patchStatus: () => patch });
  srv = sc.relay.server;
  const url = await sc.relay.listen();
  handle = startNucleusLane({ registry: sc.registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => sc.logs.push(l) });
  await until(() => !!handle?.currentLease());
  await sleep(100);
  await sc.announce()(sc.session);
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(1);
  await handle.stop();
  expect(jobs().map((j) => j.id)).toEqual(["archive:ghost"]);
  // A new lane generation, the relay healthy again: the row is archived by the
  // boot pass — no waiting for a backoff tick, no live session involved.
  patch = 200;
  handle = startNucleusLane({ registry: sc.registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => sc.logs.push(l) });
  await until(() => sc.rows[0]?.state === "archived", 5_000);
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(2);
  expect(jobs()).toEqual([]);
  expect(sc.records()).toEqual([]);
  expect(sc.saves()).toBe(0);
}, 15_000);

it("a row the relay no longer has settles the intent instead of retrying forever", async () => {
  const sc = scenario({ patchStatus: () => 404 });
  srv = sc.relay.server;
  const url = await sc.relay.listen();
  handle = startNucleusLane({ registry: sc.registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => sc.logs.push(l) });
  await until(() => !!handle?.currentLease());
  await sleep(100);
  await sc.announce()(sc.session);
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(1);
  expect(jobs()).toEqual([]);
  expect(sc.logs.some((l) => l.includes("archive ghost: row already gone or settled"))).toBe(true);
  await sleep(2_500);
  expect(sc.relay.count("PATCH", "/daemon/sessions/ghost")).toBe(1); // no retry scheduled
}, 15_000);

it("reconcileOrphans archives a row whose local handle is a KILLED one (no persisted intent at all)", async () => {
  // No job on disk (an older daemon's one-shot failure, or the ledger write
  // itself failed): the sweep alone must catch it. The registry answers get()
  // with the killed handle — what used to make the sweep skip the row.
  const rows: any[] = [{ sessionId: "ghost2", daemonId: "m", localSessionId: "killed2", state: "starting" }];
  const relay = makeFakeRelay(rows);
  srv = relay.server;
  const url = await relay.listen();
  const killed: any = { id: "killed2", status: "ended", endReason: "killed", cwd: "/tmp/proj", cardMetadata: () => null };
  const registry: any = { get: (id: string) => (id === "killed2" ? killed : undefined), list: () => [], listRecords: () => [], chatHistory: () => [], saveRecord: () => {} };
  relay.answers.set("PATCH /daemon/sessions/ghost2", (body) => { rows[0].state = body.state; return { status: 200, body: { ok: true } }; });
  const logs: string[] = [];
  handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => logs.push(l) });
  await until(() => rows[0].state === "archived", 5_000);
  expect(relay.count("PATCH", "/daemon/sessions/ghost2")).toBe(1);
  expect(logs.some((l) => l.includes("reconcile: archived orphan ghost2"))).toBe(true);
  // A live (or merely ended, non-killed) handle is still left to its own publisher.
  rows.push({ sessionId: "live1", daemonId: "m", localSessionId: "live1", state: "active" });
  const live: any = { id: "live1", status: "active", cwd: "/tmp/p", cardMetadata: () => ({ joy__state: "running" }) };
  registry.get = (id: string) => (id === "killed2" ? killed : id === "live1" ? live : undefined);
  await handle.stop();
  handle = startNucleusLane({ registry, relayUrl: url, token: "tok", machineId: "m", log: (l) => logs.push(l) });
  await until(() => !!handle?.currentLease());
  await sleep(500);
  // The bind's own card publish is fine; the sweep never archives it.
  expect(relay.calls.filter((c) => c.path === "/daemon/sessions/live1" && c.body?.state === "archived")).toEqual([]);
  expect(relay.calls.filter((c) => c.path === "/daemon/sessions/live1").every((c) => c.body?.state !== "archived")).toBe(true);
}, 15_000);
