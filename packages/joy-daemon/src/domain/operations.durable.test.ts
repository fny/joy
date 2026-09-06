// Wave A2 op-level contracts: local send/queueAdd acknowledge only after a
// durable spool (#551), a conditional kill never lands on a session whose
// status moved (#174), and git-URL clones are serialized + attempt-owned so a
// failed clone can never delete a successful working copy (#547).
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { machineOps, cloneForSpawn, gitRepoIdentity } from "./operations";
import { LedgerWriteError, SessionEndedError } from "./ledger";
import { SessionCoordinator, resetCoordinators } from "./coordinator";
import { fakeCoordinatedSession } from "./coordinator.fakeDriver";
import { closeAllLedgers } from "./ledger";

const op = (name: string) => machineOps.find((o) => o.rpcName === name)!;

/** A minimal fake session: enqueue succeeds, or throws the ledger's errors per `durable` / `ended`. */
let opsHome: string;
beforeAll(() => { opsHome = mkdtempSync(join(tmpdir(), "joy-ops-durable-")); process.env.JOY_HOME_DIR = opsHome; });
afterAll(() => { closeAllLedgers(); resetCoordinators(); delete process.env.JOY_HOME_DIR; rmSync(opsHome, { recursive: true, force: true }); });
const fakes = new Map<string, { durable: boolean; calls: Array<{ text: string; opts: unknown }> }>();
let acceptSpy: unknown = null;
/** A coordinator-driven fake session; `durable:false` makes the coordinator
 *  refuse every accept the way a full disk refuses the ledger commit. */
