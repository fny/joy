import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStorage, nukeSessionStorage, scanTmux, killTmuxServer, type LedgerLike, type TmuxRunner } from "./footprint";
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
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("aaaaaaaa", "v2AAA", t1)], live: [], ledger, tmux: null });
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
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null, tmux: null });
    expect(r.sessions.map((s) => s.id)).toEqual(["bbbbbbbb"]);
    expect(r.sessions[0].parts).toEqual(["media 1"]);
  });

  it("marks a session the registry holds as live and prefers its cwd and title", () => {
    write(join(state, "window-cccccccc.json"), 10, Date.now());
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("cccccccc", null, 1)], live: [{ id: "cccccccc", status: "active", cwd: "/live", title: "Doing things" }], ledger: null, tmux: null });
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
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null, tmux: null });
    expect(r.shared).toEqual({ ledgerBytes: 5500, usageCacheBytes: 700, importedBytes: 300, orphanBytes: 150, orphanFiles: 2 });
    expect(r.totalBytes).toBe(5500 + 700 + 300 + 150);
  });

  it("sorts biggest first", () => {
    write(join(home, "sessions", "11111111", "media", "a"), 10, 1);
    write(join(home, "sessions", "22222222", "media", "a"), 9000, 1);
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [], live: [], ledger: null, tmux: null });
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
    const r = nukeSessionStorage("aaaaaaaa", { homeDir: home, stateDir: state, records: [rec("aaaaaaaa", "v2AAA", now), rec("bbbbbbbb", null, now)], ledger, tmux: null });
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
    const r = nukeSessionStorage("eeeeeeee", { homeDir: home, stateDir: state, records: [], ledger, tmux: null });
    expect(r).toMatchObject({ ok: true, bytesFreed: 0, removed: ["ledger"] });
  });
});

/** A fake tmux: servers by label, each with sessions and panes; records calls. */
function fakeTmux(servers: Record<string, { created: number; activity: number; windows: number; panes: Array<[number, string, string]> }>): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = (args) => {
    calls.push(args);
    const label = args[1];
    const srv = servers[label];
    const cmd = args[2];
    if (!srv) return { ok: false, out: "", err: `no server running on /tmp/tmux-1/${label}` };
    if (cmd === "list-sessions") return { ok: true, out: `${srv.created}\t${srv.activity}\t${srv.windows}\n`, err: "" };
    if (cmd === "list-panes") return { ok: true, out: srv.panes.map(([pid, c, t]) => `${pid}\t${c}\t${t}`).join("\n") + "\n", err: "" };
    if (cmd === "kill-server") { delete servers[label]; return { ok: true, out: "", err: "" }; }
    return { ok: false, out: "", err: "unknown" };
  };
  return Object.assign(run, { calls });
}

