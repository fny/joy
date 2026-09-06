// Wave A2 op-level contracts: local send/queueAdd acknowledge only after a
// durable spool (#551), a conditional kill never lands on a session whose
// status moved (#174), and git-URL clones are serialized + attempt-owned so a
// failed clone can never delete a successful working copy (#547).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { machineOps, cloneForSpawn } from "./operations";

const op = (name: string) => machineOps.find((o) => o.rpcName === name)!;

/** A minimal fake session: enqueue succeeds or throws per `durable`. */
function fakeSession(id: string, o: { durable: boolean; status?: "starting" | "active" | "ended" } = { durable: true }) {
  const calls: Array<{ text: string; opts: unknown }> = [];
  const s = {
    id, cwd: "/tmp/x", status: o.status ?? "active", claudeSessionId: "sid",
    agentFlavor: "claude", summary: undefined, currentModel: undefined, model: undefined,
    busy: () => false,
    detectPermissionMode: () => "bypassPermissions",
    enqueue(text: string, opts: { requireDurable?: boolean }) {
      calls.push({ text, opts });
      if (!o.durable && opts?.requireDurable) throw new Error("queue spool write failed — message not durably staged");
      return { id: "q1", text, createdAt: 1 };
    },
    queueState: () => ({ pendingCount: calls.length, items: [] }),
    killed: [] as string[],
    end(reason: string) { this.killed.push(`end:${reason}`); return true; },
    forceKill() { this.killed.push("forceKill"); return true; },
    awaitArchive: async () => true,
  };
  return { s, calls };
}
function fakeRegistry(s: unknown) {
  const chat: unknown[] = [];
  return {
    reg: { get: (id: string) => (id === (s as { id: string }).id ? s : undefined), nextChatId: () => 7, addChatMessage: (m: unknown) => { chat.push(m); } },
    chat,
  };
}

