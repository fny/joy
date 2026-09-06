// #561: a codex session created with extraArgs (`-c key=value` overrides —
// a custom model_provider, say) must be restarted with the SAME overrides:
// the in-place restart read the persisted codexSettings but never handed the
// config to the replacement, so the new app-server ran on different defaults
// and then overwrote the saved config with nothing. Both restart shapes are
// covered: a live session, and a daemon-forgotten one (record only). The tmux
// driver and the app-server client are fakes; every spawn's options are
// captured. Runs against a throwaway JOY_HOME_DIR.
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ok = { ok: true, out: "" };

vi.mock("../tmux/driver", async () => {
  const fake = {
    runSync: (...args: string[]) => (args[0] === "has-session" ? { ok: false, out: "" } : ok),
    command: async () => ok,
    commandOnce: async () => ok,
    key: async () => ok,
    literal: async () => ok,
    captureFresh: async () => ok,
    captureCached: () => ok,
    track() {}, untrack() {},
    dispose: () => {},
  };
  return { tmux: fake, tmuxHandleFor: () => fake, disposeTmuxHandle: () => {}, TmuxDriver: class {} };
});

const H = vi.hoisted(() => ({ spawns: [] as Array<{ socketPath: string; config?: Record<string, string> }> }));

vi.mock("../codex/appServerClient", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../codex/appServerClient")>();
  const { EventEmitter } = await import("node:events");
  class FakeClient {
    onNotification() {}
    onServerRequest() {}
    onClose() {}
    resolveServerRequestExternally() {}
    async connect() { return {}; }
    async threadStart() { return { threadId: "TH", rolloutPath: null, model: null }; }
    async threadResume(threadId: string) { return { threadId, model: null, reasoningEffort: null }; }
    async threadRead() { return { thread: { id: "TH", turns: [] } }; }
    async turnStart() { return { turnId: "T1" }; }
    async turnInterrupt() {}
    close() {}
  }
  const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, stderr: null, kill() { return true; } });
  return { ...orig, CodexAppServerClient: FakeClient as any, spawnCodexAppServer: vi.fn((opts: { socketPath: string; config?: Record<string, string> }) => { H.spawns.push(opts); return fakeProc(); }) };
});

let home: string;
let cwd: string;
const realHome = process.env.JOY_HOME_DIR;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "joy-registry-codex-restart-"));
  cwd = join(home, "project"); fs.mkdirSync(cwd);
  process.env.JOY_HOME_DIR = home;
  H.spawns.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); if (realHome === undefined) delete process.env.JOY_HOME_DIR; else process.env.JOY_HOME_DIR = realHome; rmSync(home, { recursive: true, force: true }); });

test("#561: a codex restart carries the session's config overrides — live session, then a record-only (daemon-forgotten) one", async () => {
  const { SessionRegistry } = await import("./registry");
  const { loadWindowRecord } = await import("./windowRecord");
  const overrides = { model_provider: "custom", model: "gpt-x" };
  const reg = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  const s1 = await reg.create({ agent: "codex", cwd, extraArgs: 'model_provider=custom model="gpt-x"', permissionMode: "bypassPermissions" });
  await vi.waitFor(() => expect(s1.status).toBe("active"));
  expect(H.spawns).toHaveLength(1);
  expect(H.spawns[0].config).toEqual(overrides);
  expect(loadWindowRecord(s1.id)?.codexSettings?.config).toEqual(overrides);

  // In-place restart of the LIVE session: the replacement launches with the same overrides.
  const s2 = await reg.restart({ id: s1.id });
  await vi.waitFor(() => expect(s2.status).toBe("active"));
  expect(s2).not.toBe(s1);
  expect(H.spawns).toHaveLength(2);
  expect(H.spawns[1].config).toEqual(overrides);
  expect(loadWindowRecord(s1.id)?.codexSettings).toMatchObject({ config: overrides, permissionMode: "bypassPermissions" });

  // The daemon forgot the session (a new registry, the record survives):
  // restart from the record carries them too.
  s2.end("process_exited");
  const reg2 = new SessionRegistry({ tmuxSession: "joy-test", relayClient: null });
  const s3 = await reg2.restart({ id: s1.id });
  await vi.waitFor(() => expect(s3.status).toBe("active"));
  expect(H.spawns).toHaveLength(3);
  expect(H.spawns[2].config).toEqual(overrides);
  expect(loadWindowRecord(s1.id)?.codexSettings?.config).toEqual(overrides);
  s3.end("killed");
}, 20_000);
