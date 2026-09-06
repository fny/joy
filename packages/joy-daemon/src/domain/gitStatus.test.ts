// Structured git status (Wave E2). Two layers: byte-fixture tests for the
// three machine-format parsers, and real temp repositories driven through
// readGitStatus for the shapes that only git itself can produce (unborn and
// detached HEAD, a linked worktree, add/add and delete/delete conflicts, a
// subdirectory session, a cwd that is not a repository).
import { test, expect, describe, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { readGitStatus, parsePorcelainV2Z, parseNumstatZ, parseForEachRefZ, makeGitPath, splitNul, type GitStatusRepo, type GitStatusResult } from "./gitStatus";

const NUL = "\0";
const buf = (...parts: string[]) => Buffer.from(parts.join(NUL) + NUL, "utf8");

// ── parsers over byte fixtures ──────────────────────────────────────────────

describe("parsePorcelainV2Z", () => {
  test("headers: branch, oid, upstream, ahead/behind, stash — values never trimmed", () => {
    const { headers } = parsePorcelainV2Z(buf(
      "# branch.oid abcdef",
      "# branch.head feature nbsp ",
      "# branch.upstream origin/feature",
      "# branch.ab +3 -1",
      "# stash 2",
    ));
    expect(headers).toEqual({ oid: "abcdef", head: "feature nbsp ", upstream: "origin/feature", ab: { ahead: 3, behind: 1 }, stash: 2 });
  });

  test("unborn and detached heads are distinct header states", () => {
    expect(parsePorcelainV2Z(buf("# branch.oid (initial)", "# branch.head main")).headers).toMatchObject({ oid: "(initial)", head: "main" });
    expect(parsePorcelainV2Z(buf("# branch.oid 1234", "# branch.head (detached)")).headers).toMatchObject({ oid: "1234", head: "(detached)" });
  });

  test("paths with spaces, quotes, newlines, pipes, a trailing space and a leading BOM arrive verbatim", () => {
    const names = ['quo"te.txt', "new\nline.txt", "a|b.txt", "trailing ", "﻿bom.txt", "  two leading.txt", "__proto__"];
    const { records } = parsePorcelainV2Z(buf(...names.map(n => `1 .M N... 100644 100644 100644 aaaa bbbb ${n}`)));
    expect(records.map(r => r.path.toString("utf8"))).toEqual(names);
    expect(records.every(r => r.kind === "ordinary" && r.xy === ".M")).toBe(true);
  });

  test("rename record takes the FOLLOWING record as its source and keeps the score", () => {
    const { records } = parsePorcelainV2Z(buf(
      "2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.txt", "old name.txt",
      "2 C. N... 100644 100644 100644 aaaa bbbb C75 copy.txt", "orig.txt",
      "1 .M N... 100644 100644 100644 aaaa bbbb after.txt",
    ));
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ kind: "rename", xy: "R.", score: { copy: false, value: 100 } });
    expect(records[0].path.toString()).toBe("new name.txt");
    expect(records[0].from!.toString()).toBe("old name.txt");
    expect(records[1]).toMatchObject({ kind: "rename", score: { copy: true, value: 75 } });
    expect(records[2].path.toString()).toBe("after.txt"); // the source did not swallow the next entry
  });

  test("unmerged records: AA and DD are conflicts even without a U column", () => {
    const { records } = parsePorcelainV2Z(buf(
      "u AA N... 100644 100644 100644 100644 a1 a2 a3 both-added.txt",
      "u DD N... 100644 100644 100644 100644 d1 d2 d3 both deleted.txt",
      "u UU N... 100644 100644 100644 100644 u1 u2 u3 classic.txt",
    ));
    expect(records.map(r => [r.kind, r.xy, r.path.toString()])).toEqual([
      ["unmerged", "AA", "both-added.txt"],
      ["unmerged", "DD", "both deleted.txt"],
      ["unmerged", "UU", "classic.txt"],
    ]);
  });

  test("untracked records and ignored records", () => {
    const { records } = parsePorcelainV2Z(buf("? untracked file.txt", "! ignored.log"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "untracked", xy: "??" });
    expect(records[0].path.toString()).toBe("untracked file.txt");
  });

  test("non-UTF-8 filename bytes survive as bytes", () => {
    const raw = Buffer.concat([Buffer.from("1 .M N... 100644 100644 100644 aaaa bbbb "), Buffer.from([0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]), Buffer.from([0])]);
    const { records } = parsePorcelainV2Z(raw);
    expect([...records[0].path]).toEqual([0xff, 0xfe, 0x2e, 0x74, 0x78, 0x74]);
  });

  test("submodule flag comes from the sub field", () => {
    const { records } = parsePorcelainV2Z(buf("1 .M SC.. 160000 160000 160000 aaaa bbbb vendor/lib"));
    expect(records[0].sub[0]).toBe("S");
  });
});

