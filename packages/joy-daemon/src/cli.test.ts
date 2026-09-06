// CLI helpers that decide WHAT to launch and WHAT to signal. Pure functions
// exported from cli.ts; the module's main() is gated off under vitest.
import { test, expect, describe, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as http from "node:http";
import type { ProcessIdentity } from "./cli";

// Isolate every path the module computes at import time from the real ~/.joy.
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-test-"));
delete process.env.JOY_SESSION_ID;
const { resolvePkgDir, looksLikeJoyDaemon, verifyDaemonPid, serverEntryOf, execMatches, processIdentity, systemdUnit, detectSupervisor, resolveOwnership, cmdStop, cmdNew, cmdAsk, cmdWaitIdle, waitTurn } = await import("./cli");
const { launcherFromEnv, processStartId } = await import("./daemonLauncher");
const { joyStateDir } = await import("./paths");

// ── a fake daemon: the CLI finds it through daemon.json in the (isolated) state dir ──
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string) => void | Promise<void>;
const routes = new Map<string, Handler>();
const hanging = new Set<http.ServerResponse>();
let daemon: http.Server; let daemonPort = 0;
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
/** A handler that never answers (a stalled daemon); torn down with the server. */
const stall: Handler = (_req, res) => { hanging.add(res); };
const route = (key: string, h: Handler) => routes.set(key, h);
const log = { out: [] as string[], err: [] as string[] };

beforeAll(async () => {
  daemon = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const h = routes.get(`${req.method} ${url.pathname}`);
      if (!h) return json(res, 404, { error: "no_route", route: `${req.method} ${url.pathname}` });
      void h(req, res, url, body);
    });
  });
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", () => { daemonPort = (daemon.address() as { port: number }).port; r(); }));
  mkdirSync(joyStateDir(), { recursive: true });
  writeFileSync(join(joyStateDir(), "daemon.json"), JSON.stringify({ token: "tok", pid: 4242, port: daemonPort, startedAt: Date.now(), version: "test" }));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { log.out.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { log.err.push(a.map(String).join(" ")); });
});
afterEach(() => {
  routes.clear();
  for (const r of hanging) r.destroy();
  hanging.clear();
  log.out.length = 0; log.err.length = 0;
  // cmdStop removes daemon.json on success; put it back for the next test
  writeFileSync(join(joyStateDir(), "daemon.json"), JSON.stringify({ token: "tok", pid: 4242, port: daemonPort, startedAt: Date.now(), version: "test" }));
});
afterAll(async () => {
  vi.restoreAllMocks();
  daemon.closeAllConnections();
  await new Promise<void>((r) => daemon.close(() => r()));
});

