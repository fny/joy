// CLI helpers that decide WHAT to launch and WHAT to signal. Pure functions
// exported from cli.ts; the module's main() is gated off under vitest.
import { test, expect, describe, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as http from "node:http";

// Isolate every path the module computes at import time from the real ~/.joy.
process.env.JOY_HOME_DIR = mkdtempSync(join(tmpdir(), "joy-cli-test-"));
delete process.env.JOY_SESSION_ID;
const { resolvePkgDir, looksLikeJoyDaemon, verifyDaemonPid, serverEntryOf, systemdUnit, detectSupervisor, cmdStop, cmdNew, cmdAsk, cmdWaitIdle } = await import("./cli");
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
    if (cmd === "systemctl" && args.includes("show")) return { status: 0, stdout: `${mainPid}\n` };
    if (cmd === "systemctl" && args.includes("stop")) { onStop(); return { status: 0, stdout: "" }; }
    return { status: 1, stdout: "" };
  };

  test("detectSupervisor: systemd owns the pid only when the unit's MainPID IS the daemon; launchd via its job PID", () => {
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("4242", () => {}) })).toEqual({ kind: "systemd", unit: "joy-daemon.service" });
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("0", () => {}) })).toBeNull();     // unit inactive / not installed
    expect(detectSupervisor(4242, { platform: "linux", run: fakeRun("999", () => {}) })).toBeNull();   // some other daemon under the unit
    expect(detectSupervisor(4242, { platform: "linux", run: () => ({ status: 1, stdout: "" }) })).toBeNull(); // no systemctl
    const launchd = (out: string, status = 0) => ({ platform: "darwin", run: () => ({ status, stdout: out }) });
    expect(detectSupervisor(4242, launchd('{\n\t"PID" = 4242;\n\t"Label" = "vip.faraz.joy-daemon";\n};'))?.kind).toBe("launchd");
    expect(detectSupervisor(4242, launchd('{\n\t"Label" = "vip.faraz.joy-daemon";\n};'))).toBeNull(); // loaded, not running
    expect(detectSupervisor(4242, launchd("", 113))).toBeNull(); // not loaded
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
    const run = (cmd: string, args: string[]) => args.includes("show") ? { status: 0, stdout: "4242\n" } : { status: 5, stdout: "" };
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
 *  `push` feeds it live. `onConnect` can take over a connection (returns true when it did). */
const eventsRoute = (initial: unknown[] = [], opts: { onConnect?: (n: number, res: http.ServerResponse, after: number) => boolean } = {}) => {
  const log: { seq: number }[] = [...(initial as { seq: number }[])];
  const open = new Set<http.ServerResponse>();
  let n = 0;
  route(`GET /sessions/${SID}/events`, (_q, res, url) => {
    n++;
    const after = Number(url.searchParams.get("after") ?? 0);
    if (opts.onConnect?.(n, res, after)) return;
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const hello = { hello: true, seq: log.length ? log[log.length - 1].seq : 0 };
    if (url.searchParams.has("last")) { res.end(ndjson([hello])); return; }
    res.write(ndjson([hello, ...log.filter((r) => r.seq > after)]));
    if (url.searchParams.get("follow") === "1") { open.add(res); hanging.add(res); res.on("close", () => open.delete(res)); } else res.end();
  });
  return { push: (r: { seq: number }) => { log.push(r); for (const res of open) res.write(ndjson([r])); }, connections: () => n };
};
const checkRoute = (h: (n: number) => unknown | Handler) => { let n = 0; route(`GET /sessions/${SID}/check`, (q, res, url, body) => { const v = h(++n); return typeof v === "function" ? (v as Handler)(q, res, url, body) : json(res, 200, v); }); };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("joy new -m: a rejected first message fails the command (#494)", () => {
  test("the daemon refuses the send (500): exit 1, the id is still printed, retry guidance on stderr", async () => {
    route("POST /sessions", (_q, res) => json(res, 201, { id: SID, cwd: "/tmp/x" }));
    eventsRoute();
    route("POST /send", (_q, res) => json(res, 500, { error: "not_durable" }));
    expect(await cmdNew(["/tmp/x", "-m", "do work"])).toBe(1);
    expect(log.out).toEqual([SID]);
    expect(log.err.join("\n")).toMatch(/first message was not accepted — retry with: joy send abcdef01 "do work"/);
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
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: null }); setTimeout(() => ev.push(agentText(1, "part one")), 30); });
    checkRoute((n) => (n < 3 ? { state: "busy" } : { state: "idle" }));
    setTimeout(() => { for (const r of hanging) r.destroy(); hanging.clear(); }, 100); // the follow socket dies after "part one"
    expect(await cmdAsk([SID, "hello", "--no-queue"])).toBe(1);
    expect(log.err.join("\n")).toMatch(/output stream lost after seq 1 .* the reply is incomplete/);
  });

  test("the stream drops and is resumed from the last consumed seq: the whole reply, exit 0", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: null }); setTimeout(() => ev.push(agentText(1, "part one")), 30); });
    setTimeout(() => { for (const r of hanging) r.destroy(); hanging.clear(); }, 100); // kill the first follow stream
    setTimeout(() => ev.push(agentText(2, "part two")), 160);                        // landed while disconnected
    checkRoute((n) => (n < 3 ? { state: "busy" } : { state: "idle" }));
    expect(await cmdAsk([SID, "hello", "--no-queue"])).toBe(0);
    expect(log.out).toEqual(["part one\n\npart two"]);
    expect(ev.connections()).toBeGreaterThan(1);
  });
});