describe("send / queueAdd require a durable spool (#551)", () => {
  it("send: persistence failure → no acceptance, no chat-log row, not_durable", async () => {
    const { s, calls } = fakeSession("aaaa0001", { durable: false });
    const { reg, chat } = fakeRegistry(s);
    const r = (await op("joy-send").handler(reg as never, { session_id: "aaaa0001", text: "do the thing" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r.ok).toBeUndefined();
    expect(r.error).toBe("not_durable");
    expect(chat).toEqual([]); // nothing recorded as accepted
    expect(calls[0].opts).toMatchObject({ requireDurable: true });
    expect(op("joy-send").httpShape!(r).status).toBe(503);
  });

  it("send: durable spool → ok, chat row recorded once, requireDurable passed", async () => {
    const { s, calls } = fakeSession("aaaa0002", { durable: true });
    const { reg, chat } = fakeRegistry(s);
    const r = (await op("joy-send").handler(reg as never, { session_id: "aaaa0002", text: "hello" }, { via: "http" })) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, chat_id: 7, queued_id: "q1" });
    expect(chat).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ requireDurable: true, mirrorToRelay: true, visible: true, source: "web" });
  });

  it("queueAdd: persistence failure → not_durable (503), success passes requireDurable", async () => {
    const bad = fakeSession("aaaa0003", { durable: false });
    const r1 = (await op("joy-queue-add").handler(fakeRegistry(bad.s).reg as never, { id: "aaaa0003", text: "x" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r1.error).toBe("not_durable");
    expect(op("joy-queue-add").httpShape!(r1).status).toBe(503);
    const good = fakeSession("aaaa0004", { durable: true });
    const r2 = (await op("joy-queue-add").handler(fakeRegistry(good.s).reg as never, { id: "aaaa0004", text: "x" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r2).toMatchObject({ ok: true, id: "q1" });
    expect(good.calls[0].opts).toMatchObject({ requireDurable: true });
  });
});

describe("kill with ifStatus (#174)", () => {
  it("status moved between the app's decision and the kill → nothing happens, 409", async () => {
    const { s } = fakeSession("bbbb0001", { durable: true, status: "active" }); // restarted meanwhile
    const r = (await op("joy-kill-session").handler(fakeRegistry(s).reg as never, { id: "bbbb0001", ifStatus: "ended" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r).toEqual({ ok: false, error: "status_mismatch", status: "active" });
    expect(s.killed).toEqual([]);
    expect(op("joy-kill-session").httpShape!(r).status).toBe(409);
  });

  it("status matches → the kill proceeds (forceKill for an ended session)", async () => {
    const { s } = fakeSession("bbbb0002", { durable: true, status: "ended" });
    const r = (await op("joy-kill-session").handler(fakeRegistry(s).reg as never, { id: "bbbb0002", ifStatus: "ended" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r).toEqual({ ok: true });
    expect(s.killed).toEqual(["forceKill"]);
  });

  it("no ifStatus → unconditional, as before", async () => {
    const { s } = fakeSession("bbbb0003", { durable: true, status: "active" });
    const r = (await op("joy-kill-session").handler(fakeRegistry(s).reg as never, { id: "bbbb0003" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r).toEqual({ ok: true });
    expect(s.killed).toEqual(["end:killed"]);
  });
});

describe("cloneForSpawn (#547)", () => {
  let root: string;
  let origin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clone-spawn-"));
    // A local origin with one commit. `git clone <path>` needs no network.
    origin = join(root, "origin.git");
    mkdirSync(origin);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: origin, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    writeFileSync(join(origin, "README"), "hi\n");
    git("add", "README");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) delete process.env[k];
    rmSync(root, { recursive: true, force: true });
  });
  // The URL regex refuses bare paths, and git only clones https:// over the
  // network — so a regex-passing URL is rewritten to the local origin with a
  // git `url.<base>.insteadOf` config passed through the environment.
  const useLocalOrigin = () => Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${origin}.insteadOf`, GIT_CONFIG_VALUE_0: "https://local.test/origin" });

  it("rejects an invalid URL before touching the filesystem", async () => {
    await expect(cloneForSpawn("not a url", join(root, "dst"))).rejects.toThrow("invalid git url");
    expect(existsSync(join(root, "dst"))).toBe(false);
  });

  it("two concurrent creates for the same absent cwd: both succeed, one checkout, no leftovers", async () => {
    const dst = join(root, "work");
    useLocalOrigin();
    const [a, b] = await Promise.allSettled([
      cloneForSpawn("https://local.test/origin", dst),
      cloneForSpawn("https://local.test/origin", dst),
    ]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");
    expect(existsSync(join(dst, ".git"))).toBe(true);
    expect(existsSync(join(dst, "README"))).toBe(true);
    // No attempt-owned staging dir survives beside the target.
    expect(readdirSync(root).filter((f) => f.includes("joy-clone"))).toEqual([]);
  });

  it("a failed clone removes only its own staging dir — an existing checkout beside it is untouched", async () => {
    const dst = join(root, "work");
    useLocalOrigin();
    await cloneForSpawn("https://local.test/origin", dst);
    writeFileSync(join(dst, "WORK.txt"), "agent's uncommitted work");
    // Same destination, an origin that does not exist: with the OLD code this
    // failure's cleanup was `rmSync(dst, {recursive: true})`. Here the target
    // already has .git, so it is reused (no clone runs); either way nothing
    // under dst may be removed.
    await expect(cloneForSpawn("https://local.test/does-not-exist", dst)).resolves.toBeUndefined();
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
    // A failing clone into a FRESH target leaves nothing behind at all.
    const other = join(root, "other");
    await expect(cloneForSpawn("https://local.test/does-not-exist", other)).rejects.toThrow(/git clone failed/);
    expect(existsSync(other)).toBe(false);
    expect(readdirSync(root).filter((f) => f.includes("joy-clone"))).toEqual([]);
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
  });

  it("a non-empty non-repo destination is refused and left alone", async () => {
    const dst = join(root, "notrepo");
    mkdirSync(dst);
    writeFileSync(join(dst, "keep.txt"), "mine");
    await expect(cloneForSpawn("https://local.test/origin", dst)).rejects.toThrow(/exists and is not a git repo/);
    expect(existsSync(join(dst, "keep.txt"))).toBe(true);
  });
});
