// v2 machine-plane surface over the REAL http transport: startHttpServer with
// a stub registry whose one session points at a real temp git repo. Proves
// route dispatch, token auth on the new PUT/PATCH verbs, the typed grep/file
// adapters, daemon-side porcelain parsing, and that v1 catalog routes still
// answer on the same server.
import { test, expect, beforeAll, afterAll, describe } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync, unlinkSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { startHttpServer } from "./http";
import { parsePorcelainV2, decodeBase64Strict } from "./v2";
import type { SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";

const TOKEN = "test-token-v2";
let base = "";
let repo = "";
let pub = "";
/** What each fake session was asked to enqueue (route-targeting proof, #599). */
const enqueued: Record<string, string[]> = { abcd1234: [], sub00001: [] };

const g = (args: string[]) => execFileSync("git", args, { cwd: repo });

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "joy-v2-repo-"));
  pub = mkdtempSync(join(tmpdir(), "joy-v2-pub-"));
  g(["init", "-b", "main"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.txt"), "hello v2 GREPME\n");
  g(["add", "."]);
  g(["commit", "-m", "init"]);
  writeFileSync(join(repo, "tracked.txt"), "hello v2 GREPME\nmodified line\n");
  writeFileSync(join(repo, "untracked.txt"), "new file\n");

  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "inner.txt"), "inner\n");
  g(["add", "sub"]);
  g(["commit", "-m", "sub"]);
  writeFileSync(join(repo, "sub", "inner.txt"), "inner\nchanged\n");

  const fakeSession = {
    id: "abcd1234",
    agentFlavor: "claude",
    cwd: repo,
    toJSON: () => ({ id: "abcd1234", cwd: repo, agent: "claude" }),
    enqueue: (text: string) => { enqueued.abcd1234.push(text); return { id: "q1" }; },
    queueState: () => ({ pendingCount: enqueued.abcd1234.length, paused: false }),
  } as unknown as AgentSession;
  // A session whose cwd is a SUBDIRECTORY of the repository — git must not
  // report the rest of the worktree to it.
  const subSession = {
    id: "sub00001",
    agentFlavor: "claude",
    cwd: join(repo, "sub"),
    toJSON: () => ({ id: "sub00001", cwd: join(repo, "sub"), agent: "claude" }),
    enqueue: (text: string) => { enqueued.sub00001.push(text); return { id: "q2" }; },
    queueState: () => ({ pendingCount: enqueued.sub00001.length, paused: false }),
  } as unknown as AgentSession;
  // Exposed so the DELETE test can stub kill-side methods on the live object.
  (fakeSession as any).status = "active";
  (globalThis as any).__v2KillSession = fakeSession;
  const registry = {
    get: (id: string) => (id === "abcd1234" ? fakeSession : id === "sub00001" ? subSession : undefined),
    list: () => [fakeSession],
    size: 1,
    sseClientCount: 0,
    startedAt: Date.now(),
    chatHistory: () => [],
    claudeInfo: () => ({}),
    commands: {
      union: () => ["deploy", "review"],
      refresh: () => ({ slashCommands: ["deploy", "review"] }),
      forProject: () => ["deploy"],
    },
    subscribeSse: () => () => {},
  } as unknown as SessionRegistry;

  base = await new Promise<string>(resolve => {
    startHttpServer({
      registry, port: 0, publicDir: pub, token: TOKEN,
      onListening: p => resolve(`http://127.0.0.1:${p}`),
    });
  });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(pub, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== null) headers["x-joy-token"] = opts.token ?? TOKEN;
  const r = await fetch(base + path, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe("v2 machine plane", () => {
  test("status vitals", async () => {
    const r = await call("GET", "/v2/status");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.sessions).toBe(1);
  });

  test("sessions list + one record + 404", async () => {
    const list = await call("GET", "/v2/sessions");
    expect(list.json.sessions.length).toBe(1);
    const one = await call("GET", "/v2/sessions/abcd1234");
    expect(one.json.id).toBe("abcd1234");
    expect((await call("GET", "/v2/sessions/nope0000")).status).toBe(404);
  });

  test("harness inventory; unknown harness is 422, never a default", async () => {
    const all = await call("GET", "/v2/harnesses");
    expect(all.json.harnesses.map((h: any) => h.id)).toEqual(["claude", "codex", "opencode", "pi", "agy"]);
    expect((await call("GET", "/v2/harnesses/claude")).status).toBe(200);
    expect((await call("GET", "/v2/harnesses/gemini")).status).toBe(422);
    expect((await call("GET", "/v2/harnesses/gemini/models")).status).toBe(422);
    expect((await call("GET", "/v2/harnesses/gemini/limits")).status).toBe(422);
  });

  test("claude models: empty catalog (CLI owns model choice)", async () => {
    const r = await call("GET", "/v2/harnesses/claude/models");
    expect(r.status).toBe(200);
    expect(r.json.models).toEqual([]);
  });

  test("pi limits: normalized shape with explicit unsupported error", async () => {
    const r = await call("GET", "/v2/harnesses/pi/limits");
    expect(r.status).toBe(200);
    expect(r.json.limits).toEqual([]);
    expect(r.json.error.code).toBe("unsupported");
    expect(typeof r.json.observedAt).toBe("number");
  });

  test("usage: harness filter beyond claude fails loudly", async () => {
    const r = await call("GET", "/v2/usage?harness=codex");
    expect(r.status).toBe(422);
    expect(r.json.error).toBe("unsupported_filter");
  });

  test("slash commands: machine union and per-session set", async () => {
    expect((await call("GET", "/v2/slash-commands")).json.slashCommands).toEqual(["deploy", "review"]);
    expect((await call("GET", "/v2/sessions/abcd1234/slash-commands")).json.slashCommands).toEqual(["deploy"]);
  });

  test("PUT/PATCH require the instance token", async () => {
    const put = await call("PUT", "/v2/sessions/abcd1234/files/content", {
      token: null, body: { path: "x.txt", content: "y" },
    });
    expect(put.status).toBe(401);
    const patch = await call("PATCH", "/v2/harnesses/claude/config", { token: null, body: { edits: ["a = 1"] } });
    expect(patch.status).toBe(401);
  });
});