describe("a queued ask's reply is its own turn, not the tail of the previous one (#498)", () => {
  test("B queued behind A: A's remaining answer is excluded, B's is returned", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    let dispatched = false;
    route("POST /send", (_q, res) => {
      json(res, 200, { ok: true, queued_id: "q2" });
      // A is still answering after B was queued; then the daemon dispatches B
      // (mirrors its prompt as a user row) and B answers.
      void (async () => {
        await delay(50); ev.push(agentText(1, "A's tail", "a"));
        await delay(50); dispatched = true;
        ev.push(userRow(2, '<joy-message from="cli">\nwhat is B\n</joy-message>'));
        ev.push(turnStart(3, "b"));
        await delay(50); ev.push(agentText(4, "B's answer", "b"));
      })();
    });
    route(`GET /sessions/${SID}/queue`, (_q, res) => json(res, 200, { items: dispatched ? [] : [{ id: "q2", text: "what is B" }] }));
    checkRoute(() => ({ state: ev.connections() && dispatched ? "idle" : "busy" }));
    expect(await cmdAsk([SID, "what", "is", "B"])).toBe(0);
    expect(log.out).toEqual(["B's answer"]);
  });

  test("no mirrored user row (an adapter that does not echo the prompt): the dispatch moment is the boundary", async () => {
    sessionsRoute();
    const ev = eventsRoute([]);
    let polls = 0;
    route("POST /send", (_q, res) => { json(res, 200, { ok: true, queued_id: "q2" }); setTimeout(() => ev.push(agentText(1, "A's tail", "a")), 30); });
    route(`GET /sessions/${SID}/queue`, (_q, res) => {
      polls++;
      if (polls >= 2) setTimeout(() => ev.push(agentText(2, "B's answer", "b")), 30);
      json(res, 200, { items: polls >= 2 ? [] : [{ id: "q2" }] });
    });
    checkRoute(() => ({ state: polls >= 2 ? "idle" : "busy" }));
    expect(await cmdAsk([SID, "what", "is", "B"])).toBe(0);
    expect(log.out).toEqual(["B's answer"]);
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

describe("verifyDaemonPid (#495)", () => {
  const daemonCmd = "/usr/bin/node --import tsx /home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts";

  test("recognizes the daemon's command line and nothing else (legacy rule: a joy-daemon/ path segment)", () => {
    expect(looksLikeJoyDaemon(daemonCmd)).toBe(true);
    expect(looksLikeJoyDaemon("node --import tsx /w/joy/packages/joy-daemon/src/server.ts")).toBe(true);
    expect(looksLikeJoyDaemon("/usr/bin/vim notes.txt")).toBe(false);
    expect(looksLikeJoyDaemon("node server.ts")).toBe(false);            // some other server.ts, not ours
    expect(looksLikeJoyDaemon("bash -c 'echo joy-daemon server.tsx'")).toBe(false);
    expect(looksLikeJoyDaemon("")).toBe(false);
    // #495 residual (Astra): "server.ts and tsx" is not Joy. An unrelated tsx
    // app must never be signalled on the strength of a stale daemon.json.
    expect(looksLikeJoyDaemon("node --import tsx /home/u/unrelated/server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("/usr/bin/node /home/u/node_modules/tsx/dist/cli.mjs server.ts")).toBe(false);
    expect(looksLikeJoyDaemon("node --import tsx /home/u/joy-daemon-notes/server.ts")).toBe(false); // segment, not substring
  });

  test("serverEntryOf picks the script operand", () => {
    expect(serverEntryOf(daemonCmd)).toBe("/home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts");
    expect(serverEntryOf("node --import tsx src/server.ts")).toBe("src/server.ts");
    expect(serverEntryOf("node --import tsx /x/server.tsx")).toBeNull();
    expect(serverEntryOf("vim notes.txt")).toBeNull();
  });

  describe("with the recorded entry (#495 residual)", () => {
    const entry = "/home/u/.local/share/pnpm/global/5/node_modules/@fny/joy-daemon/src/server.ts";
    const t = Date.now();

    test("the exact recorded entry path is required — an unrelated tsx server.ts is stale, even with tsx and a matching start time", () => {
      const v = verifyDaemonPid(4242, { startedAt: t, entry }, { command: "/usr/bin/node --import tsx /home/u/unrelated/server.ts", startedAt: t - 1_000 });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/not the daemon daemon.json records/);
      // ...and so is a real joy-daemon from ANOTHER install (a different file).
      const other = verifyDaemonPid(4242, { startedAt: t, entry }, { command: "/usr/bin/node --import tsx /opt/joy/packages/joy-daemon/src/server.ts", startedAt: t - 1_000 });
      expect(other.ok).toBe(false);
      // no kernel start time at all (macOS): the entry check alone still refuses
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: "node --import tsx /home/u/unrelated/server.ts" }).ok).toBe(false);
    });

    test("the recorded daemon passes: exact entry, and a relative operand resolved against the process cwd", () => {
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: `/usr/bin/node --import tsx ${entry}`, startedAt: t - 3_000 })).toEqual({ ok: true });
      expect(verifyDaemonPid(4242, { startedAt: t, entry }, { command: `/usr/bin/node --import tsx ${entry}` })).toEqual({ ok: true }); // macOS: no start time
      expect(verifyDaemonPid(4242, { startedAt: t, entry: "/w/joy/packages/joy-daemon/src/server.ts" }, { command: "node --import tsx src/server.ts", cwd: "/w/joy/packages/joy-daemon" })).toEqual({ ok: true });
      // a relative operand with no cwd to resolve it against cannot be confirmed
      expect(verifyDaemonPid(4242, { startedAt: t, entry: "/w/joy/packages/joy-daemon/src/server.ts" }, { command: "node --import tsx src/server.ts" }).ok).toBe(false);
    });

    test("the start-time check still applies on top of the entry match", () => {
      const v = verifyDaemonPid(4242, { startedAt: t - 3_600_000, entry }, { command: `/usr/bin/node --import tsx ${entry}`, startedAt: t });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain("reused pid");
    });

    test("legacy daemon.json without entry: the joy-daemon/ segment rule, never tsx alone", () => {
      expect(verifyDaemonPid(4242, { startedAt: t }, { command: "node --import tsx /home/u/unrelated/server.ts", startedAt: t }).ok).toBe(false);
      expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd, startedAt: t })).toEqual({ ok: true });
    });
  });

  test("a reused pid running something else is stale — never signalled", () => {
    const v = verifyDaemonPid(4242, { startedAt: Date.now() }, { command: "/usr/bin/vim notes.txt" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("not a joy-daemon");
  });

  test("a pid that no longer exists is stale", () => {
    const v = verifyDaemonPid(4242, { startedAt: Date.now() }, null);
    expect(v.ok).toBe(false);
  });

  test("the daemon daemon.json describes: same command, start time within skew", () => {
    const t = Date.now();
    expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd, startedAt: t - 3_000 })).toEqual({ ok: true });
    // no kernel start time available (macOS ps): the command line decides
    expect(verifyDaemonPid(4242, { startedAt: t }, { command: daemonCmd })).toEqual({ ok: true });
    // legacy daemon.json without startedAt: the command line decides
    expect(verifyDaemonPid(4242, {}, { command: daemonCmd, startedAt: t })).toEqual({ ok: true });
  });

  test("another joy daemon that inherited the pid later is NOT the recorded one", () => {
    const t = Date.now();
    const v = verifyDaemonPid(4242, { startedAt: t - 3_600_000 }, { command: daemonCmd, startedAt: t });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("reused pid");
  });
});
