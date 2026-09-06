// GET /v2/sessions/:id/git/status over the real HTTP transport: `?v=2`
// answers the structured schema (domain/gitStatus.ts), and the same route
// with `v` absent still answers the original shape so older apps keep working.
import { test, expect, beforeAll, afterAll, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { startHttpServer } from "./http";
import type { SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";

const TOKEN = "test-token-v2-git";
let base = "";
let repo = "";
let plain = "";
let pub = "";

const g = (args: string[]) => execFileSync("git", args, { cwd: repo });

function fakeSession(id: string, cwd: string): AgentSession {
  return {
    id, agentFlavor: "claude", cwd,
    toJSON: () => ({ id, cwd, agent: "claude" }),
    enqueue: () => ({ id: "q" }),
    queueState: () => ({ pendingCount: 0, paused: false }),
  } as unknown as AgentSession;
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "joy-v2-gitstatus-"));
  plain = mkdtempSync(join(tmpdir(), "joy-v2-plain-"));
  pub = mkdtempSync(join(tmpdir(), "joy-v2-pub-"));
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "inner.txt"), "inner\n");
  g(["add", "."]);
  g(["commit", "-q", "-m", "init"]);
  writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "sub", "inner.txt"), "inner\nchanged\n");
  writeFileSync(join(repo, "quo\"te.txt"), "q\n");

  const sessions: Record<string, AgentSession> = {
    rootsess: fakeSession("rootsess", repo),
    subsess: fakeSession("subsess", join(repo, "sub")),
    plainsess: fakeSession("plainsess", plain),
  };
  const registry = {
    get: (id: string) => sessions[id],
    list: () => Object.values(sessions),
    size: 3, sseClientCount: 0, startedAt: Date.now(),
    chatHistory: () => [], claimInfo: () => ({}), claudeInfo: () => ({}),
    commands: { union: () => [], refresh: () => ({ slashCommands: [] }), forProject: () => [] },
    subscribeSse: () => () => {},
  } as unknown as SessionRegistry;
  base = await new Promise<string>(resolve => {
    startHttpServer({ registry, port: 0, publicDir: pub, token: TOKEN, onListening: p => resolve(`http://127.0.0.1:${p}`) });
  });
});

afterAll(() => {
  for (const d of [repo, plain, pub]) rmSync(d, { recursive: true, force: true });
});

async function get(path: string) {
  const r = await fetch(base + path, { headers: { "x-joy-token": TOKEN } });
  return { status: r.status, json: JSON.parse(await r.text()) };
}

describe("GET /v2/sessions/:id/git/status?v=2", () => {
  test("structured schema: versioned, root relation, head, entries with identity + display, exact counts", async () => {
    const r = await get("/v2/sessions/rootsess/git/status?v=2");
    expect(r.status).toBe(200);
    expect(r.json.v).toBe(2);
    expect(r.json.ok).toBe(true);
    expect(r.json.relation).toBe("root");
    expect(r.json.repository.prefix).toBe("");
    expect(r.json.head).toMatchObject({ kind: "branch", name: "main" });
    const byCwd = Object.fromEntries(r.json.entries.map((e: any) => [e.path.cwd, e]));
    expect(byCwd["tracked.txt"]).toMatchObject({ index: ".", worktree: "M", untracked: false, binary: false, lines: { staged: { added: 0, removed: 0 }, unstaged: { added: 1, removed: 0 } } });
    expect(byCwd["quo\"te.txt"]).toMatchObject({ untracked: true, path: { repo: "quo\"te.txt", cwd: "quo\"te.txt", display: "quo\"te.txt", utf8: true }, lines: { unstaged: "unavailable" } });
    expect(r.json.totals.unstaged).toEqual({ added: 2, removed: 0 });
    expect(r.json.totals.counts).toEqual({ staged: 0, unstaged: 2, untracked: 1, conflicted: 0, entries: 3 });
    expect(r.json.clean).toBe(false);
    expect(r.json.branches).toEqual([expect.objectContaining({ name: "main", current: true })]);
  });

  test("subdirectory session: relation=inside, cwd identity feeds files/content, repo identity kept", async () => {
    const r = await get("/v2/sessions/subsess/git/status?v=2");
    expect(r.json.relation).toBe("inside");
    expect(r.json.repository.prefix).toBe("sub/");
    expect(r.json.entries.map((e: any) => e.path.cwd)).toEqual(["inner.txt"]);
    expect(r.json.entries[0].path.repo).toBe("sub/inner.txt");
    const back = await get("/v2/sessions/subsess/files/content?path=" + encodeURIComponent(r.json.entries[0].path.cwd));
    expect(back.json.success).toBe(true);
  });

  test("not a repository is a distinct, successful answer", async () => {
    const r = await get("/v2/sessions/plainsess/git/status?v=2");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ v: 2, ok: true, relation: "none", cwd: plain });
  });

  test("v absent: the original shape is unchanged (older apps)", async () => {
    const r = await get("/v2/sessions/rootsess/git/status");
    expect(r.status).toBe(200);
    expect(r.json.v).toBeUndefined();
    expect(r.json.ok).toBe(true);
    expect(r.json.branch).toBe("main");
    const byPath = Object.fromEntries(r.json.entries.map((e: any) => [e.path, e]));
    expect(byPath["tracked.txt"].unstaged).toBe("M");
    expect(byPath["quo\"te.txt"].untracked).toBe(true);
  });

  test("unknown session is 404 either way", async () => {
    expect((await get("/v2/sessions/nope/git/status?v=2")).status).toBe(404);
    expect((await get("/v2/sessions/nope/git/status")).status).toBe(404);
  });
});