describe("joy stop under a supervisor (#502)", () => {
  const fakeRun = (mainPid: string, onStop: () => void) => (cmd: string, args: string[]) => {
    if (cmd === "systemctl" && args.includes("show")) return { status: 0, stdout: `MainPID=${mainPid}\n` };
    if (cmd === "systemctl" && args.includes("stop")) { onStop(); return { status: 0, stdout: "" }; }
    return { status: 1, stdout: "" };
  };

  test("detectSupervisor: systemd owns the pid only when the unit's MainPID IS the daemon; launchd via its job PID", () => {
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("4242", () => {}) })).toEqual({ kind: "systemd", unit: "joy-daemon.service" });
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("0", () => {}) })).toBeNull();     // unit inactive / not installed
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("999", () => {}) })).toBeNull();   // some other daemon under the unit
    // An inspection that FAILS is not "no supervisor" (#502 residual): it is unknown.
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 1, stdout: "" }) })).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/systemctl --user show joy-daemon.service exited 1/) });
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: null, stdout: "" }) })).toMatchObject({ kind: "unknown" }); // no systemctl binary
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 0, stdout: "garbage\n" }) })).toMatchObject({ kind: "unknown" });
    // An exit-0 run that printed NO MainPID line is the same non-answer (Astra F9):
    // Number("") is 0, which used to read as "inactive — unsupervised".
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 0, stdout: "" }) })).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/printed nothing, not a MainPID= line/) });
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 0, stdout: "MainPID=\n" }) })).toMatchObject({ kind: "unknown" });
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 0, stdout: "4242\n" }) })).toMatchObject({ kind: "unknown" }); // a bare number is not the property line
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 0, stdout: "Id=joy-daemon.service\nMainPID=4242\n" }) })).toEqual({ kind: "systemd", unit: "joy-daemon.service" });
    const launchd = (out: string, status = 0) => ({ platform: "darwin", run: () => ({ status, stdout: out }) });
    expect(detectSupervisor(4242, launchd('{\n\t"PID" = 4242;\n\t"Label" = "vip.faraz.joy-daemon";\n};'))?.kind).toBe("launchd");
    expect(detectSupervisor(4242, launchd('{\n\t"Label" = "vip.faraz.joy-daemon";\n};'))).toBeNull(); // loaded, not running: a job dictionary without a PID
    expect(detectSupervisor(4242, launchd('{\n\t"PID" = 999;\n\t"Label" = "vip.faraz.joy-daemon";\n};'))).toBeNull(); // the job runs something else
    expect(detectSupervisor(4242, launchd("", 113))).toBeNull(); // not loaded: launchctl's own definitive answer
    expect(detectSupervisor(4242, launchd("", 1))).toMatchObject({ kind: "unknown" }); // launchctl itself failed
    // Exit 0 without the job's dictionary is malformed, not an inactive job (Astra F9).
    expect(detectSupervisor(4242, launchd(""))).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/printed nothing, not the job's dictionary/) });
    expect(detectSupervisor(4242, launchd("garbage\n"))).toMatchObject({ kind: "unknown" });
    expect(detectSupervisor(4242, launchd('{\n\t"Label" = "com.other.job";\n};'))).toMatchObject({ kind: "unknown" }); // some other job's dictionary
  });

  describe("a failed supervisor inspection (#502 residual)", () => {
    const failing = (cmd: string, args: string[]) => (cmd === "systemctl" && args.includes("stop")) ? { status: 0, stdout: "" } : { status: 1, stdout: "" };
    const withLauncher = (launcher?: string) => writeFileSync(join(joyStateDir(), "daemon.json"), JSON.stringify({ token: "tok", pid: 4242, port: daemonPort, startedAt: Date.now(), version: "test", ...(launcher ? { launcher } : {}) }));

    test("systemctl show fails, no independent evidence: nothing is signalled, exit 1 with the reason", async () => {
      route("GET /status", (_q, res) => json(res, 200, { pid: 4242, version: "test" }));
      const actions: string[] = [];
      const code = await cmdStop({ platform: "linux", run: (_c, args) => { actions.push(args.join(" ")); return failing(_c, args); }, kill: () => { actions.push("SIGTERM"); }, exists: () => false, cgroupOf: () => null });
      expect(code).toBe(1);
      expect(actions).not.toContain("SIGTERM");
      expect(actions.some((a) => a.includes(" stop "))).toBe(false);
      expect(log.out.join("\n")).toMatch(/could not determine whether the daemon is supervised \(systemctl --user show joy-daemon.service exited 1\) — nothing signalled/);
    });

    test("systemctl show fails but the unit file is installed: stopped through systemctl, never signalled", async () => {
      let alive = true;
      route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
      const killed: number[] = [];
      const run = (cmd: string, args: string[]) => { const r = failing(cmd, args); if (args.includes("stop")) alive = false; return r; };
      const code = await cmdStop({ platform: "linux", run, kill: (pid) => { killed.push(pid); }, exists: (p) => p.endsWith("/.config/systemd/user/joy-daemon.service"), cgroupOf: () => null });
      expect(code).toBe(0);
      expect(killed).toEqual([]);
      expect(log.out.join("\n")).toContain("via systemctl --user stop joy-daemon.service");
    });

    test("daemon.json records a detached launch: the daemon's own word beats an installed unit file — SIGTERM directly", async () => {
      withLauncher("detached");
      let alive = true;
      route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
      const killed: string[] = [];
      const code = await cmdStop({ platform: "linux", run: failing, kill: (_p, sig) => { killed.push(sig); alive = false; }, exists: () => true, cgroupOf: () => null });
      expect(code).toBe(0);
      expect(killed).toEqual(["SIGTERM"]);
    });

    test("daemon.json records a systemd launch: stopped through the unit", async () => {
      withLauncher("systemd");
      let alive = true;
      route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
      const killed: string[] = [];
      const run = (cmd: string, args: string[]) => { const r = failing(cmd, args); if (args.includes("stop")) alive = false; return r; };
      expect(await cmdStop({ platform: "linux", run, kill: (_p, sig) => { killed.push(sig); }, exists: () => false, cgroupOf: () => null })).toBe(0);
      expect(killed).toEqual([]);
      expect(log.out.join("\n")).toContain("via systemctl --user stop joy-daemon.service");
    });

    // Astra F9: `systemctl show` exited 0 and printed NOTHING while daemon.json
    // recorded a systemd launch — the blank read as MainPID 0, "unsupervised",
    // and the unit's daemon got a direct SIGTERM that Restart=always undid.
    test("an exit-0 inspection that printed nothing is no answer: daemon.json's systemd launch wins, stopped through the unit", async () => {
      withLauncher("systemd");
      let alive = true;
      route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
      const actions: string[] = [];
      const run = (_c: string, args: string[]) => { actions.push(args.join(" ")); if (args.includes("stop")) alive = false; return { status: 0, stdout: "" }; };
      expect(await cmdStop({ platform: "linux", run, kill: () => { actions.push("SIGTERM"); }, exists: () => false, cgroupOf: () => null })).toBe(0);
      expect(actions).not.toContain("SIGTERM");
      expect(actions).toContain("--user stop joy-daemon.service");
      expect(log.out.join("\n")).toContain("via systemctl --user stop joy-daemon.service");
    });

    test("an exit-0 inspection that printed nothing, no independent evidence: nothing is signalled, exit 1", async () => {
      route("GET /status", (_q, res) => json(res, 200, { pid: 4242, version: "test" }));
      const actions: string[] = [];
      const run = (_c: string, args: string[]) => { actions.push(args.join(" ")); return { status: 0, stdout: "" }; };
      expect(await cmdStop({ platform: "linux", run, kill: () => { actions.push("SIGTERM"); }, exists: () => false, cgroupOf: () => null })).toBe(1);
      expect(actions).not.toContain("SIGTERM");
      expect(actions.some((a) => a.includes(" stop "))).toBe(false);
      expect(log.out.join("\n")).toMatch(/could not determine whether the daemon is supervised \(systemctl --user show joy-daemon.service printed nothing, not a MainPID= line\) — nothing signalled/);
    });

    test("darwin: exit-0 garbage from launchctl takes the unknown path too — daemon.json's launchd record stops it through launchctl", async () => {
      withLauncher("launchd");
      let alive = true;
      route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
      const actions: string[] = [];
      const run = (cmd: string, args: string[]) => { actions.push(`${cmd} ${args[0]}`); if (args[0] === "unload") alive = false; return { status: 0, stdout: cmd === "launchctl" && args[0] === "list" ? "garbage\n" : "" }; };
      expect(await cmdStop({ platform: "darwin", run, kill: () => { actions.push("SIGTERM"); }, exists: () => false })).toBe(0);
      expect(actions).toEqual(["launchctl list", "launchctl unload"]);
    });

    test("the kernel's cgroup settles it either way", () => {
      const deps = { platform: "linux", run: failing, kill: () => {}, exists: () => false };
      const inUnit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/joy-daemon.service\n";
      expect(resolveOwnership(4242, { ...deps, cgroupOf: () => inUnit }, null)).toMatchObject({ kind: "supervised", supervisor: { kind: "systemd", unit: "joy-daemon.service" }, evidence: expect.stringContaining("cgroup") });
      const inScope = "0::/user.slice/user-1000.slice/session-3.scope\n";
      expect(resolveOwnership(4242, { ...deps, cgroupOf: () => inScope }, null)).toMatchObject({ kind: "unsupervised", evidence: expect.stringContaining("cgroup") });
      // a unit file alone (no cgroup, no launcher) still means "stop through the owner"
      expect(resolveOwnership(4242, { ...deps, cgroupOf: () => null, exists: () => true }, null)).toMatchObject({ kind: "supervised" });
      expect(resolveOwnership(4242, { ...deps, cgroupOf: () => null }, null)).toMatchObject({ kind: "unknown" });
      // the supervisor's own answer needs no evidence
      expect(resolveOwnership(4242, { ...deps, run: fakeRun("0", () => {}) }, { launcher: "systemd" })).toMatchObject({ kind: "unsupervised", evidence: expect.stringContaining("does not run this pid") });
    });

    test("launcherFromEnv: what the daemon records", () => {
      expect(launcherFromEnv({ INVOCATION_ID: "abc" }, "linux")).toBe("systemd");
      expect(launcherFromEnv({}, "linux")).toBe("detached");
      expect(launcherFromEnv({ XPC_SERVICE_NAME: "vip.faraz.joy-daemon" }, "darwin")).toBe("launchd");
      expect(launcherFromEnv({ XPC_SERVICE_NAME: "0" }, "darwin")).toBe("detached");
      expect(launcherFromEnv({ INVOCATION_ID: "abc" }, "darwin")).toBe("detached"); // a foreign marker means nothing on the other platform
    });
  });

  test("a systemd-supervised daemon is stopped through systemctl, never signalled directly", async () => {
    let alive = true; const killed: number[] = [];
    route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
    const code = await cmdStop({ platform: "linux", run: fakeRun("4242", () => { alive = false; }), kill: (pid) => { killed.push(pid); } });
    expect(code).toBe(0);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toContain("via systemctl --user stop joy-daemon.service");
  });

  test("systemctl stop failing is reported as failure — no fallback signal that the unit would undo", async () => {
    route("GET /status", (_q, res) => json(res, 200, { pid: 4242, version: "test" }));
    const killed: number[] = [];
    const run = (cmd: string, args: string[]) => args.includes("show") ? { status: 0, stdout: "MainPID=4242\n" } : { status: 5, stdout: "" };
    expect(await cmdStop({ platform: "linux", run, kill: (pid) => { killed.push(pid); } })).toBe(1);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toMatch(/systemctl --user stop joy-daemon.service failed/);
  });

  test("a detached daemon (unit inactive) still gets SIGTERM directly", async () => {
    let alive = true;
    route("GET /status", (_q, res) => alive ? json(res, 200, { pid: 4242, version: "test" }) : json(res, 503, {}));
    const killed: [number, string][] = [];
    const code = await cmdStop({ platform: "linux", run: fakeRun("0", () => {}), kill: (pid, sig) => { killed.push([pid, sig]); alive = false; } });
    expect(code).toBe(0);
    expect(killed).toEqual([[4242, "SIGTERM"]]);
    expect(log.out.join("\n")).toContain("stopped (pid 4242)");
  });
});

// ── session verbs against the fake daemon ──────────────────────────────────
const SID = "abcdef01";
const sessionsRoute = () => route("GET /sessions", (_q, res) => json(res, 200, [{ id: SID, cwd: "/tmp/x", status: "active" }]));
const rec = (seq: number, record: unknown) => ({ seq, at: Date.now(), record });
const agentText = (seq: number, text: string, turn = "t") => rec(seq, { role: "session", content: { type: "session", data: { turn, ev: { t: "text", text } } } });
const turnStart = (seq: number, turn: string) => rec(seq, { role: "session", content: { type: "session", data: { turn, ev: { t: "turn-start" } } } });
const userRow = (seq: number, text: string) => rec(seq, { role: "user", content: { type: "text", text } });
const ndjson = (lines: unknown[]) => lines.map((l) => JSON.stringify(l) + "\n").join("");
/** /sessions/:id/events over an in-memory log: `{hello, seq}` then the records after ?after
 *  (or just hello for ?last=0, the CLI's currentSeq probe); a follow stream stays open and
 *  `push` feeds it live. `onConnect` can take over a connection (returns true when it did).
 *  The fixture is driven by what has HAPPENED, never by timers (#626): `opened()` resolves
 *  once a follow stream is open, `connected(k)` once the k-th /events request has been
 *  served, `push` once the row is flushed to every open stream's socket, and `drop` ends the
 *  open follow streams — ordered after whatever was pushed before it. */
