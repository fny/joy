import { test, expect } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { validatePath } from "./fileOps";

const CWD = "/tmp/proj";

test("validatePath: inside cwd ok, outside denied (jail unchanged)", () => {
  expect(validatePath("src/a.ts", CWD).valid).toBe(true);
  expect(validatePath("/etc/passwd", CWD).valid).toBe(false);
  expect(validatePath("../other", CWD).valid).toBe(false);
});

test("validatePath: extra root admits exactly that subtree", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath(join(root, "media", "x.webp"), CWD, [root]).valid).toBe(true);
  expect(validatePath(root, CWD, [root]).valid).toBe(true);
  // A SIBLING session's dir is NOT admitted — the root is per-session.
  const other = join(homedir(), ".joy", "sessions", "zzz999", "media", "x.webp");
  expect(validatePath(other, CWD, [root]).valid).toBe(false);
  // Prefix trickery: root path as a string prefix of a different dir.
  expect(validatePath(root + "-evil/x", CWD, [root]).valid).toBe(false);
});

test("validatePath: leading ~ expands to home before the jail check", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath("~/.joy/sessions/abc123/media/x.webp", CWD, [root]).valid).toBe(true);
  expect(validatePath("~/.ssh/id_ed25519", CWD, [root]).valid).toBe(false);
});

test("validatePath: traversal out of the extra root is denied", () => {
  const root = join(homedir(), ".joy", "sessions", "abc123");
  expect(validatePath(join(root, "..", "zzz999", "x.webp"), CWD, [root]).valid).toBe(false);
});

// ── symlink containment (review fix): the jail is enforced on REAL paths ────
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { afterAll } from "vitest";

const jailDir = mkdtempSync(join(tmpdir(), "joy-jail-"));
const outsideDir = mkdtempSync(join(tmpdir(), "joy-outside-"));
afterAll(() => {
  rmSync(jailDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

test("validatePath: a symlink out of the jail is denied for reads and writes", () => {
  writeFileSync(join(outsideDir, "secret.txt"), "s");
  symlinkSync(outsideDir, join(jailDir, "link"));
  // Read through the link (target exists).
  expect(validatePath("link/secret.txt", jailDir).valid).toBe(false);
  // The link itself.
  expect(validatePath("link", jailDir).valid).toBe(false);
  // Write through a symlinked parent (target file does not exist yet).
  expect(validatePath("link/new.txt", jailDir).valid).toBe(false);
});

test("validatePath: symlinks that stay inside the jail are fine", () => {
  mkdirSync(join(jailDir, "real"));
  writeFileSync(join(jailDir, "real", "a.txt"), "a");
  symlinkSync(join(jailDir, "real"), join(jailDir, "inner"));
  const v = validatePath("inner/a.txt", jailDir);
  expect(v.valid).toBe(true);
  // resolvedPath is the REAL path — downstream ops can't re-chase the link.
  expect(v.resolvedPath).toBe(join(realpathSync(jailDir), "real", "a.txt"));
});

test("validatePath: a cwd that is itself a symlink still admits its own files", () => {
  const alias = join(outsideDir, "alias");
  symlinkSync(jailDir, alias);
  expect(validatePath("real/a.txt", alias).valid).toBe(true);
  expect(validatePath("link/secret.txt", alias).valid).toBe(false); // escape still caught
});

test("validatePath: extra root reached through an escaping symlink is denied", () => {
  // A link inside cwd pointing at a NON-admitted place is denied even when
  // an extra root exists.
  expect(validatePath("link/secret.txt", jailDir, [join(jailDir, "real")]).valid).toBe(false);
});

test("validatePath: a DANGLING symlink out of the jail is denied (write escape)", () => {
  // link → /outside/newfile that does not exist yet: must not pass as an
  // unborn plain suffix (the pre-fix realResolve bug).
  symlinkSync(join(outsideDir, "newfile.txt"), join(jailDir, "danglingOut"));
  expect(validatePath("danglingOut", jailDir).valid).toBe(false);
  expect(validatePath("danglingOut/child.txt", jailDir).valid).toBe(false);
});