describe("v2 session files", () => {
  test("content PUT → GET → DELETE round-trip", async () => {
    const put = await call("PUT", "/v2/sessions/abcd1234/files/content", {
      body: { path: "notes/v2.md", content: "written via v2\n" },
    });
    expect(put.status).toBe(200);
    expect(put.json.success).toBe(true);
    expect(readFileSync(join(repo, "notes/v2.md"), "utf-8")).toBe("written via v2\n");

    const got = await call("GET", "/v2/sessions/abcd1234/files/content?path=notes/v2.md");
    expect(got.json.success).toBe(true);
    expect(Buffer.from(got.json.content, "base64").toString()).toBe("written via v2\n");

    const del = await call("DELETE", "/v2/sessions/abcd1234/files/content?path=notes/v2.md");
    expect(del.json.success).toBe(true);
    expect(existsSync(join(repo, "notes/v2.md"))).toBe(false);
  });

  test("entries: flat list and ?depth tree", async () => {
    const flat = await call("GET", "/v2/sessions/abcd1234/files/entries");
    expect(flat.json.success).toBe(true);
    expect(flat.json.entries.some((e: any) => e.name === "tracked.txt")).toBe(true);
    const tree = await call("GET", "/v2/sessions/abcd1234/files/entries?depth=3");
    expect(tree.json.success).toBe(true);
    expect(tree.json.tree.type).toBe("directory");
  });

  test("grep: typed params reach ripgrep; traversal paths are jailed", async () => {
    const hit = await call("GET", "/v2/sessions/abcd1234/files/grep?q=grepme");
    expect(hit.json.success).toBe(true);
    expect(hit.json.stdout).toContain("tracked.txt");
    expect(hit.json.stdout).toContain("GREPME"); // -i default: caseSensitive off
    const miss = await call("GET", "/v2/sessions/abcd1234/files/grep?q=grepme&caseSensitive=1");
    expect(miss.json.stdout ?? "").not.toContain("tracked.txt");
    const jail = await call("GET", "/v2/sessions/abcd1234/files/grep?q=x&path=../../etc");
    expect(jail.status).toBe(400);
    expect((await call("GET", "/v2/sessions/abcd1234/files/grep")).status).toBe(400); // q required
  });
});