const eventsRoute = (initial: unknown[] = [], opts: { onConnect?: (n: number, res: http.ServerResponse, after: number) => boolean } = {}) => {
  const log: { seq: number }[] = [...(initial as { seq: number }[])];
  const open = new Set<http.ServerResponse>();
  let n = 0;
  const waiting: Array<{ ready: () => boolean; resolve: () => void }> = [];
  const until = (ready: () => boolean) => new Promise<void>((resolve) => { if (ready()) resolve(); else waiting.push({ ready, resolve }); });
  const settle = () => { for (const w of waiting.splice(0)) { if (w.ready()) w.resolve(); else waiting.push(w); } };
  route(`GET /sessions/${SID}/events`, (_q, res, url) => {
    n++;
    try {
      const after = Number(url.searchParams.get("after") ?? 0);
      if (opts.onConnect?.(n, res, after)) return;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const hello = { hello: true, seq: log.length ? log[log.length - 1].seq : 0 };
      if (url.searchParams.has("last")) { res.end(ndjson([hello])); return; }
      res.write(ndjson([hello, ...log.filter((r) => r.seq > after)]));
      if (url.searchParams.get("follow") === "1") { open.add(res); hanging.add(res); res.on("close", () => open.delete(res)); } else res.end();
    } finally { settle(); }
  });
  const flushed = (res: http.ServerResponse, data: string) => new Promise<void>((r) => { res.write(data, () => r()); });
  return {
    /** Append `r` to the log and write it to every open follow stream; resolves once each socket has taken it. */
    push: (r: { seq: number }) => { log.push(r); return Promise.all([...open].map((res) => flushed(res, ndjson([r])))).then(() => {}); },
    /** End every open follow stream (after anything pushed before); resolves once each has finished. */
    drop: () => Promise.all([...open].map((res) => { open.delete(res); hanging.delete(res); return new Promise<void>((r) => { res.end(() => r()); }); })).then(() => {}),
    opened: () => until(() => open.size > 0),
    connected: (k: number) => until(() => n >= k),
    connections: () => n,
  };
};
/** Push `r`, then end the live follow stream — strictly in that order: wait for a
 *  follow stream to be open, write the row and wait for the socket to take it, then
 *  end the stream. No timer anywhere: a fixed delay raced the push against the
 *  connect under CPU load (the stream sometimes ended before the row was written,
 *  sometimes before it was even open — #626). */
const pushThenDrop = async (ev: ReturnType<typeof eventsRoute>, r: { seq: number }) => { await ev.opened(); await ev.push(r); await ev.drop(); };
const checkRoute = (h: (n: number) => unknown | Handler) => { let n = 0; route(`GET /sessions/${SID}/check`, (q, res, url, body) => { const v = h(++n); return typeof v === "function" ? (v as Handler)(q, res, url, body) : json(res, 200, v); }); };
/** /check reads busy until `scenario` has run to completion and idle after it: the
 *  wait's verdict follows the fixture's progress, never a poll count against a clock. */
