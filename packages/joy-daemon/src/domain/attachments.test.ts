import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { sniffMimeAndExt, uploadNameParts, uploadNameCandidates, writeUpload, writeAttachmentExclusive, uploadTimestamp } from "./attachments";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const text = (s: string) => new TextEncoder().encode(s);
const dir = () => mkdtempSync(join(tmpdir(), "joy-upload-"));
const at = new Date(2026, 8, 11, 8, 15, 18); // local 2026-09-11 08:15:18

test("sniffMimeAndExt: png / jpeg / not an image", () => {
  expect(sniffMimeAndExt(png)?.ext).toBe("png");
  expect(sniffMimeAndExt(jpg)?.ext).toBe("jpg");
  expect(sniffMimeAndExt(text("hello"))).toBeNull();
});

test("uploadNameParts: keeps the name, drops directories and control characters, falls back to paste", () => {
  expect(uploadNameParts("report.pdf", text("x"))).toEqual({ stem: "report", ext: ".pdf" });
  expect(uploadNameParts("../../etc/passwd", text("x"))).toEqual({ stem: "passwd", ext: "" });
  expect(uploadNameParts("a	b.txt", text("x"))).toEqual({ stem: "ab", ext: ".txt" });
  expect(uploadNameParts(undefined, png)).toEqual({ stem: "paste", ext: ".png" });
  expect(uploadNameParts("   ", text("x"))).toEqual({ stem: "paste", ext: "" });
  expect(uploadNameParts(".env", text("x"))).toEqual({ stem: ".env", ext: "" });
});

test("uploadNameParts: an image keeps its name but gets the extension of what it really is", () => {
  expect(uploadNameParts("IMG_2041.HEIC", jpg)).toEqual({ stem: "IMG_2041", ext: ".jpg" });
  expect(uploadNameParts("shot.jpeg", jpg)).toEqual({ stem: "shot", ext: ".jpeg" }); // jpeg IS jpg
  expect(uploadNameParts("shot.PNG", png)).toEqual({ stem: "shot", ext: ".PNG" });
  expect(uploadNameParts("screenshot", png)).toEqual({ stem: "screenshot", ext: ".png" });
});

test("uploadNameCandidates: name.ext, then name.<timestamp>.ext, then -2, -3 …", () => {
  const next = uploadNameCandidates("report", ".pdf", at);
  expect([next(), next(), next(), next()]).toEqual([
    "report.pdf", "report.20260911-081518.pdf", "report.20260911-081518-2.pdf", "report.20260911-081518-3.pdf",
  ]);
  expect(uploadTimestamp(at)).toBe("20260911-081518");
});

test("writeUpload: creates the directory, keeps the name, and only a taken name gets the timestamp", () => {
  const d = join(dir(), "uploads");
  const first = writeUpload(d, text("one"), "notes.txt", at)!;
  const second = writeUpload(d, text("two"), "notes.txt", at)!;
  const third = writeUpload(d, text("three"), "notes.txt", at)!;
  expect([basename(first), basename(second), basename(third)]).toEqual(["notes.txt", "notes.20260911-081518.txt", "notes.20260911-081518-2.txt"]);
  expect(first).toBe(join(d, "notes.txt")); // absolute: this is what goes into the prompt
  expect(readFileSync(first, "utf8")).toBe("one"); // never truncated by a later upload
  expect(writeUpload(d, new Uint8Array(0), "empty.txt")).toBeNull();
});

test("writeUpload: a dangling symlink at the name is never followed — the upload lands beside it (#530)", () => {
  const d = dir();
  symlinkSync(join(d, "nowhere"), join(d, "report.txt"));
  const p = writeUpload(d, text("payload"), "report.txt", at)!;
  expect(basename(p)).toBe("report.20260911-081518.txt");
  expect(existsSync(join(d, "nowhere"))).toBe(false);
});

test("writeAttachmentExclusive: gives up after the attempts it is allowed", () => {
  const d = dir();
  writeAttachmentExclusive(d, new Uint8Array([1]), () => "data.txt");
  expect(() => writeAttachmentExclusive(d, new Uint8Array([1]), () => "data.txt")).toThrow(/free name/);
});