describe("parseNumstatZ", () => {
  test("plain, binary and two-path rename records", () => {
    const recs = parseNumstatZ(buf("3\t1\tplain.txt", "-\t-\timg.png", "0\t0\t", "old.txt", "new dir/new.txt", "5\t2\ttrailing "));
    expect(recs.map(r => ({ a: r.added, d: r.removed, b: r.binary, p: r.path.toString(), f: r.from?.toString() }))).toEqual([
      { a: 3, d: 1, b: false, p: "plain.txt", f: undefined },
      { a: null, d: null, b: true, p: "img.png", f: undefined },
      { a: 0, d: 0, b: false, p: "new dir/new.txt", f: "old.txt" },
      { a: 5, d: 2, b: false, p: "trailing ", f: undefined },
    ]);
  });

  test("a pipe or tab inside the filename is part of the filename", () => {
    const recs = parseNumstatZ(buf("1\t0\ta|b.txt", "2\t0\ttab\there.txt"));
    expect(recs.map(r => r.path.toString())).toEqual(["a|b.txt", "tab\there.txt"]);
  });

  test("empty output → no records", () => {
    expect(parseNumstatZ(Buffer.alloc(0))).toEqual([]);
  });
});

describe("parseForEachRefZ", () => {
  test("five NUL-terminated fields per record with git's LF between records", () => {
    const out = Buffer.from(
      ["main", "aaaa", "*", "/repo", ""].join(NUL) + NUL + "\n" +
      ["other", "bbbb", " ", "", "origin/other"].join(NUL) + NUL + "\n" +
      ["wt", "cccc", " ", "/repo/.wt\nnl", ""].join(NUL) + NUL + "\n", "utf8");
    expect(parseForEachRefZ(out)).toEqual([
      { name: "main", oid: "aaaa", current: true, worktree: "/repo", upstream: null },
      { name: "other", oid: "bbbb", current: false, worktree: null, upstream: "origin/other" },
      { name: "wt", oid: "cccc", current: false, worktree: "/repo/.wt\nnl", upstream: null },
    ]);
  });
});

describe("makeGitPath", () => {
  test("repo vs cwd identity, display escapes controls, BOM preserved", () => {
    const p = makeGitPath(Buffer.from("sub/dir/new\nline.txt"), "sub/");
    expect(p).toEqual({ repo: "sub/dir/new\nline.txt", cwd: "dir/new\nline.txt", display: "dir/new␊line.txt", utf8: true });
    const bom = makeGitPath(Buffer.from("﻿notes.txt"), "");
    expect(bom.cwd).toBe("﻿notes.txt"); // #357: the leading BOM is part of the name
    const outside = makeGitPath(Buffer.from("other/x.txt"), "sub/");
    expect(outside.cwd).toBe("../other/x.txt");
  });

  test("non-UTF-8 bytes: lossy strings plus exact raw bytes", () => {
    const p = makeGitPath(Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]), "");
    expect(p.utf8).toBe(false);
    expect(p.cwd).toBe("�.txt");
    expect(Buffer.from(p.rawBase64!, "base64")).toEqual(Buffer.from([0xff, 0x2e, 0x74, 0x78, 0x74]));
  });

  test("splitNul keeps empty interior records and drops only the terminator", () => {
    expect(splitNul(Buffer.from("a\0\0b\0")).map(String)).toEqual(["a", "", "b"]);
    expect(splitNul(Buffer.from("a\0b")).map(String)).toEqual(["a", "b"]);
  });
});