describe("session kinds and tmux", () => {
  let sockets: string;
  beforeEach(() => { sockets = join(home, "tmux-sockets"); mkdirSync(sockets, { recursive: true }); });

  it("classifies running, detached and record-only sessions", () => {
    write(join(state, "window-aaaaaaaa.json"), 1, 1);
    write(join(state, "window-bbbbbbbb.json"), 1, 1);
    write(join(state, "window-cccccccc.json"), 1, 1);
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("aaaaaaaa", null, 1), rec("bbbbbbbb", null, 1), rec("cccccccc", null, 1)],
      live: [{ id: "aaaaaaaa", status: "active", cwd: "/a" }, { id: "bbbbbbbb", status: "ended", cwd: "/b" }], ledger: null, tmux: null });
    const kinds = Object.fromEntries(r.sessions.map((s) => [s.id, s.kind]));
    expect(kinds).toEqual({ aaaaaaaa: "running", bbbbbbbb: "detached", cccccccc: "record" });
  });

  it("attaches a known session's live server to its row and lists the rest as loose, stale sockets last", () => {
    for (const l of ["joy-aaaaaaaa", "joy-dddddddd", "joy-eeeeeeee", "joy-r1-s-ffffffff", "default"]) writeFileSync(join(sockets, l), "");
    const tmux = fakeTmux({
      "joy-aaaaaaaa": { created: 1_000, activity: 2_000, windows: 1, panes: [[4242, "claude", "agent"]] },
      "joy-dddddddd": { created: 3_000, activity: 9_000, windows: 2, panes: [[1, "node", "x"], [2, "bash", "y"]] },
      "joy-r1-s-ffffffff": { created: 500, activity: 600, windows: 1, panes: [[7, "claude", "old"]] },
      // joy-eeeeeeee: socket file only — no server answers
    });
    write(join(state, "window-aaaaaaaa.json"), 1, 1);
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("aaaaaaaa", null, 1)], live: [], ledger: null,
      tmux, tmuxSocketDir: sockets, relayKey: "r1" });
    expect(r.sessions[0].tmux).toMatchObject({ label: "joy-aaaaaaaa", alive: true, windows: 1, createdAt: 1_000_000, activityAt: 2_000_000 });
    expect(r.sessions[0].tmux!.panes).toEqual([{ pid: 4242, command: "claude", title: "agent" }]);
    expect(r.sessions[0].parts).toContain("tmux 1 pane");
    // tmux activity counts toward the row's age.
    expect(r.sessions[0].newestAt).toBe(2_000_000);
    expect(r.looseTmux.map((l) => [l.label, l.alive, l.sessionId])).toEqual([
      ["joy-dddddddd", true, "dddddddd"],
      ["joy-r1-s-ffffffff", true, "ffffffff"],
      ["joy-eeeeeeee", false, "eeeeeeee"],
    ]);
    expect(r.looseTmux[0].panes.map((p) => p.command)).toEqual(["node", "bash"]);
    expect(r.looseTmux[2].socketPath).toBe(join(sockets, "joy-eeeeeeee"));
  });

  it("a record-only session with a live server reads as such, and its nuke kills the server first", () => {
    writeFileSync(join(sockets, "joy-cccccccc"), "");
    const tmux = fakeTmux({ "joy-cccccccc": { created: 1, activity: 2, windows: 1, panes: [[9, "claude", "agent"]] } });
    write(join(state, "window-cccccccc.json"), 10, 1);
    const r = scanStorage({ homeDir: home, stateDir: state, legacyStateDir: legacy, records: [rec("cccccccc", null, 1)], live: [], ledger: null, tmux, tmuxSocketDir: sockets, relayKey: "r1" });
    expect(r.sessions[0]).toMatchObject({ kind: "record", tmux: { alive: true } });
    const n = nukeSessionStorage("cccccccc", { homeDir: home, stateDir: state, records: [rec("cccccccc", null, 1)], ledger: null, tmux, tmuxSocketDir: sockets, relayKey: "r1" });
    expect(n.ok).toBe(true);
    expect(n.removed).toEqual(["tmux", "record"]);
    expect(tmux.calls.some((c) => c[1] === "joy-cccccccc" && c[2] === "kill-server")).toBe(true);
    expect(existsSync(join(sockets, "joy-cccccccc"))).toBe(false);
  });

  it("killTmuxServer unlinks a stale socket without a kill, and reports a server it could not kill", () => {
    writeFileSync(join(sockets, "joy-11111111"), "");
    const tmux = fakeTmux({});
    expect(killTmuxServer("joy-11111111", { socketDir: sockets, tmux })).toEqual({ label: "joy-11111111", killed: false, unlinked: true });
    expect(tmux.calls.some((c) => c[2] === "kill-server")).toBe(false);
    const stubborn: TmuxRunner = (args) => args[2] === "kill-server" ? { ok: false, out: "", err: "permission denied" } : { ok: true, out: "1\t1\t1\n", err: "" };
    expect(killTmuxServer("joy-22222222", { socketDir: sockets, tmux: stubborn })).toMatchObject({ killed: false, error: "kill-server: permission denied" });
  });

  it("scanTmux ignores sockets that are not joy's", () => {
    writeFileSync(join(sockets, "default"), "");
    const r = scanTmux({ socketDir: sockets, relayKey: "r1", known: new Set(), tmux: fakeTmux({}) });
    expect(r.loose).toEqual([]);
  });
});
