import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { computeUsage, ratesFor, prettyModelName, periodToRange } from "./usage";

const ROOT = "/tmp/joy-usage-test-fixture";

function entry(o: Record<string, unknown>): string {
  return JSON.stringify(o) + "\n";
}

function assistant(opts: {
  ts: string; msgId: string; model?: string; out?: number; cacheRead?: number; cw1h?: number;
  cwd?: string; tool?: string;
}): string {
  return entry({
    type: "assistant",
    timestamp: opts.ts,
    cwd: opts.cwd ?? "/home/u/proj",
    message: {
      id: opts.msgId,
      model: opts.model ?? "claude-fable-5",
      content: opts.tool ? [{ type: "tool_use", name: opts.tool, input: {} }] : [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 100,
        output_tokens: opts.out ?? 1000,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cw1h ?? 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: opts.cw1h ?? 0 },
      },
    },
  });
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  const proj = join(ROOT, "-home-u-proj");
  mkdirSync(join(proj, "sess-1", "subagents"), { recursive: true });

  // Main session: duplicate entries for msg-1 (same usage repeated — must
  // count once, last wins), a second message next day, a user prompt, a
  // tool_result user entry (NOT a turn), and an MCP tool call.
  writeFileSync(join(proj, "sess-1.jsonl"), [
    entry({ type: "user", timestamp: "2026-06-01T10:00:00Z", message: { role: "user", content: "do the thing" } }),
    assistant({ ts: "2026-06-01T10:00:01Z", msgId: "msg-1", out: 500, tool: "Bash" }),
    assistant({ ts: "2026-06-01T10:00:02Z", msgId: "msg-1", out: 1000, tool: "mcp__happy__send" }),
    entry({ type: "user", timestamp: "2026-06-01T10:00:03Z", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    assistant({ ts: "2026-06-02T09:00:00Z", msgId: "msg-2", out: 2000, cacheRead: 1_000_000 }),
  ].join(""));

  // Subagent transcript: attributed to sess-1.
  writeFileSync(join(proj, "sess-1", "subagents", "agent-abc.jsonl"), [
    assistant({ ts: "2026-06-01T10:30:00Z", msgId: "msg-sub", out: 100, model: "claude-haiku-4-5" }),
  ].join(""));

  // Second session, different project, opus 4.8 with a 1h cache write.
  mkdirSync(join(ROOT, "-home-u-other"), { recursive: true });
  writeFileSync(join(ROOT, "-home-u-other", "sess-2.jsonl"), [
    assistant({ ts: "2026-06-02T12:00:00Z", msgId: "msg-3", model: "claude-opus-4-8", out: 1000, cw1h: 1_000_000, cwd: "/home/u/other" }),
  ].join(""));
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

test("rates: family matching and the opus 4-5 price split", () => {
  expect(ratesFor("claude-fable-5")!.output).toBe(50);
  expect(ratesFor("claude-opus-4-8")!.input).toBe(5);
  expect(ratesFor("claude-opus-4-1-20250805")!.input).toBe(15);
  expect(ratesFor("claude-sonnet-4-6")!.output).toBe(15);
  expect(ratesFor("gpt-5-codex")).toBeNull();
});

test("pretty model names", () => {
  expect(prettyModelName("claude-fable-5")).toBe("Fable 5");
  expect(prettyModelName("claude-opus-4-8")).toBe("Opus 4.8");
  expect(prettyModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
});

test("dedup, pricing, subagent rollup, turns, tools", async () => {
  const r = await computeUsage({ fromDay: "2026-06-01", toDay: "2026-06-02", root: ROOT });

  // msg-1 counted ONCE with final usage (out=1000), not twice.
  // fable: msg-1 (in 100, out 1000) + msg-2 (in 100, out 2000, cr 1M)
  //   = (200*10 + 3000*50 + 1e6*1) / 1e6 = 0.002 + 0.15 + 1.0 = 1.152
  // haiku sub: (100*1 + 100*5)/1e6 = 0.0006
  // opus 4.8: (100*5 + 1000*25 + 1e6*10)/1e6 = 0.0255 + 10 = 10.0255
  expect(r.overview.calls).toBe(4);
  expect(r.overview.cost).toBeCloseTo(1.152 + 0.0006 + 10.0255, 4);

  // Subagent burn rolls into sess-1; sessions sorted by cost desc.
  expect(r.overview.sessions).toBe(2);
  const s1 = r.sessions.find(s => s.id === "sess-1")!;
  expect(s1.calls).toBe(3);
  expect(s1.turns).toBe(1); // tool_result entry is not a turn
  expect(s1.models.map(m => m.name).sort()).toEqual(["Fable 5", "Haiku 4.5"]);
  expect(r.sessions[0].id).toBe("sess-2"); // most expensive first

  // Daily grouping
  expect(r.daily.map(d => d.date)).toEqual(["2026-06-01", "2026-06-02"]);

  // Tools: counted per entry (blocks never repeat across entries) — the two
  // msg-1 entries contribute one Bash and one MCP call. MCP is grouped by
  // server name.
  expect(r.tools.find(t => t.name === "Bash")!.calls).toBe(1);
  expect(r.mcpServers.find(t => t.name === "happy")!.calls).toBe(1);

  // Projects
  expect(r.projects.length).toBe(2);
  expect(r.projects[0].path).toBe("/home/u/other");
});

test("day-range filter", async () => {
  const r = await computeUsage({ fromDay: "2026-06-02", toDay: "2026-06-02", root: ROOT });
  expect(r.overview.calls).toBe(2); // msg-2 + msg-3 only
  const s1 = r.sessions.find(s => s.id === "sess-1")!;
  expect(s1.turns).toBe(0); // the turn was on 06-01
});

test("periodToRange basics", () => {
  const today = periodToRange("today");
  expect(today.fromDay).toBe(today.toDay);
  expect(periodToRange("all").fromDay).toBe("1970-01-01");
});