const busyUntil = (scenario: () => Promise<void>) => {
  let done = false;
  checkRoute(() => ({ state: done ? "idle" : "busy" }));
  return async () => { await scenario(); done = true; };
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("joy new -m: a rejected first message fails the command (#494)", () => {
  test("the daemon refuses the send (500): exit 1, the id is still printed, retry guidance on stderr", async () => {
    route("POST /sessions", (_q, res) => json(res, 201, { id: SID, cwd: "/tmp/x" }));
    eventsRoute();
    route("POST /send", (_q, res) => json(res, 500, { error: "not_durable" }));
    expect(await cmdNew(["/tmp/x", "-m", "do work"])).toBe(1);
    expect(log.out).toEqual([SID]);
    expect(log.err.join("\n")).toMatch(/first message was not accepted — retry with: joy send abcdef01 'do work'/);
  });

  test("the retry line is shell-quoted: a $(…) or backtick in the prompt is inert when pasted (#494 regression)", async () => {
    route("POST /sessions", (_q, res) => json(res, 201, { id: SID, cwd: "/tmp/x" }));
    eventsRoute();
    route("POST /send", (_q, res) => json(res, 500, { error: "not_durable" }));
    expect(await cmdNew(["/tmp/x", "-m", "explain $(printf substituted)"])).toBe(1);
    expect(log.err.join("\n")).toContain("joy send abcdef01 'explain $(printf substituted)'");
    expect(log.err.join("\n")).not.toContain('"explain $(printf substituted)"');
    log.err.length = 0;
    expect(await cmdNew(["/tmp/x", "-m", "run `ls` and it's done"])).toBe(1);
    // one POSIX word: the apostrophe closes, escapes and reopens the quote
    expect(log.err.join("\n")).toContain("joy send abcdef01 'run `ls` and it'\\''s done'");
  });

  test("the send cannot connect: exit 1, not a silent success", async () => {
    route("POST /sessions", (_q, res) => json(res, 201, { id: SID, cwd: "/tmp/x" }));
    eventsRoute();
    route("POST /send", (_q, res) => { res.destroy(); });
    expect(await cmdNew(["/tmp/x", "-m", "do work"])).toBe(1);
    expect(log.out).toEqual([SID]);
    expect(log.err.join("\n")).toMatch(/not accepted/);
  });

  test("an accepted send: exit 0, id printed", async () => {
    route("POST /sessions", (_q, res) => json(res, 201, { id: SID, cwd: "/tmp/x" }));
    eventsRoute();
    route("POST /send", (_q, res) => json(res, 200, { ok: true, queued_id: "q1" }));
    expect(await cmdNew(["/tmp/x", "-m", "do work"])).toBe(0);
    expect(log.out).toEqual([SID]);
    expect(log.err).toEqual([]);
  });
});

describe("joy wait: a missing session or a failing /check is never 'answered' (#496)", () => {
  test("404 session_not_found → gone, exit 1", async () => {
    sessionsRoute();
    checkRoute(() => (_q: http.IncomingMessage, res: http.ServerResponse) => json(res, 404, { error: "session_not_found" }));
    // no events route: the stream 404s too
    expect(await cmdWaitIdle([SID])).toBe(1);
    expect(log.err.join("\n")).toMatch(/gone \(session_not_found\)/);
    expect(log.out).toEqual([]);
  });

  test("HTTP 500 from /check → error, exit 1, with the reason", async () => {
    sessionsRoute(); eventsRoute();
    checkRoute(() => (_q: http.IncomingMessage, res: http.ServerResponse) => json(res, 500, { error: "kaboom" }));
    expect(await cmdWaitIdle([SID])).toBe(1);
    expect(log.err.join("\n")).toMatch(/check failed: kaboom/);
  });

  test("a state the daemon never advertises is not idle", async () => {
    sessionsRoute(); eventsRoute();
    checkRoute(() => ({ state: "wat" }));
    expect(await cmdWaitIdle([SID])).toBe(1);
    expect(log.err.join("\n")).toMatch(/unexpected check state "wat"/);
  });

  test("control: an explicit idle after activity → answered, exit 0", async () => {
    sessionsRoute(); eventsRoute([agentText(1, "hi")]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdWaitIdle([SID])).toBe(0);
    expect(log.out.join("\n")).toContain(`${SID} idle`);
  });
});

describe("a stalled daemon cannot defeat the turn timeout (#501)", () => {
  test("/check accepts the request and never answers: --timeout 0.3 → exit 4 promptly", async () => {
    sessionsRoute(); eventsRoute();
    route(`GET /sessions/${SID}/check`, stall);
    const t0 = Date.now();
    expect(await cmdWaitIdle([SID, "--timeout", "0.3"])).toBe(4);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(log.err.join("\n")).toMatch(/timed out after 0.3s/);
  });

  test("/queue never answers while waiting on a turn id: exit 4 promptly", async () => {
    sessionsRoute(); eventsRoute();
    route(`GET /sessions/${SID}/queue`, stall);
    route(`GET /sessions/${SID}/check`, stall);
    const t0 = Date.now();
    expect(await cmdWaitIdle([SID, "--turn", "q1", "--timeout", "0.3"])).toBe(4);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  // #501 residual (Astra): the deadline used to end the polling and then a
  // FRESH 3 s catch-up ran — a 20 ms wait returned after ~3030 ms.
  test("a 20 ms wait with the event stream AND /check stalled returns timeout within ~100 ms — no catch-up after the deadline", async () => {
    route(`GET /sessions/${SID}/events`, stall);
    route(`GET /sessions/${SID}/check`, stall);
    const t0 = Date.now();
    const out = await waitTurn(SID, { afterSeq: 0, timeoutMs: 20 });
    const elapsed = Date.now() - t0;
    expect(out.state).toBe("timeout");
    expect(elapsed).toBeLessThan(150);
  });

  test("the pre-wait probes run under the same clock: GET /sessions stalls → ask exits 4 at its --timeout", async () => {
    route("GET /sessions", stall);
    const t0 = Date.now();
    expect(await cmdAsk([SID, "hello", "--timeout", "0.1"])).toBe(4);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(log.err.join("\n")).toMatch(/timed out resolving session/);
  });

  test("POST /send stalls → ask exits 4 at its --timeout and says the send may or may not have landed", async () => {
    sessionsRoute(); eventsRoute();
    route("POST /send", stall);
    const t0 = Date.now();
    expect(await cmdAsk([SID, "hello", "--timeout", "0.1"])).toBe(4);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(log.err.join("\n")).toMatch(/timed out waiting for the daemon to accept the message/);
  });

  test("the seq probe (events?last=0) stalls → ask exits 4 at its --timeout", async () => {
    sessionsRoute();
    route(`GET /sessions/${SID}/events`, stall);
    const t0 = Date.now();
    expect(await cmdAsk([SID, "hello", "--timeout", "0.1"])).toBe(4);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("the finish grace and catch-up are clipped to the deadline: a turn that ends 20 ms before it still returns on time", async () => {
    sessionsRoute();
    const ev = eventsRoute([agentText(1, "hi")]);
    let n = 0;
    route(`GET /sessions/${SID}/check`, (_q, res) => { n++; if (n === 1) json(res, 200, { state: "busy" }); else json(res, 200, { state: "idle" }); });
    // the follow stream dies right away and every reconnect stalls, so the
    // catch-up at the end would want its 3 s — it gets what is left instead
    setTimeout(() => { for (const r of hanging) r.destroy(); hanging.clear(); route(`GET /sessions/${SID}/events`, stall); }, 50);
    void ev;
    const t0 = Date.now();
    const code = await cmdWaitIdle([SID, "--timeout", "0.6"]);
    expect(Date.now() - t0).toBeLessThan(1200);
    expect([0, 1, 4]).toContain(code); // what matters here is WHEN it returned
  });
});

describe("a broken event stream never yields a successful partial answer (#497)", () => {
  test("the stream drops mid-reply and cannot be reopened: exit 1, the partial text is flagged incomplete", async () => {
    sessionsRoute();
    const ev = eventsRoute([], {
      onConnect: (n, res) => {
        if (n <= 2) return false; // the currentSeq probe, then the first follow stream
        json(res, 500, { error: "boom" }); return true; // every reconnect and the catch-up fail
      },
    });
    // the follow stream ends after "part one"; the session reads idle once the first reconnect has failed
    const play = busyUntil(async () => { await pushThenDrop(ev, agentText(1, "part one")); await ev.connected(3); });
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: null }); void play(); });
    expect(await cmdAsk([SID, "hello", "--no-queue"])).toBe(1);
    expect(log.err.join("\n")).toMatch(/output stream lost after seq 1 .* the reply is incomplete/);
  });

  test("the stream drops and is resumed from the last consumed seq: the whole reply, exit 0", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    // the first follow stream ends after "part one"; "part two" lands while disconnected;
    // the session reads idle once the stream has been reopened (after=1)
    const play = busyUntil(async () => { await pushThenDrop(ev, agentText(1, "part one")); await ev.push(agentText(2, "part two")); await ev.connected(3); });
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: null }); void play(); });
    expect(await cmdAsk([SID, "hello", "--no-queue"])).toBe(0);
    expect(log.out).toEqual(["part one\n\npart two"]);
    expect(ev.connections()).toBeGreaterThan(1);
  });

  // #497 residual (Astra): a reconnect that says hello{seq:2} and then stalls
  // before row 2 used to count as "connected", the catch-up was skipped, and
  // `ask` exited 0 with part one only.
  const stalledReopen = (stallFrom: number, stallTo: number) => eventsRoute([], {
    onConnect: (n, res) => {
      if (n < stallFrom || n > stallTo) return false; // the seq probe + the first follow, then whatever comes after the stall window
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(ndjson([{ hello: true, seq: 2 }])); // the reopened stream advertises seq 2 …
      hanging.add(res); return true;                // … and never sends it
    },
  });
  const reopenScenario = (ev: ReturnType<typeof eventsRoute>) => {
    // the first follow stream ends after part one; row 2 then exists on the daemon;
    // the session reads idle once the stream has been reopened (the stalled reconnect)
    const play = busyUntil(async () => { await pushThenDrop(ev, agentText(1, "part one")); await ev.push(agentText(2, "part two")); await ev.connected(3); });
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: null }); void play(); });
  };

  test("a reopened stream that advertises seq 2 and stalls: the catch-up cannot get it either → exit 1, incomplete", async () => {
    sessionsRoute();
    reopenScenario(stalledReopen(3, Infinity)); // every connection after the drop stalls after hello{seq:2}
    expect(await cmdAsk([SID, "hello", "--no-queue", "--timeout", "8"])).toBe(1);
    expect(log.out).toEqual(["part one"]);
    expect(log.err.join("\n")).toMatch(/output stream lost after seq 1 — the daemon holds records through seq 2 .* the reply is incomplete/);
  }, 15_000);

  test("a reopened stream that advertises seq 2 and stalls: the final catch-up fetches row 2 → exit 0 with both parts", async () => {
    sessionsRoute();
    reopenScenario(stalledReopen(3, 3)); // only the reconnect stalls; the head probe and the catch-up are served
    expect(await cmdAsk([SID, "hello", "--no-queue", "--timeout", "8"])).toBe(0);
    expect(log.out).toEqual(["part one\n\npart two"]);
  });

  // Astra F9: the deadline tripped during the finish grace, the completeness
  // check sat behind !timedOut(), and the `answered` selected before it came
  // back with "partial" — seq 2 advertised, never fetched, no turn-end.
  test("the deadline trips during the finish grace: the advertised row is still checked for → timeout (exit 4), never a partial answered", async () => {
    // every /events request (the head probe and the catch-up too) says hello{seq:2}, sends row 1 and stalls
    route(`GET /sessions/${SID}/events`, (_q, res) => { res.writeHead(200, { "Content-Type": "application/x-ndjson" }); res.write(ndjson([{ hello: true, seq: 2 }, agentText(1, "partial")])); hanging.add(res); });
    route(`GET /sessions/${SID}/queue/qDone`, (_q, res) => json(res, 200, { ok: true, id: "qDone", state: "completed", terminalReason: "completed", runtimeTurnId: "t" }));
    checkRoute(() => ({ state: "idle" }));
    const started = Date.now();
    const out = await waitTurn(SID, { afterSeq: 0, queuedId: "qDone", timeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(700);
    expect(out.state).toBe("timeout");
    expect(out.reason).toMatch(/deadline expired before the reply could be verified complete: output stream lost after seq 1 — the daemon holds records through seq 2/);
  });

  test("the same log with time left: the catch-up cannot get row 2 either → error, incomplete (exit 1)", async () => {
    route(`GET /sessions/${SID}/events`, (_q, res) => { res.writeHead(200, { "Content-Type": "application/x-ndjson" }); res.write(ndjson([{ hello: true, seq: 2 }, agentText(1, "partial")])); hanging.add(res); });
    route(`GET /sessions/${SID}/queue/qDone`, (_q, res) => json(res, 200, { ok: true, id: "qDone", state: "completed", terminalReason: "completed", runtimeTurnId: "t" }));
    checkRoute(() => ({ state: "idle" }));
    const out = await waitTurn(SID, { afterSeq: 0, queuedId: "qDone", timeoutMs: 6000 });
    expect(out.state).toBe("error");
    expect(out.reason).toMatch(/^output stream lost after seq 1 — the daemon holds records through seq 2 .* the reply is incomplete/);
  }, 10_000);
});

