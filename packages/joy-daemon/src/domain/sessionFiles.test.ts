import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSessionFiles } from "./sessionFiles";

describe("listSessionFiles", () => {
  it("lists uploads and media newest first, never follows a symlink, and treats a missing dir as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "joy-session-files-"));
    mkdirSync(join(root, "uploads")); mkdirSync(join(root, "media"));
    writeFileSync(join(root, "uploads", "old.png"), "a");
    writeFileSync(join(root, "media", "new.png"), "bb");
    utimesSync(join(root, "uploads", "old.png"), new Date(1_000_000), new Date(1_000_000));
    symlinkSync("/etc/hostname", join(root, "uploads", "link"));
    const r = listSessionFiles(root);
    expect(r.files.map((f) => f.relativePath)).toEqual(["media/new.png", "uploads/old.png"]);
    expect(r.files[0]).toMatchObject({ name: "new.png", size: 2, path: join(root, "media", "new.png") });
    expect(r.truncated).toBe(false);
    expect(listSessionFiles(join(root, "nope")).files).toEqual([]);
  });
});
