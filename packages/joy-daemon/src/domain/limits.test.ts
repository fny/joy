// Quota readers: malformed usage rows (#544), one shared in-flight refresh
// (#545), the codex rollout chosen by newest OBSERVATION (#543) under
// $CODEX_HOME (#546). The claude UA probe shells out to `claude --version`;
// stubbed so the test never depends on a CLI being installed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

vi.mock("child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("child_process")>();
  return { ...orig, execSync: () => "2.0.0 (Claude Code)" };
});

describe("claudeLimitRows (#544)", () => {
  it("skips null entries and non-string scopes instead of throwing", async () => {
    const { claudeLimitRows } = await import("./limits");
    const rows = claudeLimitRows({
      five_hour: { utilization: 10, resets_at: null },
      limits: [
        null,
        7,
        { kind: "weekly_scoped", percent: 5, scope: { model: { display_name: 42 } } },
        { kind: "weekly_scoped", percent: 9, scope: { model: { display_name: "  " } } },
        { kind: "weekly_scoped", percent: 68, scope: { model: { display_name: "Fable" } } },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["five_hour", "weekly_scoped:fable"]);
  });
});

describe("fetchClaudeLimits (#545)", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.CLAUDE_CODE_OAUTH_TOKEN; });

  it("concurrent callers share one in-flight request, so a late 429 cannot overwrite the success", async () => {
    vi.resetModules();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "tok";
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal("fetch", async () => {
      const n = ++calls;
      await gate;
      return n === 1
        ? new Response(JSON.stringify({ five_hour: { utilization: 1, resets_at: "2026-09-06T00:00:00Z" } }), { status: 200 })
        : new Response("", { status: 429 });
    });
    const { fetchClaudeLimits } = await import("./limits");
    const p1 = fetchClaudeLimits();
    const p2 = fetchClaudeLimits();
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    expect(await fetchClaudeLimits()).toEqual(a); // the cache holds the success
  });
});

describe("readCodexLimits", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "joy-codex-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.CODEX_HOME; });

  const rollout = (rel: string, events: Array<{ ts: string; pct: number }>) => {
    const p = join(home, "sessions", rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, events.map((e) => JSON.stringify({
      timestamp: e.ts, type: "event_msg",
      payload: { type: "token_count", rate_limits: { primary: { used_percent: e.pct, window_minutes: 300 } } },
    })).join("\n") + "\n");
  };

  it("picks the newest OBSERVATION, not the newest-created rollout (#543)", async () => {
    const { readCodexLimits } = await import("./limits");
    // Yesterday's long-running rollout recorded 95% at noon today; today's
    // session last recorded 5% at 08:00. The 95% is the truth.
    rollout("2026/09/05/rollout-2026-09-05T09-00-00-old.jsonl", [{ ts: "2026-09-05T09:00:00Z", pct: 40 }, { ts: "2026-09-06T12:00:00Z", pct: 95 }]);
    rollout("2026/09/06/rollout-2026-09-06T07-00-00-new.jsonl", [{ ts: "2026-09-06T08:00:00Z", pct: 5 }]);
    const r = readCodexLimits(join(home, "sessions"));
    expect(r.ok && r.limits.primary?.used_percent).toBe(95);
    expect(r.ok && r.limits.observedAt).toBe("2026-09-06T12:00:00Z");
  });

  it("an actively updated older rollout is found past five newer session files (#543)", async () => {
    const { readCodexLimits } = await import("./limits");
    rollout("2026/09/05/rollout-2026-09-05T09-00-00-old.jsonl", [{ ts: "2026-09-06T12:00:00Z", pct: 95 }]);
    for (let i = 0; i < 6; i++) rollout(`2026/09/06/rollout-2026-09-06T0${i}-00-00-n${i}.jsonl`, [{ ts: `2026-09-06T0${i}:30:00Z`, pct: i }]);
    const r = readCodexLimits(join(home, "sessions"));
    expect(r.ok && r.limits.primary?.used_percent).toBe(95);
  });

  it("an actively updated rollout is found past seven populated days of newer sessions (#543 residual)", async () => {
    const { readCodexLimits } = await import("./limits");
    const { utimesSync } = await import("node:fs");
    // 63 newer-created rollouts over seven busy days, all last observed at
    // 08:00; the live session was created on the 1st and observed 95% at
    // noon. Its mtime is the newest in the store; nothing else may hide it.
    for (let d = 2; d <= 8; d++) {
      for (let n = 0; n < 9; n++) {
        const rel = `2026/09/0${d}/rollout-2026-09-0${d}T0${n}-00-00-n${n}.jsonl`;
        rollout(rel, [{ ts: "2026-09-08T08:00:00Z", pct: 5 }]);
        const t = new Date("2026-09-08T08:00:00Z");
        utimesSync(join(home, "sessions", rel), t, t);
      }
    }
    const live = "2026/09/01/rollout-2026-09-01T09-00-00-live.jsonl";
    rollout(live, [{ ts: "2026-09-08T12:00:00Z", pct: 95 }]);
    const t = new Date("2026-09-08T12:00:00Z");
    utimesSync(join(home, "sessions", live), t, t);
    const r = readCodexLimits(join(home, "sessions"));
    expect(r.ok && r.limits.primary?.used_percent).toBe(95);
    expect(r.ok && r.limits.observedAt).toBe("2026-09-08T12:00:00Z");
  });

  it("the default root honours CODEX_HOME (#546)", async () => {
    const { readCodexLimits } = await import("./limits");
    process.env.CODEX_HOME = home;
    rollout("2026/09/06/rollout-2026-09-06T07-00-00-x.jsonl", [{ ts: "2026-09-06T07:00:00Z", pct: 25 }]);
    const r = readCodexLimits();
    expect(r.ok && r.limits.primary?.used_percent).toBe(25);
  });
});