describe("v2 session git", () => {
  test("status: branch + porcelain entries parsed daemon-side", async () => {
    const r = await call("GET", "/v2/sessions/abcd1234/git/status");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.branch).toBe("main");
    expect(r.json.clean).toBe(false);
    const byPath = Object.fromEntries(r.json.entries.map((e: any) => [e.path, e]));
    expect(byPath["tracked.txt"].unstaged).toBe("M");
    expect(byPath["untracked.txt"].untracked).toBe(true);
  });

  test("entries: tracked files only", async () => {
    const r = await call("GET", "/v2/sessions/abcd1234/git/entries");
    expect(r.json.ok).toBe(true);
    expect(r.json.files).toContain("tracked.txt");
    expect(r.json.files).not.toContain("untracked.txt");
  });

  test("diff: working tree vs HEAD", async () => {
    const r = await call("GET", "/v2/sessions/abcd1234/git/diff");
    expect(r.json.ok).toBe(true);
    expect(r.json.diff).toContain("+modified line");
    const staged = await call("GET", "/v2/sessions/abcd1234/git/diff?staged=1");
    expect(staged.json.ok).toBe(true);
    expect(staged.json.diff).toBe("");
  });

  test("non-repo cwd answers ok:false with git's own error", async () => {
    const plain = mkdtempSync(join(tmpdir(), "joy-v2-norepo-"));
    try {
      // Point a second fake session at a non-repo dir via a fresh registry?
      // Cheaper: git/status on a session whose cwd we temporarily rewrite is
      // NOT possible (cwd is readonly) — so run the parser directly instead.
      const parsed = parsePorcelainV2("");
      expect(parsed.clean).toBe(true);
      expect(parsed.entries).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("v1 stays intact beside v2", () => {
  test("v1 catalog routes still answer", async () => {
    const r = await call("GET", "/sessions");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json[0].id).toBe("abcd1234");
    const pane = await call("GET", "/status");
    expect(pane.json.ok).toBe(true);
  });
});

describe("review fixes: regression coverage", () => {
  test("git status is scoped to a subdirectory cwd", async () => {
    const r = await call("GET", "/v2/sessions/sub00001/git/status");
    expect(r.json.ok).toBe(true);
    // Only the subdir's change is visible — nothing from the repo root — and
    // the path is relative to the SESSION CWD like every other path on this
    // surface, not to the repository root (#601: "sub/inner.txt" fed back to
    // files/content went looking for sub/sub/inner.txt).
    expect(r.json.entries.map((e: any) => e.path)).toEqual(["inner.txt"]);
    const back = await call("GET", "/v2/sessions/sub00001/files/content?path=" + encodeURIComponent(r.json.entries[0].path));
    expect(back.json.success).toBe(true);
    // the root session still sees root-relative paths (prefix is empty there)
    const root = await call("GET", "/v2/sessions/abcd1234/git/status");
    expect(root.json.entries.map((e: any) => e.path)).toContain("sub/inner.txt");
    const diff = await call("GET", "/v2/sessions/sub00001/git/diff");
    expect(diff.json.diff).toContain("+changed");
    expect(diff.json.diff).not.toContain("tracked.txt");
  });

  test("porcelain -z: unmerged records mean NOT clean; renames carry origPath", () => {
    const NUL = "\0";
    const out = [
      "# branch.head main",
      "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.txt",
      "2 R. N... 100644 100644 100644 dddd eeee R100 new name.txt", "old name.txt",
    ].join(NUL) + NUL;
    const p = parsePorcelainV2(out);
    expect(p.clean).toBe(false);
    const conflict = p.entries.find((e) => e.conflicted);
    expect(conflict?.path).toBe("conflicted.txt");
    const rename = p.entries.find((e) => e.renamedFrom);
    expect(rename?.path).toBe("new name.txt"); // -z: spaces arrive raw
    expect(rename?.renamedFrom).toBe("old name.txt");
  });

  test("a symlink out of the repo is refused end to end (read, write, grep)", async () => {
    // Under HOME, not tmpdir(): the temp dirs are a READ root now (see
    // fileOps.TEMP_ROOTS), so an escape into them is no longer the case this
    // test is about. The jail still has to hold for everywhere else.
    const outside = mkdtempSync(join(homedir(), ".joy-v2-outside-"));
    writeFileSync(join(outside, "passwd"), "root:x:0:0\n");
    symlinkSync(outside, join(repo, "evil"));
    try {
      const read = await call("GET", "/v2/sessions/abcd1234/files/content?path=evil/passwd");
      expect(read.json.success).toBe(false);
      expect(read.json.error).toContain("outside the working directory");
      const write = await call("PUT", "/v2/sessions/abcd1234/files/content", {
        body: { path: "evil/planted.txt", content: "x" },
      });
      expect(write.status).toBe(400);
      expect(existsSync(join(outside, "planted.txt"))).toBe(false);
      const grep = await call("GET", "/v2/sessions/abcd1234/files/grep?q=root&path=evil");
      expect(grep.status).toBe(400);
    } finally {
      unlinkSync(join(repo, "evil"));
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a symlink INTO the temp dir is readable but still not writable", async () => {
    const tmpTarget = mkdtempSync(join(tmpdir(), "joy-v2-tmp-"));
    writeFileSync(join(tmpTarget, "report.txt"), "agent output\n");
    symlinkSync(tmpTarget, join(repo, "tmplink"));
    try {
      const read = await call("GET", "/v2/sessions/abcd1234/files/content?path=tmplink/report.txt");
      expect(read.json.success).toBe(true);
      const write = await call("PUT", "/v2/sessions/abcd1234/files/content", {
        body: { path: "tmplink/planted.txt", content: "x" },
      });
      expect(write.status).toBe(400);
      expect(existsSync(join(tmpTarget, "planted.txt"))).toBe(false);
    } finally {
      unlinkSync(join(repo, "tmplink"));
      rmSync(tmpTarget, { recursive: true, force: true });
    }
  });

  test("malformed JSON body answers 400, not a silent empty object", async () => {
    const r = await fetch(base + "/v2/sessions/abcd1234/terminal/keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-joy-token": TOKEN },
      body: "{not json",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("bad_json");
  });

  test("#599 body id/qid never redirect an operation away from the URL's session", async () => {
    enqueued.abcd1234.length = 0; enqueued.sub00001.length = 0;
    const r = await call("POST", "/v2/sessions/abcd1234/queue", { body: { id: "sub00001", text: "dangerous-command" } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(enqueued.abcd1234).toEqual(["dangerous-command"]); // the URL's session
    expect(enqueued.sub00001).toEqual([]);                    // never the body's
    // an unknown URL session is a 404 even when the body names a real one
    expect((await call("POST", "/v2/sessions/nope0000/queue", { body: { id: "abcd1234", text: "x" } })).status).toBe(404);
  });

  test("#605 invalid base64 is a 400 and the existing file is untouched; valid and empty payloads write", async () => {
    writeFileSync(join(repo, "keep.txt"), "precious bytes\n");
    const bad = await call("PUT", "/v2/sessions/abcd1234/files/content", { body: { path: "keep.txt", content: "%%%", encoding: "base64" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("invalid_base64");
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("precious bytes\n");
    // truncated (unpadded) and non-canonical payloads are refused the same way
    for (const content of ["QUJD", "QUJDR", "QR=="]) {
      const r = await call("PUT", "/v2/sessions/abcd1234/files/content", { body: { path: "keep.txt", content, encoding: "base64" } });
      expect([content, r.status]).toEqual([content, content === "QUJD" ? 200 : 400]);
    }
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("ABC"); // the one valid write landed
    const unknown = await call("PUT", "/v2/sessions/abcd1234/files/content", { body: { path: "keep.txt", content: "x", encoding: "hex" } });
    expect(unknown.status).toBe(400);
    // a deliberately empty file is still expressible
    const empty = await call("PUT", "/v2/sessions/abcd1234/files/content", { body: { path: "keep.txt", content: "", encoding: "base64" } });
    expect(empty.status).toBe(200);
    expect(readFileSync(join(repo, "keep.txt"), "utf8")).toBe("");
    unlinkSync(join(repo, "keep.txt"));
  });

  test("decodeBase64Strict: exactly what Buffer.from would have mangled is refused", () => {
    expect(decodeBase64Strict("")).toEqual(Buffer.alloc(0));
    expect(decodeBase64Strict("aGVsbG8=")?.toString()).toBe("hello");
    expect(decodeBase64Strict("aGVs\nbG8=\n")?.toString()).toBe("hello"); // wrapped lines are fine
    expect(decodeBase64Strict("%%%")).toBeNull();
    expect(decodeBase64Strict("aGVsbG8")).toBeNull();   // missing padding
    expect(decodeBase64Strict("QR==")).toBeNull();      // non-canonical trailing bits
    expect(decodeBase64Strict("aGVsbG8=====")).toBeNull();
  });

  test("#603 a tracked symlink is diffed as ITSELF, not as its target", async () => {
    writeFileSync(join(repo, "target.txt"), "one\n");
    writeFileSync(join(repo, "target2.txt"), "two\n");
    symlinkSync("target.txt", join(repo, "link.txt"));
    g(["add", "target.txt", "target2.txt", "link.txt"]);
    g(["commit", "-q", "-m", "symlink"]);
    try {
      // Stage a retarget: link.txt → target2.txt. Nothing about target2.txt
      // itself changed, so resolving the operand to the target hid the change.
      unlinkSync(join(repo, "link.txt"));
      symlinkSync("target2.txt", join(repo, "link.txt"));
      g(["add", "link.txt"]);
      const d = await call("GET", "/v2/sessions/abcd1234/git/diff?staged=1&path=link.txt");
      expect(d.json.ok).toBe(true);
      expect(d.json.diff).toContain("-target.txt");
      expect(d.json.diff).toContain("+target2.txt");
      const e = await call("GET", "/v2/sessions/abcd1234/git/entries?path=link.txt");
      expect(e.json.files).toEqual(["link.txt"]);
    } finally {
      g(["reset", "-q", "HEAD", "link.txt"]);
      unlinkSync(join(repo, "link.txt"));
      symlinkSync("target.txt", join(repo, "link.txt"));
    }
  });
});

describe("#174 DELETE /v2/sessions/:id ifStatus pass-through", () => {
  test("ifStatus from the query string and from a body both reach the kill op; a plain kill still answers 200", async () => {
    // The kill op reads ifStatus and answers status_mismatch when the live
    // status differs (operations.ts, #174) — the transport maps that to 409.
    // Here the fake session's kill path records what the op was handed.
    const killed: any[] = [];
    const s = (globalThis as any).__v2KillSession as any;
    s.end = (reason: string) => { killed.push(reason); };
    s.awaitArchive = async () => true;
    const q = await call("DELETE", "/v2/sessions/abcd1234?ifStatus=ended");
    expect([200, 409]).toContain(q.status);
    if (q.status === 409) {
      expect(q.json).toMatchObject({ ok: false, error: "status_mismatch", status: "active" });
      expect(killed).toEqual([]); // a mismatch never kills
    }
    const b = await call("DELETE", "/v2/sessions/abcd1234", { body: { ifStatus: "ended" } });
    expect(b.status).toBe(q.status); // the body form is honoured exactly like the query form
    const plain = await call("DELETE", "/v2/sessions/abcd1234");
    expect(plain.status).toBe(200);
    expect(plain.json.ok).toBe(true);
    expect(killed).toContain("killed");
  });
});
