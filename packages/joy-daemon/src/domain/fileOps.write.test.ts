// handleWriteFile durability + serialization (#539, #63), the tool argv jail
// (#537) and the filesystem-root containment fix (#536).
import { test, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { handleWriteFile, validatePath, jailToolArgs, handleRipgrep, handleDifftastic, withPathLock, jailedToolEnv } from "./fileOps";

let cwd: string;
beforeEach(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), "fileops-write-"))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

const b64 = (s: string) => Buffer.from(s).toString("base64");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });

// #539 — the original must survive a failed replacement.
test("a failed save (ENOSPC at rename) leaves the previous complete contents in place (#539)", async () => {
  const file = join(cwd, "src.ts");
  writeFileSync(file, "export const original = true;\n");
  vi.spyOn(fs.promises, "rename").mockRejectedValue(enospc());
  const r = await handleWriteFile(cwd, { path: "src.ts", content: b64("partial"), expectedHash: sha("export const original = true;\n") });
  expect(r.success).toBe(false);
  expect(r.error).toMatch(/ENOSPC/);
  expect(readFileSync(file, "utf8")).toBe("export const original = true;\n");
  expect(readdirSync(cwd).filter((f) => f.startsWith("."))).toEqual([]); // no temp leftovers
});

test("a successful save replaces the file and returns the new hash", async () => {
  const file = join(cwd, "a.txt");
  writeFileSync(file, "v1");
  const r = await handleWriteFile(cwd, { path: "a.txt", content: b64("v2"), expectedHash: sha("v1") });
  expect(r).toEqual({ success: true, hash: sha("v2") });
  expect(readFileSync(file, "utf8")).toBe("v2");
});

// #63 — compare-and-write is one critical section per path.
test("two concurrent writes with the same expectedHash: exactly one wins (#63)", async () => {
  const file = join(cwd, "shared.txt");
  writeFileSync(file, "base");
  const h = sha("base");
  const [a, b] = await Promise.all([
    handleWriteFile(cwd, { path: "shared.txt", content: b64("edit-A"), expectedHash: h }),
    handleWriteFile(cwd, { path: "./shared.txt", content: b64("edit-B"), expectedHash: h }),
  ]);
  const results = [a, b];
  expect(results.filter((r) => r.success)).toHaveLength(1);
  const loser = results.find((r) => !r.success)!;
  expect(loser.error).toMatch(/hash mismatch/);
  const winner = results.find((r) => r.success)!;
  expect(sha(readFileSync(file, "utf8"))).toBe(winner.hash);
});

test("withPathLock serializes per key and releases on throw", async () => {
  const order: string[] = [];
  const p1 = withPathLock("k", async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 20)); order.push("a-end"); });
  const p2 = withPathLock("k", async () => { order.push("b-start"); throw new Error("boom"); });
  const p3 = withPathLock("k", async () => { order.push("c"); });
  await p1; await expect(p2).rejects.toThrow("boom"); await p3;
  expect(order).toEqual(["a-start", "a-end", "b-start", "c"]);
});

// #536 — a session rooted at "/" must admit its descendants.
test("validatePath: a filesystem-root working directory admits descendants (#536)", () => {
  const inside = join(cwd, "local.txt");
  writeFileSync(inside, "x");
  const r = validatePath(inside, "/");
  expect(r.valid).toBe(true);
  expect(r.resolvedPath).toBe(inside);
  expect(validatePath("/", "/").valid).toBe(true);
});

// #537 — argv jail for rg / difft.
test("jailToolArgs: rejects path operands outside every allowed root", () => {
  const r = jailToolArgs("rg", ["-e", "secret", "/etc/passwd"], cwd);
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toMatch(/outside the working directory/);
  // Two positionals without -e: first is the pattern, the rest are paths.
  expect(jailToolArgs("rg", ["secret", "/etc"], cwd).ok).toBe(false);
  expect(jailToolArgs("rg", ["-e", "x", "--", "/etc/hosts"], cwd).ok).toBe(false);
  expect(jailToolArgs("difft", [join(cwd, "a"), "/etc/hostname"], cwd).ok).toBe(false);
});

