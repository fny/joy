import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStorage, nukeSessionStorage, type LedgerLike } from "./footprint";
import type { WindowRecord } from "./windowRecord";

let home: string, state: string, legacy: string;
const rec = (id: string, v2: string | null, updatedAt: number, extra: Record<string, unknown> = {}): WindowRecord =>
  ({ id, v2SessionId: v2 ?? undefined, launchCwd: `/w/${id}`, updatedAt, ...extra } as unknown as WindowRecord);
const write = (p: string, bytes: number, mtimeMs: number) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, "x".repeat(bytes));
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
};
const fakeLedger = (rows: Record<string, number>): LedgerLike & { forgotten: string[] } => ({
  forgotten: [],
  sessionRowCount: (id) => rows[id] ?? 0,
  forgetSession(id) { this.forgotten.push(id); },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "joy-fp-"));
  state = join(home, "relays", "r_1", "state");
  legacy = join(home, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(legacy, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("scanStorage", () => {
  it("attributes media, record, queue, receipts and ledger rows to a session, with size and age", () => {
    const t0 = Date.now() - 10 * 86_400_000, t1 = Date.now() - 3_600_000;
    write(join(home, "sessions", "aaaaaaaa", "media", "shot.png"), 5000, t0);
    write(join(state, "window-aaaaaaaa.json"), 300, t1);
    write(join(state, "queue-st-aaaaaaaa.json"), 40, t1);
    write(join(state, "v2AAA.receipts.json"), 900, t1);
    const ledger = fakeLedger({ aaaaaaaa: 17 });
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("aaaaaaaa", "v2AAA", t1)], live: [], ledger });
    expect(r.sessions).toHaveLength(1);
    const s = r.sessions[0];
    expect(s).toMatchObject({ id: "aaaaaaaa", v2SessionId: "v2AAA", cwd: "/w/aaaaaaaa", live: false, bytes: 6240, files: 4, ledgerRows: 17 });
    expect(s.parts).toEqual(["media 1", "record", "queue", "receipts", "ledger 17"]);
    expect(Math.abs((s.oldestAt ?? 0) - t0)).toBeLessThan(2000);
    expect(Math.abs((s.newestAt ?? 0) - t1)).toBeLessThan(2000);
    expect(r.shared.orphanFiles).toBe(0);
    expect(r.totalBytes).toBe(6240);
  });

  it("reports a media dir with no record — the old kill never removed it — as its own session", () => {
    write(join(home, "sessions", "bbbbbbbb", "media", "a.png"), 1000, Date.now());
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null });
    expect(r.sessions.map((s) => s.id)).toEqual(["bbbbbbbb"]);
    expect(r.sessions[0].parts).toEqual(["media 1"]);
  });

  it("marks a session the registry holds as live and prefers its cwd and title", () => {
    write(join(state, "window-cccccccc.json"), 10, Date.now());
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("cccccccc", null, 1)], live: [{ id: "cccccccc", status: "active", cwd: "/live", title: "Doing things" }], ledger: null });
    expect(r.sessions[0]).toMatchObject({ live: true, status: "active", cwd: "/live", title: "Doing things" });
  });

  it("counts the ledger file, usage cache and v1 import as shared, and unclaimed state files as orphans", () => {
    write(join(state, "ledger.sqlite"), 5000, 1);
    write(join(state, "ledger.sqlite-wal"), 500, 1);
    write(join(state, "usage-cache.json"), 700, 1);
    write(join(state, "imported-v1", "x.receipts.json"), 300, 1);
    write(join(state, "deadbeef00.receipts.json"), 120, 1);   // v2 id nobody names
    write(join(legacy, "old.queue.json"), 30, 1);              // legacy layout, v1 id
    write(join(state, "settings.json"), 999, 1);               // the daemon's own: not counted
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null });
    expect(r.shared).toEqual({ ledgerBytes: 5500, usageCacheBytes: 700, importedBytes: 300, orphanBytes: 150, orphanFiles: 2 });
    expect(r.totalBytes).toBe(5500 + 700 + 300 + 150);
  });

  it("sorts biggest first", () => {
    write(join(home, "sessions", "11111111", "media", "a"), 10, 1);
    write(join(home, "sessions", "22222222", "media", "a"), 9000, 1);
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null });
    expect(r.sessions.map((s) => s.id)).toEqual(["22222222", "11111111"]);
  });
});

describe("nukeSessionStorage", () => {
  it("removes exactly the attributed pieces and forgets the ledger rows; the neighbour is untouched", () => {
    const now = Date.now();
    write(join(home, "sessions", "aaaaaaaa", "media", "shot.png"), 5000, now);
    write(join(state, "window-aaaaaaaa.json"), 300, now);
    write(join(state, "queue-st-aaaaaaaa.json"), 40, now);
    write(join(state, "v2AAA.receipts.json"), 900, now);
    write(join(state, "window-bbbbbbbb.json"), 300, now);
    write(join(state, "ledger.sqlite"), 5000, now);
    const ledger = fakeLedger({});
    const r = nukeSessionStorage("aaaaaaaa", { homeDir: home, stateDir: state, records: [rec("aaaaaaaa", "v2AAA", now), rec("bbbbbbbb", null, now)], ledger });
    expect(r).toMatchObject({ id: "aaaaaaaa", ok: true, bytesFreed: 6240 });
    expect(r.removed).toEqual(["media", "queue", "receipts", "record", "ledger"]);
    expect(ledger.forgotten).toEqual(["aaaaaaaa"]);
    for (const gone of ["sessions/aaaaaaaa", "relays/r_1/state/window-aaaaaaaa.json", "relays/r_1/state/queue-st-aaaaaaaa.json", "relays/r_1/state/v2AAA.receipts.json"]) {
      expect(existsSync(join(home, gone)), gone).toBe(false);
    }
    expect(existsSync(join(state, "window-bbbbbbbb.json"))).toBe(true);
    expect(existsSync(join(state, "ledger.sqlite"))).toBe(true);
  });

  it("is a no-op that still forgets ledger rows for an id with nothing on disk", () => {
    const ledger = fakeLedger({});
    const r = nukeSessionStorage("eeeeeeee", { homeDir: home, stateDir: state, records: [], ledger });
    expect(r).toMatchObject({ ok: true, bytesFreed: 0, removed: ["ledger"] });
  });
});