describe("a queued ask is bound to its durable command and its runtime turn (#498)", () => {
  const turnEnd = (seq: number, turn: string, usage?: unknown) => rec(seq, { role: "session", content: { type: "session", data: { turn, ev: { t: "turn-end", status: "completed", ...(usage ? { usage } : {}) } } } });
  /** GET /sessions/:id/queue/:qid over a scripted sequence of states (the last one repeats). */
  const commandRoute = (qid: string, states: Array<Partial<{ state: string; terminalReason: string | null; attemptId: string | null; runtimeTurnId: string | null; turnStarted: boolean }> | Handler>) => {
    let n = 0;
    route(`GET /sessions/${SID}/queue/${qid}`, (q, res, url, body) => {
      const v = states[Math.min(n++, states.length - 1)];
      if (typeof v === "function") return (v as Handler)(q, res, url, body);
      json(res, 200, { ok: true, id: qid, text: "…", createdAt: 0, state: "queued", terminalReason: null, attemptId: "at-1", runtimeTurnId: null, turnStarted: true, attempts: 1, ...v });
    });
    return { polls: () => n };
  };

  test("B queued behind A: A's tail after the send is excluded, B's own turn (the one the daemon named for it) is the reply", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    let dispatched = false;
    route("POST /send", (_q, res) => {
      json(res, 200, { ok: true, queued_id: "q2" });
      void (async () => {
        await delay(50); ev.push(agentText(1, "A's tail", "a"));
        await delay(50); dispatched = true;
        ev.push(userRow(2, '<joy-message from="cli">\nwhat is B\n</joy-message>'));
        ev.push(turnStart(3, "b"));
        await delay(50); ev.push(agentText(4, "B's answer", "b")); ev.push(turnEnd(5, "b", { output: 7 }));
      })();
    });
    route(`GET /sessions/${SID}/queue/q2`, (_q, res) => json(res, 200, { ok: true, id: "q2", state: dispatched ? "completed" : "queued", terminalReason: dispatched ? "completed" : null, attemptId: dispatched ? "at-2" : null, runtimeTurnId: dispatched ? "b" : null, turnStarted: dispatched }));
    checkRoute(() => ({ state: "busy" }));
    expect(await cmdAsk([SID, "what", "is", "B", "--json"])).toBe(0);
    const out = JSON.parse(log.out[0]);
    expect(out).toMatchObject({ state: "answered", text: "B's answer", turn: "q2", usage: { output: 7 } });
  });

  // Astra F9 (#498 residual): A was ALREADY queued when B was sent, so A's
  // turn is the first to start after the send. The CLI used to take that
  // turn as B's and returned A's answer labelled qB. Claude's session now
  // names the transcript turn each dispatch opened; the daemon reports it and
  // the reply is exactly that turn's records.
  const aThenB = (ev: ReturnType<typeof eventsRoute>) => {
    ev.push(turnStart(1, "A")); ev.push(agentText(2, "A was already queued", "A")); ev.push(turnEnd(3, "A"));
    ev.push(turnStart(4, "B")); ev.push(agentText(5, "B requested answer", "B")); ev.push(turnEnd(6, "B"));
  };
  test("claude, A already queued when B is sent: B's reply is the turn the daemon named for qB, not A's (the first started after the send)", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => aThenB(ev), 15); });
    commandRoute("qB", [{ state: "queued" }, { state: "completed", terminalReason: "completed", attemptId: "at-b", runtimeTurnId: "B", turnStarted: true }]);
    checkRoute(() => ({ state: "busy" }));
    expect(await cmdAsk([SID, "B", "--json", "--timeout", "3"])).toBe(0);
    expect(JSON.parse(log.out[0])).toMatchObject({ state: "answered", turn: "qB", text: "B requested answer" });
  });

  test("the daemon names qB's turn late (the hook ended it before the transcript named it): re-read within the grace, then B's reply", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => aThenB(ev), 15); });
    const c = commandRoute("qB", [{ state: "completed", terminalReason: "completed", attemptId: "at-b", runtimeTurnId: null, turnStarted: true }, { state: "completed", terminalReason: "completed", attemptId: "at-b", runtimeTurnId: null, turnStarted: true }, { state: "completed", terminalReason: "completed", attemptId: "at-b", runtimeTurnId: "B", turnStarted: true }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B", "--timeout", "5"])).toBe(0);
    expect(log.out).toEqual(["B requested answer"]);
    expect(c.polls()).toBeGreaterThanOrEqual(3);
  });

  test("completed, a turn started for it, but the daemon never attributes one: an explicit attribution error (exit 1), not the first turn or everything after the send", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => aThenB(ev), 15); });
    commandRoute("qB", [{ state: "completed", terminalReason: "completed", attemptId: "at-b", runtimeTurnId: null, turnStarted: true }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B", "--json", "--timeout", "8"])).toBe(1);
    expect(JSON.parse(log.out[0])).toMatchObject({ state: "error", text: "", reason: expect.stringMatching(/turn qB completed but the daemon attributed no runtime turn to it \(attempt at-b\) — the reply cannot be told from other turns' output/) });
  }, 15_000);

  test("an older daemon that reports neither attemptId nor turnStarted: the same attribution error, never a guess", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => aThenB(ev), 15); });
    route(`GET /sessions/${SID}/queue/qB`, (_q, res) => json(res, 200, { ok: true, id: "qB", state: "completed", terminalReason: "completed", runtimeTurnId: null }));
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B", "--timeout", "8"])).toBe(1);
    expect(log.out).toEqual([]);
    expect(log.err.join("\n")).toMatch(/turn qB completed but the daemon attributed no runtime turn to it — the reply cannot be told/);
  }, 15_000);

  // Astra F9: a /title the daemon handled itself completes with no runtime
  // turn; with no new turn-start the CLI fell back to ALL later records and
  // returned an unrelated active turn's tail as the answer.
  test("a handled command (/title): completed with no runtime output → exit 0, EMPTY reply, no foreign tail", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qTitle" }); ev.push(agentText(1, "unrelated active turn tail", "A")); });
    route(`GET /sessions/${SID}/queue/qTitle`, (_q, res) => json(res, 200, { ok: true, id: "qTitle", state: "completed", terminalReason: "handled_as_command", attemptId: null, runtimeTurnId: null, turnStarted: false }));
    checkRoute(() => ({ state: "busy" }));
    expect(await cmdAsk([SID, "/title new title", "--json", "--timeout", "3"])).toBe(0);
    expect(JSON.parse(log.out[0])).toMatchObject({ state: "answered", turn: "qTitle", text: "", reason: expect.stringMatching(/turn qTitle completed without runtime output \(handled by the daemon itself\)/) });
    // and in plain mode: nothing on stdout, the note on stderr
    expect(await cmdAsk([SID, "/title again", "--timeout", "3"])).toBe(0);
    expect(log.out).toHaveLength(1);
    expect(log.err.join("\n")).toMatch(/completed without runtime output/);
  });

  test("a slash command claude took (no turn started for its attempt): the same empty reply, exit 0", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qC" }); ev.push(agentText(1, "some other turn's text", "A")); });
    route(`GET /sessions/${SID}/queue/qC`, (_q, res) => json(res, 200, { ok: true, id: "qC", state: "completed", terminalReason: "completed", attemptId: "at-c", runtimeTurnId: null, turnStarted: false }));
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "/compact", "--json", "--timeout", "3"])).toBe(0);
    expect(JSON.parse(log.out[0])).toMatchObject({ state: "answered", text: "", reason: expect.stringMatching(/turn qC completed without runtime output \(completed, no runtime turn started for it\)/) });
  });

  // Astra's early-mirror order: the real codex adapter mirrors the prompt at
  // ACCEPTANCE, while the previous turn still emits, and the next turn can
  // follow in the same burst. The shipped test used to delay the mirror
  // until dispatch and returned "A tail / B answer / C answer".
  const earlyMirrorBurst = (ev: ReturnType<typeof eventsRoute>) => {
    ev.push(userRow(1, "B"));
    ev.push(agentText(2, "A tail", "A"));
    ev.push(turnStart(3, "B")); ev.push(agentText(4, "B answer", "B")); ev.push(turnEnd(5, "B"));
    ev.push(turnStart(6, "C")); ev.push(agentText(7, "C answer", "C")); ev.push(turnEnd(8, "C"));
  };

  test("early mirror, the daemon names the runtime turn (codex): exactly that turn's records are the reply", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => earlyMirrorBurst(ev), 20); });
    commandRoute("qB", [{ state: "running", runtimeTurnId: "B" }, { state: "completed", terminalReason: "delivered", runtimeTurnId: "B" }]);
    checkRoute((n) => ({ state: n === 1 ? "busy" : "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(0);
    expect(log.out).toEqual(["B answer"]);
  });

  test("early mirror, the turn named while running (claude: the transcript opened it): exactly that turn — not A's tail, not C", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => earlyMirrorBurst(ev), 20); });
    commandRoute("qB", [{ state: "running" }, { state: "running", runtimeTurnId: "B" }, { state: "completed", terminalReason: "completed", runtimeTurnId: "B" }]);
    checkRoute((n) => ({ state: n === 1 ? "busy" : "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(0);
    expect(log.out).toEqual(["B answer"]);
  });

  test("a command that the daemon reports completed before the CLI ever saw it pending: still its own turn", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); earlyMirrorBurst(ev); });
    commandRoute("qB", [{ state: "completed", terminalReason: "delivered", runtimeTurnId: "B" }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(0);
    expect(log.out).toEqual(["B answer"]);
  });

  // Astra: a 500 from the queue read used to become an empty queue —
  // "dispatched" — and a busy→idle flip then produced `answered` for a turn
  // that never ran.
  test("a failing command read is an error, never an empty queue: 500 then busy→idle is exit 1, not answered", async () => {
    sessionsRoute(); eventsRoute();
    route("POST /send", (_q, res) => json(res, 200, { ok: true, queued_id: "never-dispatched" }));
    route(`GET /sessions/${SID}/queue/never-dispatched`, (_q, res) => json(res, 500, { error: "cannot read queue" }));
    checkRoute((n) => ({ state: n === 1 ? "busy" : "idle" }));
    expect(await cmdAsk([SID, "B", "--json", "--timeout", "5"])).toBe(1);
    const out = JSON.parse(log.out[0]);
    expect(out.state).toBe("error");
    expect(out.reason).toMatch(/queue read failed for turn never-dispatched: cannot read queue/);
  });

  test("a brief run of unreadable reads (a daemon re-exec) is ridden out", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => { ev.push(turnStart(1, "B")); ev.push(agentText(2, "B answer", "B")); ev.push(turnEnd(3, "B")); }, 20); });
    commandRoute("qB", [(_q, res) => { res.destroy(); }, { state: "completed", terminalReason: "delivered", runtimeTurnId: "B" }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(0);
    expect(log.out).toEqual(["B answer"]);
  });

  test("a global idle never completes a durable turn: the command stays queued → timeout (exit 4), not answered", async () => {
    sessionsRoute(); eventsRoute([agentText(1, "someone else's text", "z")]);
    route("POST /send", (_q, res) => json(res, 200, { ok: true, queued_id: "qB" }));
    commandRoute("qB", [{ state: "queued" }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B", "--timeout", "1"])).toBe(4);
    expect(log.out).toEqual([]);
  });

  test("the daemon does not know the id: exit 1 with the reason", async () => {
    sessionsRoute(); eventsRoute();
    route("POST /send", (_q, res) => json(res, 200, { ok: true, queued_id: "qB" }));
    route(`GET /sessions/${SID}/queue/qB`, (_q, res) => json(res, 404, { error: "command_not_found" }));
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(1);
    expect(log.err.join("\n")).toMatch(/the daemon has no record of turn qB/);
  });

  test("the command's own outcome is the verdict: failed → exit 1 with the daemon's reason; cancelled → exit 1", async () => {
    sessionsRoute(); eventsRoute();
    route("POST /send", (_q, res) => json(res, 200, { ok: true, queued_id: "qB" }));
    commandRoute("qB", [{ state: "failed", terminalReason: "rejected: turn refused" }]);
    checkRoute(() => ({ state: "idle" }));
    expect(await cmdAsk([SID, "B"])).toBe(1);
    expect(log.err.join("\n")).toMatch(/turn qB failed: rejected: turn refused/);
    log.err.length = 0;
    commandRoute("qB", [{ state: "cancelled", terminalReason: "cancelled" }]);
    expect(await cmdAsk([SID, "B"])).toBe(1);
    expect(log.err.join("\n")).toMatch(/turn qB cancelled \(cancelled\) — it did not run to completion/);
  });

  test("needs_input during the turn still ends the wait with exit 6 and the text so far", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => { ev.push(turnStart(1, "B")); ev.push(agentText(2, "may I?", "B")); }, 20); });
    commandRoute("qB", [{ state: "running", runtimeTurnId: "B" }]);
    checkRoute((n) => (n === 1 ? { state: "busy" } : { state: "needs_input", approvals: [{ requestId: "r1", title: "rm -rf" }] }));
    expect(await cmdAsk([SID, "B"])).toBe(6);
    expect(log.out).toEqual(["may I?"]);
  });

  test("completed, but the attributed turn's end record is not in the log: error, not a guessed reply", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "qB" }); setTimeout(() => { ev.push(turnStart(1, "X")); ev.push(agentText(2, "not B", "X")); }, 20); });
    commandRoute("qB", [{ state: "running", runtimeTurnId: "B" }, { state: "completed", terminalReason: "delivered", runtimeTurnId: "B" }]);
    checkRoute(() => ({ state: "busy" }));
    expect(await cmdAsk([SID, "B"])).toBe(1);
    expect(log.out).toEqual([]);
    expect(log.err.join("\n")).toMatch(/turn qB completed but the turn-end record of its runtime turn B is not in the log through seq 2/);
  });

  test("joy wait --turn binds the same way: completed → idle exit 0, failed → exit 1", async () => {
    sessionsRoute(); eventsRoute([turnStart(1, "b"), turnEnd(2, "b")]);
    commandRoute("qB", [{ state: "running" }, { state: "completed", terminalReason: "completed", runtimeTurnId: "b" }]);
    checkRoute(() => ({ state: "busy" }));
    expect(await cmdWaitIdle([SID, "--turn", "qB"])).toBe(0);
    expect(log.out.join("\n")).toContain(`${SID} idle`);
    commandRoute("qB", [{ state: "interrupted", terminalReason: "idle_without_terminal" }]);
    expect(await cmdWaitIdle([SID, "--turn", "qB", "--json"])).toBe(1);
    expect(JSON.parse(log.out[log.out.length - 1])).toMatchObject({ state: "error", reason: expect.stringContaining("turn qB interrupted (idle_without_terminal)") });
  });
});