// ── real repositories ───────────────────────────────────────────────────────

let base = "";
const dirs: string[] = [];
function fresh(name: string): string {
  const d = mkdtempSync(join(base, `${name}-`));
  dirs.push(d);
  return d;
}
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
function initRepo(name: string): string {
  const d = fresh(name);
  g(d, "init", "-q", "-b", "main");
  g(d, "config", "user.email", "t@t");
  g(d, "config", "user.name", "t");
  g(d, "config", "commit.gpgsign", "false");
  return d;
}
const commitAll = (d: string, msg: string) => { g(d, "add", "-A"); g(d, "commit", "-q", "-m", msg); };
const repoOf = (r: GitStatusResult): GitStatusRepo => { if (!(r.ok && r.relation !== "none")) throw new Error(JSON.stringify(r)); return r; };
const byCwd = (r: GitStatusRepo) => new Map(r.entries.map(e => [e.path.cwd, e]));

beforeAll(() => { base = mkdtempSync(join(tmpdir(), "joy-gitstatus-")); });
afterAll(() => { rmSync(base, { recursive: true, force: true }); });

describe("readGitStatus on real repositories", () => {
  test("not a repository", async () => {
    const d = fresh("plain");
    const r = await readGitStatus(d);
    expect(r).toEqual({ v: 2, ok: true, relation: "none", cwd: d });
  });

  test("unborn HEAD: staged additions count, nothing pretends to be a commit", async () => {
    const d = initRepo("unborn");
    writeFileSync(join(d, "a.txt"), "one\ntwo\n");
    g(d, "add", "a.txt");
    const r = repoOf(await readGitStatus(d));
    expect(r.head).toEqual({ kind: "unborn", name: "main" });
    expect(r.relation).toBe("root");
    expect(r.branches).toEqual([]);
    const a = byCwd(r).get("a.txt")!;
    expect(a.index).toBe("A");
    expect(a.lines.staged).toEqual({ added: 2, removed: 0 });
    expect(r.totals.staged).toEqual({ added: 2, removed: 0 });
    expect(r.totals.counts).toEqual({ staged: 1, unstaged: 0, untracked: 0, conflicted: 0, entries: 1 });
  });

  test("hard filenames: quotes, unicode, whitespace, pipe, newline, BOM, __proto__, non-UTF-8", async () => {
    const d = initRepo("names");
    writeFileSync(join(d, "base.txt"), "x\n");
    commitAll(d, "init");
    const names = ['quo"te.txt', "é.txt", " leading.txt", "trailing ", "a|b.txt", "new\nline.txt", "﻿bom.txt", "__proto__", "tab\there.txt"];
    for (const n of names) writeFileSync(join(d, n), "1\n2\n3\n");
    const rawName = Buffer.concat([Buffer.from(d + "/"), Buffer.from([0xff, 0xfe]), Buffer.from(".bin")]);
    writeFileSync(rawName, "raw\n");
    g(d, "add", "--", 'quo"te.txt', "é.txt", "a|b.txt");
    const r = repoOf(await readGitStatus(d));
    const m = byCwd(r);
    for (const n of names) expect(m.has(n), n).toBe(true);
    expect(m.get('quo"te.txt')!.index).toBe("A");
    expect(m.get('quo"te.txt')!.lines.staged).toEqual({ added: 3, removed: 0 });
    expect(m.get("é.txt")!.lines.staged).toEqual({ added: 3, removed: 0 });
    expect(m.get("a|b.txt")!.lines.staged).toEqual({ added: 3, removed: 0 });
    expect(m.get("trailing ")!.untracked).toBe(true);
    expect(m.get("new\nline.txt")!.path.display).toBe("new␊line.txt");
    expect(m.get("tab\there.txt")!.path.display).toBe("tab␉here.txt");
    expect(m.get("﻿bom.txt")!.path.repo).toBe("﻿bom.txt");
    // untracked entries: no staged change (0/0 is a fact), worktree counts unknown
    expect(m.get("__proto__")!.lines).toEqual({ staged: { added: 0, removed: 0 }, unstaged: "unavailable" });
    const raw = r.entries.find(e => !e.path.utf8)!;
    expect(raw).toBeDefined();
    expect(raw.path.cwd).toBe("��.bin");
    expect(Buffer.from(raw.path.rawBase64!, "base64")).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(".bin")]));
    expect(r.totals.counts.staged).toBe(3);
    expect(r.totals.counts.untracked).toBe(names.length - 3 + 1);
  });

  test("renames: destination is the identity, source is carried, stats keyed by destination", async () => {
    const d = initRepo("rename");
    writeFileSync(join(d, "old name.txt"), "a\nb\nc\n");
    commitAll(d, "init");
    g(d, "mv", "old name.txt", "new name.txt");
    writeFileSync(join(d, "new name.txt"), "a\nb\nc\nd\n");
    g(d, "add", "new name.txt");
    const r = repoOf(await readGitStatus(d));
    const e = byCwd(r).get("new name.txt")!;
    expect(e.index).toBe("R");
    expect(e.rename).toEqual({ from: { repo: "old name.txt", cwd: "old name.txt", display: "old name.txt", utf8: true }, score: expect.any(Number), copy: false });
    expect(e.lines.staged).toEqual({ added: 1, removed: 0 });
    expect(byCwd(r).has("old name.txt")).toBe(false);
  });

  test("binary files: flagged, line counts unavailable, totals exclude them", async () => {
    const d = initRepo("binary");
    writeFileSync(join(d, "img.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(d, "text.txt"), "a\n");
    commitAll(d, "init");
    writeFileSync(join(d, "img.bin"), Buffer.from([0, 1, 2, 3, 4, 5]));
    writeFileSync(join(d, "text.txt"), "a\nb\n");
    const r = repoOf(await readGitStatus(d));
    const m = byCwd(r);
    expect(m.get("img.bin")!.binary).toBe(true);
    expect(m.get("img.bin")!.lines).toEqual({ staged: { added: 0, removed: 0 }, unstaged: "unavailable" });
    expect(m.get("text.txt")!.binary).toBe(false);
    expect(m.get("text.txt")!.lines.unstaged).toEqual({ added: 1, removed: 0 });
    expect(r.totals.unstaged).toEqual({ added: 1, removed: 0 });
  });

  test("AA and DD conflicts are conflicts; a conflict-only tree is not clean; operation is merge", async () => {
    const d = initRepo("conflict");
    writeFileSync(join(d, "gone.txt"), "shared\n");
    writeFileSync(join(d, "base.txt"), "base\n");
    commitAll(d, "init");
    g(d, "checkout", "-q", "-b", "side");
    writeFileSync(join(d, "both.txt"), "side version\n");
    g(d, "rm", "-q", "gone.txt");
    writeFileSync(join(d, "keep.txt"), "side\n"); // so the deletion is not the only change
    commitAll(d, "side");
    g(d, "checkout", "-q", "main");
    writeFileSync(join(d, "both.txt"), "main version\n");
    g(d, "rm", "-q", "gone.txt");
    commitAll(d, "main");
    let threw = false;
    try { g(d, "merge", "side"); } catch { threw = true; }
    expect(threw).toBe(true);
    const r = repoOf(await readGitStatus(d));
    const m = byCwd(r);
    const both = m.get("both.txt")!;
    expect(both.conflict).toEqual({ xy: "AA" });
    expect(both.index).toBe("A");
    expect(both.worktree).toBe("A");
    expect(r.operation).toBe("merge");
    expect(r.clean).toBe(false);
    expect(r.totals.counts.conflicted).toBe(1);
    expect(m.get("keep.txt")!.index).toBe("A"); // the merge staged the clean side
    expect(r.totals.counts.staged).toBe(1);
  });

  test("DD conflict", async () => {
    const d = initRepo("dd");
    writeFileSync(join(d, "f.txt"), "a\n");
    commitAll(d, "init");
    g(d, "checkout", "-q", "-b", "side");
    g(d, "mv", "f.txt", "g.txt");
    commitAll(d, "side renames");
    g(d, "checkout", "-q", "main");
    g(d, "mv", "f.txt", "h.txt");
    commitAll(d, "main renames");
    let threw = false;
    try { g(d, "merge", "side"); } catch { threw = true; }
    expect(threw).toBe(true);
    const r = repoOf(await readGitStatus(d));
    const f = byCwd(r).get("f.txt");
    expect(f?.conflict).toEqual({ xy: "DD" });
    expect(r.totals.counts.conflicted).toBeGreaterThanOrEqual(1);
  });

  test("detached HEAD, upstream ahead/behind, stash count, branch list with current marker", async () => {
    const d = initRepo("detached");
    writeFileSync(join(d, "a.txt"), "1\n");
    commitAll(d, "one");
    writeFileSync(join(d, "a.txt"), "1\n2\n");
    commitAll(d, "two");
    g(d, "branch", "other");
    // upstream: track our own other branch, then move ahead by one commit
    g(d, "branch", "--set-upstream-to=other", "main");
    writeFileSync(join(d, "a.txt"), "1\n2\n3\n");
    commitAll(d, "three");
    writeFileSync(join(d, "a.txt"), "stash me\n");
    g(d, "stash", "-q");
    let r = repoOf(await readGitStatus(d));
    expect(r.head).toMatchObject({ kind: "branch", name: "main" });
    expect(r.upstream).toEqual({ name: "other", ahead: 1, behind: 0 });
    expect(r.stashCount).toBe(1);
    expect(r.branches.map(b => [b.name, b.current])).toEqual([["main", true], ["other", false]]);
    expect(r.branches.find(b => b.name === "main")!.upstream).toBe("other");
    expect(r.branches.find(b => b.name === "main")!.worktree).toBe(r.repository.root);
    g(d, "checkout", "-q", "--detach", "HEAD~1");
    r = repoOf(await readGitStatus(d));
    expect(r.head.kind).toBe("detached");
    expect((r.head as { oid: string }).oid).toMatch(/^[0-9a-f]{40}$/);
    expect(r.upstream).toBeNull();
    expect(r.branches.every(b => !b.current)).toBe(true);
  });

  test("rebase in progress is detached with operation=rebase, not a pseudo-branch", async () => {
    const d = initRepo("rebase");
    writeFileSync(join(d, "a.txt"), "base\n");
    commitAll(d, "init");
    g(d, "checkout", "-q", "-b", "topic");
    writeFileSync(join(d, "a.txt"), "topic\n");
    commitAll(d, "topic");
    g(d, "checkout", "-q", "main");
    writeFileSync(join(d, "a.txt"), "main\n");
    commitAll(d, "main");
    g(d, "checkout", "-q", "topic");
    let threw = false;
    try { g(d, "rebase", "main"); } catch { threw = true; }
    expect(threw).toBe(true);
    const r = repoOf(await readGitStatus(d));
    expect(r.head.kind).toBe("detached");
    expect(r.operation).toBe("rebase");
    expect(r.branches.map(b => b.name).sort()).toEqual(["main", "topic"]);
    g(d, "rebase", "--abort");
  });

  test("linked worktree: flagged, its own branch is current, the main checkout's is not", async () => {
    const d = initRepo("wt");
    writeFileSync(join(d, "a.txt"), "1\n");
    commitAll(d, "one");
    const wt = join(base, "linked-wt");
    g(d, "worktree", "add", "-q", "-b", "wtbranch", wt);
    dirs.push(wt);
    writeFileSync(join(wt, "a.txt"), "1\n2\n");
    const r = repoOf(await readGitStatus(wt));
    expect(r.repository.linkedWorktree).toBe(true);
    expect(r.repository.root).toBe(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: wt }).toString().replace(/\n$/, ""));
    expect(r.head).toMatchObject({ kind: "branch", name: "wtbranch" });
    const cur = r.branches.filter(b => b.current).map(b => b.name);
    expect(cur).toEqual(["wtbranch"]);
    expect(r.branches.find(b => b.name === "main")!.worktree).toBe(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: d }).toString().replace(/\n$/, ""));
    expect(byCwd(r).get("a.txt")!.lines.unstaged).toEqual({ added: 1, removed: 0 });
    const main = repoOf(await readGitStatus(d));
    expect(main.repository.linkedWorktree).toBe(false);
    expect(main.clean).toBe(true);
  });

  test("subdirectory session: relation=inside, cwd-relative identity, repo-relative kept, scoped to the cwd", async () => {
    const d = initRepo("sub");
    mkdirSync(join(d, "sub", "deep"), { recursive: true });
    writeFileSync(join(d, "root.txt"), "r\n");
    writeFileSync(join(d, "sub", "deep", "inner.txt"), "i\n");
    writeFileSync(join(d, "sub", "moved.txt"), "m\n");
    commitAll(d, "init");
    writeFileSync(join(d, "root.txt"), "r\nr2\n");
    writeFileSync(join(d, "sub", "deep", "inner.txt"), "i\ni2\n");
    g(d, "mv", "sub/moved.txt", "elsewhere.txt");
    const r = repoOf(await readGitStatus(join(d, "sub")));
    expect(r.relation).toBe("inside");
    expect(r.repository.prefix).toBe("sub/");
    const m = byCwd(r);
    expect(m.has("deep/inner.txt")).toBe(true);
    expect(m.get("deep/inner.txt")!.path.repo).toBe("sub/deep/inner.txt");
    expect(m.get("deep/inner.txt")!.lines.unstaged).toEqual({ added: 1, removed: 0 });
    expect(m.has("root.txt")).toBe(false); // outside the cwd: not reported
    expect(m.has("../root.txt")).toBe(false);
    // the whole-repo view still sees everything, root-relative
    const whole = repoOf(await readGitStatus(d));
    expect(byCwd(whole).has("root.txt")).toBe(true);
    expect(byCwd(whole).has("sub/deep/inner.txt")).toBe(true);
    const mv = byCwd(whole).get("elsewhere.txt")!;
    expect(mv.rename?.from.repo).toBe("sub/moved.txt");
  });

  test("a failed numstat read is 'unavailable', never zero", async () => {
    const d = initRepo("numstat-fail");
    writeFileSync(join(d, "a.txt"), "1\n");
    commitAll(d, "init");
    writeFileSync(join(d, "a.txt"), "1\n2\n");
    const { runGit } = await import("./gitStatus");
    const failingDiff: typeof runGit = (cwd, args) => args.includes("--numstat") && !args.includes("--cached")
      ? Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: "fatal: boom\n", spawnError: null, timedOut: false })
      : runGit(cwd, args);
    const r = repoOf(await readGitStatus(d, failingDiff));
    expect(byCwd(r).get("a.txt")!.lines.unstaged).toBe("unavailable");
    expect(r.totals.unstaged).toBe("unavailable");
    expect(r.totals.staged).toEqual({ added: 0, removed: 0 });
  });

  test("git missing / failing surfaces as ok:false with a code", async () => {
    const d = initRepo("nogit");
    const missing = () => Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: "", spawnError: "ENOENT", timedOut: false });
    expect(await readGitStatus(d, missing)).toEqual({ v: 2, ok: false, code: "git_missing", error: expect.any(String) });
    const dubious = () => Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: "fatal: detected dubious ownership in repository\n", spawnError: null, timedOut: false });
    expect(await readGitStatus(d, dubious)).toMatchObject({ v: 2, ok: false, code: "git_failed", error: "fatal: detected dubious ownership in repository" });
  });
});