test("jailToolArgs: refuses options that read or execute outside the jail", () => {
  for (const argv of [
    ["-f", "/etc/shadow", "./"],
    ["--file=/etc/shadow", "./"],
    ["--pre", "cat", "-e", "x", "./"],
    ["--pre-glob", "*", "-e", "x", "./"],
    ["-L", "-e", "x", "./"],
    ["--follow", "-e", "x", "./"],
    ["--ignore-file", "/root/.ssh/config", "-e", "x", "./"],
    ["--type-add", "x:/etc/*", "-e", "x", "./"],
    ["-in", "x", "./"], // combined short flags are not parsed → refused
    ["-e", "x", "-"],  // stdin operand
  ]) {
    const r = jailToolArgs("rg", argv, cwd);
    expect(r.ok, argv.join(" ")).toBe(false);
  }
  expect(jailToolArgs("difft", ["--list-languages"], cwd).ok).toBe(false);
  expect(jailToolArgs("difft", ["--context=abc", join(cwd, "a"), join(cwd, "b")], cwd).ok).toBe(false);
  expect(jailToolArgs("rg", "not-an-array", cwd).ok).toBe(false);
});

test("jailToolArgs: the app's own typed argv shapes pass unchanged", () => {
  mkdirSync(join(cwd, "src"));
  const rgArgv = ["--line-number", "--with-filename", "--no-heading", "-i", "-g", "*.ts", "-m", "100", "-e", "needle", "./"];
  expect(jailToolArgs("rg", rgArgv, cwd)).toEqual({ ok: true, args: rgArgv, pathOperands: ["./"] });
  expect(jailToolArgs("rg", ["--files", "src"], cwd).ok).toBe(true);
  expect(jailToolArgs("rg", ["-C", "3", "--color=never", "needle", "src"], cwd).ok).toBe(true);
  const difftArgv = ["--context", "3", join(cwd, "src", "a.ts"), join(cwd, "src", "b.ts")];
  expect(jailToolArgs("difft", difftArgv, cwd)).toEqual({ ok: true, args: difftArgv, pathOperands: difftArgv.slice(2) });
  // Extra read roots (the temp dirs) are honored for grep.
  expect(jailToolArgs("rg", ["-e", "x", "/tmp"], cwd, ["/tmp"]).ok).toBe(true);
});

test("handleRipgrep / handleDifftastic refuse jailed-out argv before spawning anything", async () => {
  const rg = await handleRipgrep(cwd, { args: ["-e", "x", "/etc/passwd"] });
  expect(rg.success).toBe(false);
  expect(rg.error).toMatch(/outside the working directory/);
  const dt = await handleDifftastic(cwd, { args: [join(cwd, "a"), "/etc/passwd"] });
  expect(dt.success).toBe(false);
  expect(dt.error).toMatch(/outside the working directory/);
  const pre = await handleRipgrep(cwd, { args: ["--pre", "sh", "-e", "x", "./"] });
  expect(pre.error).toMatch(/not allowed/);
});

// #537 residual (Astra): configuration the tool inherits — not the argv the
// jail inspects — must not widen the jail. A RIPGREP_CONFIG_PATH file adding
// `--follow` made a plain `rg pattern .` walk a symlink out of the tree.
test("handleRipgrep: an inherited rg config with --follow cannot read through a symlink out of the jail (#537)", async () => {
  const outside = mkdtempSync(join(tmpdir(), "fileops-outside-"));
  const cfg = join(outside, "ripgreprc");
  try {
    writeFileSync(join(outside, "secret.txt"), "OUTSIDE_SENTINEL_9d1f\n");
    writeFileSync(cfg, "--follow\n");
    fs.symlinkSync(outside, join(cwd, "escape")); // a link inside the jail to the outside dir
    writeFileSync(join(cwd, "inside.txt"), "INSIDE_SENTINEL_9d1f\n");
    const prev = process.env.RIPGREP_CONFIG_PATH;
    process.env.RIPGREP_CONFIG_PATH = cfg;
    try {
      const r = await handleRipgrep(cwd, { args: ["-n", "SENTINEL_9d1f", "."] });
      expect(r.success).toBe(true);
      expect(r.stdout).toContain("inside.txt");          // the jail itself still works
      expect(r.stdout).not.toContain("OUTSIDE_SENTINEL"); // the symlinked-out file is never followed
      expect(r.stdout).not.toContain("escape/");
      // The config env never reaches the child at all.
      expect(jailedToolEnv().RIPGREP_CONFIG_PATH).toBeUndefined();
      expect(jailedToolEnv({ FORCE_COLOR: "1" })).toMatchObject({ FORCE_COLOR: "1" });
    } finally {
      if (prev === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = prev;
    }
    // difftastic's own config channel is dropped the same way.
    process.env.DFT_DISPLAY = "side-by-side";
    try { expect(jailedToolEnv().DFT_DISPLAY).toBeUndefined(); } finally { delete process.env.DFT_DISPLAY; }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