function fakeSession(id: string, o: { durable: boolean; status?: "starting" | "active" | "ended"; ended?: boolean } = { durable: true }) {
  const calls: Array<{ text: string; opts: unknown }> = [];
  const killed: string[] = [];
  const { s, coordinator } = fakeCoordinatedSession(id, {
    agent: "claude", cwd: "/tmp/x",
    extra: {
      claudeSessionId: "sid", summary: undefined, currentModel: undefined, model: undefined,
      killed,
      end(reason: string) { killed.push(`end:${reason}`); return true; },
      forceKill() { killed.push("forceKill"); return true; },
      awaitArchive: async () => true,
    },
  });
  if (o.status) (s as { status: string }).status = o.status;
  if (o.ended) { (s as { status: string }).status = "ended"; coordinator.retire(id, "killed"); }
  fakes.set(id, { durable: o.durable, calls });
  // vi.restoreAllMocks() in an afterEach strips the spy; reinstall whenever it is gone.
  if (!acceptSpy || !vi.isMockFunction(SessionCoordinator.prototype.accept)) {
    const real = SessionCoordinator.prototype.accept;
    acceptSpy = vi.spyOn(SessionCoordinator.prototype, "accept").mockImplementation(function (this: SessionCoordinator, input) {
      const f = fakes.get(input.sessionId);
      if (f) {
        f.calls.push({ text: input.text, opts: input });
        if (!f.durable) throw new LedgerWriteError("accept", new Error("SQLITE_FULL"));
      }
      return real.call(this, input);
    });
  }
  return { s: s as unknown as typeof s & { killed: string[] }, calls };
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
    expect(op("joy-send").httpShape!(r).status).toBe(503);
  });

  it("send into an ended session → session_ended (404), nothing recorded (#553)", async () => {
    const { s } = fakeSession("aaaa0005", { durable: true, ended: true });
    const { reg, chat } = fakeRegistry(s);
    const r = (await op("joy-send").handler(reg as never, { session_id: "aaaa0005", text: "late" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r).toEqual({ error: "session_ended" });
    expect(chat).toEqual([]);
    expect(op("joy-send").httpShape!(r).status).toBe(404);
    const q = (await op("joy-queue-add").handler(reg as never, { id: "aaaa0005", text: "late" }, { via: "rpc" })) as Record<string, unknown>;
    expect(q.error).toBe("session_ended");
    expect(op("joy-queue-add").httpShape!(q).status).toBe(404);
  });

  it("send: durable commit → ok, chat row recorded once", async () => {
    const { s, calls } = fakeSession("aaaa0002", { durable: true });
    const { reg, chat } = fakeRegistry(s);
    const r = (await op("joy-send").handler(reg as never, { session_id: "aaaa0002", text: "hello" }, { via: "http" })) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: true, chat_id: 7, queued_id: expect.any(String) });
    expect(chat).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ mirrorToRelay: true, visible: true, source: "web" });
  });

  it("queueAdd: persistence failure → not_durable (503)", async () => {
    const bad = fakeSession("aaaa0003", { durable: false });
    const r1 = (await op("joy-queue-add").handler(fakeRegistry(bad.s).reg as never, { id: "aaaa0003", text: "x" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r1.error).toBe("not_durable");
    expect(op("joy-queue-add").httpShape!(r1).status).toBe(503);
    const good = fakeSession("aaaa0004", { durable: true });
    const r2 = (await op("joy-queue-add").handler(fakeRegistry(good.s).reg as never, { id: "aaaa0004", text: "x" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r2).toMatchObject({ ok: true, id: expect.any(String) });
    expect(good.calls).toHaveLength(1);
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
    // already holds a DIFFERENT repository, so it is refused (#151 residual;
    // no clone runs); either way nothing under dst may be removed.
    await expect(cloneForSpawn("https://local.test/does-not-exist", dst)).rejects.toThrow(/holds a different repository/);
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
    // A failing clone into a FRESH target leaves nothing behind at all.
    const other = join(root, "other");
    await expect(cloneForSpawn("https://local.test/does-not-exist", other)).rejects.toThrow(/git clone failed/);
    expect(existsSync(other)).toBe(false);
    expect(readdirSync(root).filter((f) => f.includes("joy-clone"))).toEqual([]);
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
  });

  // #547 residual (Astra): `rmSync(dir, {recursive: false})` raises EISDIR on
  // ANY directory, so a pre-created empty cwd (the app makes it before the
  // spawn) failed every clone and threw the finished checkout away.
  it("a pre-created EMPTY destination is filled by the clone (#547 residual)", async () => {
    const dst = join(root, "empty");
    mkdirSync(dst);
    useLocalOrigin();
    await expect(cloneForSpawn("https://local.test/origin", dst)).resolves.toBeUndefined();
    expect(existsSync(join(dst, ".git"))).toBe(true);
    expect(existsSync(join(dst, "README"))).toBe(true);
    expect(readdirSync(root).filter((f) => f.includes("joy-clone"))).toEqual([]);
  });

  // #151 residual (Astra): `.git` present is not proof it is the REQUESTED repo.
  it("an existing checkout of the SAME repository is reused, whatever the URL spelling", async () => {
    const dst = join(root, "same");
    useLocalOrigin();
    await cloneForSpawn("https://local.test/origin", dst);
    writeFileSync(join(dst, "WORK.txt"), "keep");
    // Trailing slash, .git suffix, upper-case host, other transport: one repo.
    for (const spelling of ["https://local.test/origin/", "https://LOCAL.test/origin.git", "git@local.test:origin.git", "ssh://git@local.test/origin"]) {
      await expect(cloneForSpawn(spelling, dst)).resolves.toBeUndefined();
    }
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
  });

  it("an existing checkout of a DIFFERENT repository is refused with the URL it holds, and left alone (#151 residual)", async () => {
    const dst = join(root, "other-repo");
    useLocalOrigin();
    await cloneForSpawn("https://local.test/origin", dst);
    execFileSync("git", ["-C", dst, "remote", "set-url", "origin", "https://github.com/acme/unrelated.git"], { stdio: "pipe" });
    writeFileSync(join(dst, "WORK.txt"), "theirs");
    await expect(cloneForSpawn("https://local.test/origin", dst)).rejects.toThrow(/holds a different repository \(https:\/\/github\.com\/acme\/unrelated\.git\)/);
    expect(existsSync(join(dst, "WORK.txt"))).toBe(true);
    expect(existsSync(join(dst, ".git"))).toBe(true);
    // A repo with no origin at all is never adopted either.
    execFileSync("git", ["-C", dst, "remote", "remove", "origin"], { stdio: "pipe" });
    await expect(cloneForSpawn("https://local.test/origin", dst)).rejects.toThrow(/different repository \(no origin remote\)/);
  });

  it("gitRepoIdentity normalizes host case, trailing slash, .git and transport", () => {
    expect(gitRepoIdentity(" https://GitHub.com/acme/App.git/ ")).toBe("github.com/acme/App");
    expect(gitRepoIdentity("git@github.com:acme/App.git")).toBe("github.com/acme/App");
    expect(gitRepoIdentity("ssh://git@github.com:22/acme/App")).toBe("github.com/acme/App");
    expect(gitRepoIdentity("https://github.com/acme/App")).not.toBe(gitRepoIdentity("https://github.com/acme/app2"));
  });

  it("a non-empty non-repo destination is refused and left alone", async () => {
    const dst = join(root, "notrepo");
    mkdirSync(dst);
    writeFileSync(join(dst, "keep.txt"), "mine");
    await expect(cloneForSpawn("https://local.test/origin", dst)).rejects.toThrow(/exists and is not a git repo/);
    expect(existsSync(join(dst, "keep.txt"))).toBe(true);
  });
});

// #567 residual (Astra): with the record's unlink AND tombstone both refused,
// only this process's memory hid the record and kill still said ok:true — a
// restart resurrected the session. The adapters now report whether a
// termination marker landed, and the op refuses to call the kill done otherwise.
describe("kill reports record_not_terminated when no termination marker is durable (#567)", () => {
  it("adapter says the record survived → ok:false record_not_terminated, HTTP 503; the session was still torn down", async () => {
    const { s } = fakeSession("bbbb0004", { durable: true, status: "ended" });
    const notTerminated = Object.assign(s, { recordTerminated: () => false });
    const r = (await op("joy-kill-session").handler(fakeRegistry(notTerminated).reg as never, { id: "bbbb0004" }, { via: "rpc" })) as Record<string, unknown>;
    expect(r).toEqual({ ok: false, error: "record_not_terminated" });
    expect(op("joy-kill-session").httpShape!(r).status).toBe(503);
    expect(s.killed).toEqual(["forceKill"]);
  });

  it("adapter confirms the marker (or predates the method) → ok:true as before", async () => {
    const { s } = fakeSession("bbbb0005", { durable: true, status: "active" });
    Object.assign(s, { recordTerminated: () => true });
    expect(await op("joy-kill-session").handler(fakeRegistry(s).reg as never, { id: "bbbb0005" }, { via: "rpc" })).toEqual({ ok: true });
  });

  it("archive failure still wins (the app runs its fallback archive)", async () => {
    const { s } = fakeSession("bbbb0006", { durable: true, status: "active" });
    Object.assign(s, { awaitArchive: async () => false, recordTerminated: () => false });
    expect(await op("joy-kill-session").handler(fakeRegistry(s).reg as never, { id: "bbbb0006" }, { via: "rpc" })).toEqual({ ok: false });
  });
});

describe("send: an explicit replyTo of null / \"\" stamps no reply-to (#112)", () => {
  const pair = (a: string, b: string) => {
    const sender = fakeSession(a, { durable: true }); const target = fakeSession(b, { durable: true });
    const reg = { get: (id: string) => (id === a ? sender.s : id === b ? target.s : undefined), nextChatId: () => 1, addChatMessage: () => {} };
    return { reg, wrapper: () => target.calls[0].text.split("\n")[0] };
  };

  it("replyTo omitted: a joy sender defaults to reply-to=itself (unchanged)", async () => {
    const { reg, wrapper } = pair("cccc0001", "cccc0002");
    const r = (await op("joy-send").handler(reg as never, { session_id: "cccc0002", text: "ping", from: "joy:cccc0001" }, { via: "http" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(wrapper()).toContain('reply-to="joy:cccc0001"');
  });

  it.each([null, ""])("replyTo=%j from a joy session: <joy-message from=…> with NO reply-to", async (replyTo) => {
    const { reg, wrapper } = pair("cccc0003", "cccc0004");
    const r = (await op("joy-send").handler(reg as never, { session_id: "cccc0004", text: "FYI done", from: "joy:cccc0003", replyTo }, { via: "http" })) as Record<string, unknown>;
    expect(r.ok).toBe(true);
    expect(wrapper()).toContain('from="joy:cccc0003"');
    expect(wrapper()).not.toContain("reply-to");
  });

  it("a malformed explicit replyTo is still refused", async () => {
    const { reg } = pair("cccc0005", "cccc0006");
    const r = (await op("joy-send").handler(reg as never, { session_id: "cccc0006", text: "x", from: "joy:cccc0005", replyTo: "nope" }, { via: "http" })) as Record<string, unknown>;
    expect(r.error).toBe("bad_reply_to");
  });
});