describe("systemdUnit (#499)", () => {
  const unit = systemdUnit({ node: "/usr/bin/node", serverTs: "/opt/joy/src/server.ts", pkgDir: "/opt/joy/src", path: "/usr/bin:/bin", relayUrl: "https://relay.example:4997", homeDir: "/isolated/joy home" });

  test("bakes the effective Joy home next to the relay, quoted, so the service reads the CLI's credentials and state", () => {
    expect(unit).toContain('Environment="JOY_RELAY_URL=https://relay.example:4997"');
    expect(unit).toContain('Environment="JOY_HOME_DIR=/isolated/joy home"');
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain("ExecStart=/usr/bin/node --import tsx /opt/joy/src/server.ts");
  });

  test("the supervisor semantics are unchanged", () => {
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("KillMode=process");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("resolvePkgDir (#503)", () => {
  const store = "/home/user/.local/share/pnpm/global/5/node_modules/.pnpm/@fny+joy-daemon@1.0.15/node_modules/@fny/joy-daemon/src";
  const stable = "/home/user/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src";

  test("collapses the pnpm virtual store to the stable top-level symlink — ONE node_modules", () => {
    const seen: string[] = [];
    const exists = (p: string) => { seen.push(p); return p === join(stable, "server.ts"); };
    expect(resolvePkgDir(store, exists)).toBe(stable);
    // the exact doubled path from the issue is never produced
    expect(seen.some((p) => p.includes("node_modules/node_modules"))).toBe(false);
  });

  test("a peer-suffixed store dir collapses the same way", () => {
    const peers = store.replace("@fny+joy-daemon@1.0.15", "@fny+joy-daemon@1.11.3_typescript@5.6.0");
    expect(resolvePkgDir(peers, (p) => p === join(stable, "server.ts"))).toBe(stable);
  });

  test("falls back to the real store path when the collapsed one has no server.ts", () => {
    expect(resolvePkgDir(store, () => false)).toBe(store);
  });

  test("source checkouts and npm globals are untouched", () => {
    const src = "/home/claude/Workspace/joy/packages/joy-daemon/src";
    expect(resolvePkgDir(src, () => true)).toBe(src);
    const npm = "/usr/local/lib/node_modules/@fny/joy-daemon/src";
    expect(resolvePkgDir(npm, () => true)).toBe(npm);
  });
});

// ── #495: a pid in daemon.json is a number, not a process ──────────────────
/** An OS identity from an argv (or a `ps`-style joined command line). */
const ident = (argv: string[] | string, extra: Partial<ProcessIdentity> = {}): ProcessIdentity => {
  const a = Array.isArray(argv) ? argv : argv.trim().split(/\s+/);
  return { argv: a, command: a.join(" "), ...extra };
};
const linux = process.platform === "linux";

describe("verifyDaemonPid (#495)", () => {
  const entry = "/home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts";
  const daemonArgv = ["/usr/bin/node", "--import", "tsx", entry];
  const daemonCmd = daemonArgv.join(" ");

  test("legacy rule: a joy-daemon/ path segment on the script operand, nothing else", () => {
    expect(looksLikeJoyDaemon(daemonArgv)).toBe(true);
    expect(looksLikeJoyDaemon(daemonCmd)).toBe(true); // macOS ps: joined
    expect(looksLikeJoyDaemon("node --import tsx /w/joy/packages/joy-daemon/src/server.ts")).toBe(true);
    expect(looksLikeJoyDaemon("/usr/bin/vim notes.txt")).toBe(false);
    expect(looksLikeJoyDaemon("node server.ts")).toBe(false);            // some other server.ts, not ours
    expect(looksLikeJoyDaemon(["bash", "-c", "echo joy-daemon server.tsx"])).toBe(false);
    expect(looksLikeJoyDaemon([])).toBe(false);
    // "server.ts and tsx" is not Joy: an unrelated tsx app must never be
    // signalled on the strength of a stale daemon.json (Astra on 53d22103).
    expect(looksLikeJoyDaemon("node --import tsx /home/u/unrelated/server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("/usr/bin/node /home/u/node_modules/tsx/dist/cli.mjs server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("node --import tsx /home/u/joy-daemon-notes/server.ts")).toBe(false); // segment, not substring
  });

  test("serverEntryOf: the script is the first operand after node's options — its ROLE, not its occurrence", () => {
    expect(serverEntryOf(daemonArgv)).toBe(entry);
    expect(serverEntryOf("node --import tsx src/server.ts")).toBe("src/server.ts");
    expect(serverEntryOf(["node", "--import=tsx", entry])).toBe(entry);           // --flag=value carries its value
    expect(serverEntryOf(["node", "--", entry])).toBe(entry);                      // `--` ends the options
    expect(serverEntryOf("node --import tsx /x/server.tsx")).toBeNull();
    expect(serverEntryOf("vim notes.txt")).toBeNull();
    // our path as a trailing ARGUMENT to another program (Astra on 6d994569)
    expect(serverEntryOf(["/usr/bin/python3", "/home/u/unrelated.py", entry])).toBeNull();
    expect(serverEntryOf(["node", "/home/u/other.js", entry])).toBeNull();
  });

  test("serverEntryOf: node -e / -p / stdin / REPL run inline code, not a script — our path after them is that program's data (Astra on 1e11fd5f)", () => {
    expect(serverEntryOf(["node", "-e", "setInterval(() => {}, 1000)", entry])).toBeNull();
    expect(serverEntryOf(["node", "--eval", "setInterval(() => {}, 1000)", entry])).toBeNull();
    expect(serverEntryOf(["node", `--eval=setInterval(() => {}, 1000)`, entry])).toBeNull();
    expect(serverEntryOf(["node", "--import", "tsx", "-e", "1", entry])).toBeNull();
    expect(serverEntryOf(["node", "-p", "1", entry])).toBeNull();
    expect(serverEntryOf(["node", "-", entry])).toBeNull();
    expect(serverEntryOf(["node", "-i", entry])).toBeNull();
    expect(serverEntryOf(["node", "--check", entry])).toBeNull(); // syntax-checked, not run
  });

  test("serverEntryOf: OS argv boundaries survive — a loader path with a space is one argument (Astra on 1e11fd5f)", () => {
    const argv = ["/usr/bin/node", "--import", "/home/u/My Tools/tsx.mjs", entry];
    expect(serverEntryOf(argv)).toBe(entry);
    // flattened to a string the same command misparses: that is why the
    // kernel's argv, not a joined command line, is what gets verified on Linux
    expect(serverEntryOf(argv.join(" "))).toBeNull();
  });

  test("execMatches: the kernel's exe is authoritative; argv[0] is resolved through PATH; no evidence is NOT a match", () => {
    const node = process.execPath;
    expect(execMatches(ident(["node"], { exe: node }), node)).toBe(true);
    expect(execMatches(ident([node], { exe: "/usr/bin/python3" }), node)).toBe(false); // kernel beats argv[0]
    expect(execMatches(ident([node]), node)).toBe(true);
    expect(execMatches(ident(["/usr/bin/python3"]), node)).toBe(false);
    expect(execMatches(ident(["no-such-binary-495"]), node)).toBeNull();
    expect(execMatches(ident([]), node)).toBeNull();
    expect(execMatches(ident(["anything"]), undefined)).toBe(true); // legacy record: nothing recorded to compare
  });

  describe("with a recorded start identity (daemon.json startId)", () => {
    const startId = "linux:4772d6e9-boot:450459409";
    const rec = { startedAt: Date.now(), startId, entry, exec: "/usr/bin/node" };
    const live = (extra: Partial<ProcessIdentity> = {}) => ident(daemonArgv, { startId, exe: "/usr/bin/node", ...extra });

    test("the live pid's start identity must EQUAL the recorded one — a different start is a reused pid, stale", () => {
      const v = verifyDaemonPid(4242, rec, live({ startId: "linux:4772d6e9-boot:450459999" }));
      expect(v).toMatchObject({ ok: false, stale: true });
      if (!v.ok) expect(v.reason).toMatch(/^stale pid: .*reused/);
      // ...even across a reboot (same tick count, another boot id)
      expect(verifyDaemonPid(4242, rec, live({ startId: "linux:other-boot:450459409" }))).toMatchObject({ ok: false, stale: true });
      // a 120 s skew on startedAt is NOT the fence any more: same wall-clock, different start identity → stale
      expect(verifyDaemonPid(4242, rec, live({ startId: "linux:4772d6e9-boot:450459410", startedAt: rec.startedAt }))).toMatchObject({ ok: false, stale: true });
    });

    test("no start identity from the OS: unverifiable (the record stays), never a signal", () => {
      const v = verifyDaemonPid(4242, rec, live({ startId: undefined }));
      expect(v).toMatchObject({ ok: false, stale: false });
    });

    test("same start identity but the process is not our daemon: stale", () => {
      // pid reused by an unrelated program
      expect(verifyDaemonPid(4242, rec, ident(["sleep", "300"], { startId, exe: "/usr/bin/sleep" }))).toMatchObject({ ok: false, stale: true });
      // node -e with our server.ts as data
      expect(verifyDaemonPid(4242, rec, ident(["/usr/bin/node", "-e", "setInterval(()=>{},1e3)", entry], { startId, exe: "/usr/bin/node" }))).toMatchObject({ ok: false, stale: true });
      // an unrelated tsx server.ts, a joy-daemon from ANOTHER install
      expect(verifyDaemonPid(4242, rec, ident(["/usr/bin/node", "--import", "tsx", "/home/u/unrelated/server.ts"], { startId, exe: "/usr/bin/node" }))).toMatchObject({ ok: false, stale: true });
      expect(verifyDaemonPid(4242, rec, ident(["/usr/bin/node", "--import", "tsx", "/opt/joy/packages/joy-daemon/src/server.ts"], { startId, exe: "/usr/bin/node" }))).toMatchObject({ ok: false, stale: true });
      // right script, different binary
      expect(verifyDaemonPid(4242, rec, live({ exe: "/usr/bin/python3" }))).toMatchObject({ ok: false, stale: true });
    });

    test("the recorded daemon passes: exact start identity, exact entry, matching binary", () => {
      expect(verifyDaemonPid(4242, rec, live())).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, rec, live({ startedAt: rec.startedAt - 3_600_000 }))).toEqual({ ok: true }); // startedAt is not consulted once the exact identity matches
      // a loader path with a space, from the kernel's argv
      expect(verifyDaemonPid(4242, rec, ident(["/usr/bin/node", "--import", "/home/u/My Tools/tsx.mjs", entry], { startId, exe: "/usr/bin/node" }))).toEqual({ ok: true });
      // a relative operand resolved against the process cwd
      const r = { ...rec, entry: "/w/joy/packages/joy-daemon/src/server.ts" };
      expect(verifyDaemonPid(4242, r, ident(["node", "--import", "tsx", "src/server.ts"], { startId, exe: "/usr/bin/node", cwd: "/w/joy/packages/joy-daemon" }))).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, r, ident(["node", "--import", "tsx", "src/server.ts"], { startId, exe: "/usr/bin/node" }))).toMatchObject({ ok: false, stale: true }); // no cwd to resolve it against
      // macOS: no kernel exe and a bare `node` that PATH cannot resolve — the exact start identity carries a NEW record
      expect(verifyDaemonPid(4242, rec, ident(["node-495-unresolvable", "--import", "tsx", entry], { startId: "darwin:Sun Sep  6 10:00:00 2026" }))).toMatchObject({ ok: false, stale: true });
      expect(verifyDaemonPid(4242, { ...rec, startId: "darwin:Sun Sep  6 10:00:00 2026" }, ident(["node-495-unresolvable", "--import", "tsx", entry], { startId: "darwin:Sun Sep  6 10:00:00 2026" }))).toEqual({ ok: true });
    });
  });

  describe("legacy daemon.json (no startId)", () => {
    const t = Date.now();

    test("with entry/exec: exact entry required; an unresolvable executable is unverifiable, not a pass (Astra on 1e11fd5f)", () => {
      const rec = { startedAt: t, entry, exec: "/usr/bin/node" };
      expect(verifyDaemonPid(4242, rec, ident("/usr/bin/node --import tsx /home/u/unrelated/server.ts", { startedAt: t - 1_000 }))).toMatchObject({ ok: false, stale: true });
      expect(verifyDaemonPid(4242, rec, ident(daemonArgv, { exe: "/usr/bin/node", startedAt: t - 3_000 }))).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, rec, ident(["node-495-unresolvable", "--import", "tsx", entry], { startedAt: t - 3_000 }))).toMatchObject({ ok: false, stale: false });
      expect(verifyDaemonPid(4242, { startedAt: t - 3_600_000, entry, exec: "/usr/bin/node" }, ident(daemonArgv, { exe: "/usr/bin/node", startedAt: t }))).toMatchObject({ ok: false, stale: true });
    });

    test("without entry: the joy-daemon/ segment rule and the startedAt skew", () => {
      expect(verifyDaemonPid(4242, { startedAt: t }, ident("node --import tsx /home/u/unrelated/server.ts", { startedAt: t }))).toMatchObject({ ok: false, stale: true });
      expect(verifyDaemonPid(4242, { startedAt: t }, ident(daemonArgv, { startedAt: t - 3_000 }))).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, { startedAt: t }, ident(daemonArgv))).toEqual({ ok: true }); // macOS ps: no start time
      expect(verifyDaemonPid(4242, {}, ident(daemonArgv, { startedAt: t }))).toEqual({ ok: true });
      const v = verifyDaemonPid(4242, { startedAt: t }, ident(["/usr/bin/vim", "notes.txt"]));
      expect(v).toMatchObject({ ok: false, stale: true });
      if (!v.ok) expect(v.reason).toContain("not a joy-daemon");
      const reused = verifyDaemonPid(4242, { startedAt: t - 3_600_000 }, ident(daemonArgv, { startedAt: t }));
      expect(reused).toMatchObject({ ok: false, stale: true });
      if (!reused.ok) expect(reused.reason).toContain("reused");
    });

    test("a pid that no longer exists is stale", () => {
      expect(verifyDaemonPid(4242, { startedAt: t }, null)).toMatchObject({ ok: false, stale: true });
    });
  });

  test.runIf(linux)("processIdentity + processStartId read the kernel: a live process's argv (boundaries intact), exe and start identity", async () => {
    // Not this process: vitest rewrites its own title, and on Linux that
    // overwrites /proc/self/cmdline. A child node instead of `sleep`: the
    // spaced operand that proves argv boundaries survive is an invalid
    // interval to sleep, which exits 1 at once — the pid was then a zombie
    // (empty cmdline, no exe link) whenever the read lost the race. Node
    // parks the extra operand in process.argv and stays up.
    const argv = [process.execPath, "-e", "setTimeout(() => {}, 300_000)", "two words"];
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
    await once(child, "spawn"); // exec has happened: /proc/<pid>/{cmdline,exe} are the child's
    try {
      const it = processIdentity(child.pid!)!;
      expect(it).not.toBeNull();
      expect(readFileSync(`/proc/${child.pid}/stat`, "utf8")).not.toMatch(/\) Z /); // the fixture is alive, not a zombie
      expect(it.argv).toEqual(argv);
      expect(it.exe && realpathSync(it.exe)).toBe(realpathSync(process.execPath));
      expect(it.startId).toMatch(/^linux:[0-9a-f-]+:\d+$/);
      expect(it.startId).toBe(processStartId(child.pid!));
      expect(it.startedAt).toBeGreaterThan(Date.now() - 60_000);
    } finally { child.kill("SIGKILL"); }
    expect(processIdentity(2 ** 22 - 1)).toBeNull(); // pid_max: nothing there
    expect(processStartId(2 ** 22 - 1)).toBeNull();
  });
});

