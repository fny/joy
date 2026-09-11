import { describe, expect, it } from "vitest";
import { restorableFrom, resumeIdOf, latestPerProject } from "./restorable";
import type { WindowRecord } from "./windowRecord";

const rec = (over: Partial<WindowRecord> & { id: string }): WindowRecord =>
  ({ launchCwd: "/srv/work", socket: `sock-${over.id}`, ...over }) as WindowRecord;

/** Nothing's server is alive — the state a machine is in after a reboot. */
const allDead = () => false;

describe("resumeIdOf — each agent keeps its conversation somewhere different", () => {
  it("reads the right field per agent", () => {
    expect(resumeIdOf(rec({ id: "a", claudeSessionId: "uuid" }))).toBe("uuid");
    expect(resumeIdOf(rec({ id: "b", agent: "codex", codexThreadId: "thread" }))).toBe("thread");
    expect(resumeIdOf(rec({ id: "c", agent: "opencode", opencodeSessionId: "oc" }))).toBe("oc");
    expect(resumeIdOf(rec({ id: "d", agent: "pi", piSettings: { sessionId: "pi1" } }))).toBe("pi1");
    expect(resumeIdOf(rec({ id: "e", agent: "agy", agySettings: { conversationId: "agy1" } }))).toBe("agy1");
  });

  it("treats a record with no agent as claude, which is what it was", () => {
    expect(resumeIdOf(rec({ id: "old", claudeSessionId: "uuid" }))).toBe("uuid");
  });
});

describe("restorableFrom", () => {
  it("finds a session whose server died with the machine", () => {
    const out = restorableFrom([rec({ id: "a", claudeSessionId: "uuid", claudePermissionMode: "bypassPermissions" })], allDead);
    expect(out).toEqual([{
      id: "a", cwd: "/srv/work", agent: "claude", resumeId: "uuid",
      model: undefined, permissionMode: "bypassPermissions", effort: undefined, extraArgs: undefined,
    }]);
  });

  it("leaves a LIVE session alone — it is adopted, not lost", () => {
    // The whole hazard: relaunching something that is already running gives
    // you two agents in one folder.
    expect(restorableFrom([rec({ id: "a" })], () => true)).toEqual([]);
  });

  it("skips a record with no socket rather than guessing", () => {
    // Pre-per-session-server records cannot be probed individually, so there
    // is no way to tell whether they are running. Guessing wrong is the
    // two-agents case again.
    expect(restorableFrom([rec({ id: "legacy", socket: undefined })], allDead)).toEqual([]);
  });

  it("skips a record too incomplete to relaunch", () => {
    expect(restorableFrom([rec({ id: "", launchCwd: "/x" } as any), rec({ id: "b", launchCwd: "" } as any)], allDead)).toEqual([]);
  });

  it("restores a session with no conversation to resume, and says so by omission", () => {
    // The folder can be reopened even when the history cannot; that is still
    // worth offering, and the caller can tell the difference.
    const out = restorableFrom([rec({ id: "a" })], allDead);
    expect(out).toHaveLength(1);
    expect(out[0].resumeId).toBeUndefined();
  });

  it("carries each agent's own launch settings back with it", () => {
    const out = restorableFrom([
      rec({ id: "c", agent: "codex", codexThreadId: "t", codexSettings: { model: "gpt-5", effort: "high" } }),
      rec({ id: "p", agent: "pi", piSettings: { sessionId: "s", model: "m", extraArgs: "--flag" } }),
    ], allDead);
    expect(out.find((x) => x.id === "c")).toMatchObject({ model: "gpt-5", effort: "high" });
    expect(out.find((x) => x.id === "p")).toMatchObject({ model: "m", extraArgs: "--flag" });
  });

  it("puts the MOST RECENT first — what you want back is what you were working on", () => {
    const records = [rec({ id: "old" }), rec({ id: "newest" }), rec({ id: "middle" })];
    const at: Record<string, number> = { old: 1000, middle: 2000, newest: 3000 };
    const out = restorableFrom(records, allDead, (r) => at[r.id]);
    expect(out.map((x) => x.id)).toEqual(["newest", "middle", "old"]);
  });

  it("is ordered the same every time, so a dry run matches the restore that follows", () => {
    // With no timestamps at all the order still has to be total, or the dry
    // run lists one thing and the restore does another.
    const records = [
      rec({ id: "b2", launchCwd: "/b" }), rec({ id: "a1", launchCwd: "/a" }),
      rec({ id: "a2", launchCwd: "/a" }), rec({ id: "c", launchCwd: "/c" }),
    ];
    const ids = (xs: ReturnType<typeof restorableFrom>) => xs.map((x) => x.id);
    expect(ids(restorableFrom(records, allDead))).toEqual(["a1", "a2", "b2", "c"]);
    expect(ids(restorableFrom([...records].reverse(), allDead))).toEqual(["a1", "a2", "b2", "c"]);
  });

  it("is empty when nothing was lost", () => {
    expect(restorableFrom([], allDead)).toEqual([]);
  });
});

describe("latestPerProject", () => {
    const r = (id: string, cwd: string, lastSeenAt: number) => ({ id, cwd, agent: "claude" as const, lastSeenAt });

    it("keeps the newest session in each project, and nothing else", () => {
        const out = latestPerProject([
            r("a-old", "/a", 1000), r("a-new", "/a", 3000),
            r("b-only", "/b", 2000),
        ]);
        expect(out.map((x) => x.id)).toEqual(["a-new", "b-only"]);
    });

    it("orders the projects by their newest session", () => {
        const out = latestPerProject([r("a", "/a", 1000), r("b", "/b", 5000), r("c", "/c", 3000)]);
        expect(out.map((x) => x.cwd)).toEqual(["/b", "/c", "/a"]);
    });

    it("is stable when nothing has a timestamp", () => {
        const out = latestPerProject([
            { id: "z", cwd: "/z", agent: "claude" },
            { id: "a", cwd: "/a", agent: "claude" },
        ]);
        expect(out.map((x) => x.cwd)).toEqual(["/a", "/z"]);
    });

    it("is empty for an empty list", () => {
        expect(latestPerProject([])).toEqual([]);
    });
});