describe("joy stop never signals a pid that is not the daemon (#495, live processes)", () => {
  const stateFile = () => join(joyStateDir(), "daemon.json");
  const record = (pid: number, extra: Record<string, unknown>) => writeFileSync(stateFile(), JSON.stringify({ token: "tok", pid, port: daemonPort, startedAt: Date.now(), version: "test", launcher: "detached", ...extra }));
  /** A `joy stop` with the unit inactive (no supervisor) — the direct-signal path. */
  const unsupervised = (killed: [number, string][]) => ({ platform: "linux", run: (cmd: string, args: string[]) => cmd === "systemctl" && args.includes("show") ? { status: 0, stdout: "MainPID=0\n" } : { status: 1, stdout: "" }, kill: (pid: number, sig: string) => { killed.push([pid, sig]); } });
  const children: ChildProcess[] = [];
  const spawned = async (cmd: string, args: string[], cwd?: string): Promise<ChildProcess> => {
    const child = spawn(cmd, args, { stdio: "ignore", cwd });
    children.push(child);
    await once(child, "spawn"); // exec has happened: /proc/<pid>/cmdline is the child's, not ours
    return child;
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  afterAll(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } } });

  test.runIf(linux)("(a) the recorded pid was reused by an unrelated live process (different start identity): stale pid, exit 1, no signal", async () => {
    const sleep = await spawned("sleep", ["300"]);
    const pid = sleep.pid!;
    record(pid, { startId: "linux:some-earlier-boot:1", entry: "/x/joy-daemon/src/server.ts", exec: process.execPath });
    const killed: [number, string][] = [];
    expect(await cmdStop(unsupervised(killed))).toBe(1);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toMatch(/stale pid: pid \d+ started at a different time .* reused/);
    expect(existsSync(stateFile())).toBe(false); // the stale record is gone…
    expect(alive(pid)).toBe(true);               // …and the stranger is untouched
  });

  test.runIf(linux)("(b) same pid, same start identity, but the process is not a daemon: no signal, exit 1", async () => {
    const sleep = await spawned("sleep", ["300"]);
    const pid = sleep.pid!;
    record(pid, { startId: processStartId(pid), entry: "/x/joy-daemon/src/server.ts", exec: process.execPath });
    const killed: [number, string][] = [];
    expect(await cmdStop(unsupervised(killed))).toBe(1);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toMatch(/stale pid: pid \d+ is not the daemon daemon.json records/);
    expect(alive(pid)).toBe(true);
    // a LEGACY record (no startId/entry) pointing at the same sleep: the command-line rule refuses it
    log.out.length = 0;
    record(pid, {});
    expect(await cmdStop(unsupervised(killed))).toBe(1);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toMatch(/stale pid: pid \d+ is not a joy-daemon/);
    expect(alive(pid)).toBe(true);
  });

  test.runIf(linux)("(c) a genuine daemon record — exact start identity, entry and binary — gets SIGTERM (and a supervised one goes through systemctl)", async () => {
    // A stand-in daemon with the real command shape: node --import tsx <…/joy-daemon/src/server.ts>
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const fakeHome = mkdtempSync(join(tmpdir(), "joy-495-"));
    const entry = join(fakeHome, "node_modules", "@fny", "joy-daemon", "src", "server.ts");
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "setInterval(() => {}, 60_000);\n");
    const child = await spawned(process.execPath, ["--import", "tsx", entry], pkgDir);
    const pid = child.pid!;
    // what server.ts records about itself at launch
    const genuine = { startId: processStartId(pid), entry, exec: process.execPath };
    expect(genuine.startId).toMatch(/^linux:/);
    // sanity: the kernel identity of the stand-in verifies against its record
    expect(verifyDaemonPid(pid, genuine, processIdentity(pid))).toEqual({ ok: true });

    record(pid, genuine);
    const killed: [number, string][] = [];
    expect(await cmdStop(unsupervised(killed))).toBe(0); // the fake daemon has no /status route: "stopped" once probe stays silent
    expect(killed).toEqual([[pid, "SIGTERM"]]);
    expect(log.out.join("\n")).toContain(`stopped (pid ${pid})`);

    // #502 path unchanged: the unit owns the pid → systemctl stop, no direct signal
    log.out.length = 0;
    record(pid, genuine);
    const direct: [number, string][] = []; let stopped = false;
    const run = (cmd: string, args: string[]) => {
      if (cmd === "systemctl" && args.includes("show")) return { status: 0, stdout: `MainPID=${pid}\n` };
      if (cmd === "systemctl" && args.includes("stop")) { stopped = true; return { status: 0, stdout: "" }; }
      return { status: 1, stdout: "" };
    };
    expect(await cmdStop({ platform: "linux", run, kill: (p, s) => { direct.push([p, s]); } })).toBe(0);
    expect(stopped).toBe(true);
    expect(direct).toEqual([]);
    expect(log.out.join("\n")).toContain("via systemctl --user stop joy-daemon.service");

    // the same record after the stand-in has exited and its pid is (simulated) taken by a sleep: stale, no signal
    child.kill("SIGKILL"); await once(child, "exit");
    const sleep = await spawned("sleep", ["300"]);
    record(sleep.pid!, genuine); // the record still describes the daemon; the pid now belongs to `sleep`
    const late: [number, string][] = [];
    expect(await cmdStop(unsupervised(late))).toBe(1);
    expect(late).toEqual([]);
    expect(log.out.join("\n")).toMatch(/stale pid/);
    expect(alive(sleep.pid!)).toBe(true);
  });

  test("a dead pid in daemon.json is just 'not running': the record is cleaned up, exit 0", async () => {
    record(2 ** 22 - 1, { startId: "linux:x:1", entry: "/x/joy-daemon/src/server.ts" });
    const killed: [number, string][] = [];
    expect(await cmdStop(unsupervised(killed))).toBe(0);
    expect(killed).toEqual([]);
    expect(log.out.join("\n")).toContain("not running");
    expect(existsSync(stateFile())).toBe(false);
  });
});

