import { test, expect } from "vitest";
import { mkdtempSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { sniffMimeAndExt, uploadNameParts, uploadNameCandidates, writeUpload, writeAttachmentExclusive, uploadTimestamp, UPLOAD_PREFIX } from "./attachments";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const text = (s: string) => new TextEncoder().encode(s);
const dir = () => mkdtempSync(join(tmpdir(), "joy-upload-"));
const at = new Date(Date.UTC(2026, 8, 11, 16, 21, 40)); // 2026-09-11 16:21:40 UTC

test("sniffMimeAndExt: png / jpeg / not an image", () => {
  expect(sniffMimeAndExt(png)?.ext).toBe("png");
  expect(sniffMimeAndExt(jpg)?.ext).toBe("jpg");
  expect(sniffMimeAndExt(text("hello"))).toBeNull();
});

test("uploadTimestamp is UTC", () => {
  expect(uploadTimestamp(at)).toBe("20260911-162140");
});

test("a name the source gave is kept; an image's extension follows its bytes", () => {
  expect(uploadNameParts("report.pdf", text("x"), { source: "paste" })).toEqual({ stem: "report", ext: ".pdf" });    // a copied file, pasted
  expect(uploadNameParts("IMG_2041.HEIC", jpg, { source: "library" })).toEqual({ stem: "IMG_2041", ext: ".jpg" }); // library photo
  expect(uploadNameParts("report.pdf", text("x"), { source: "document" })).toEqual({ stem: "report", ext: ".pdf" });
  expect(uploadNameParts("notes.txt", text("x"), { source: "drop" })).toEqual({ stem: "notes", ext: ".txt" });
  expect(uploadNameParts("shot.jpeg", jpg, { source: "drop" })).toEqual({ stem: "shot", ext: ".jpeg" });            // jpeg IS jpg
});

test("no name: the word for where it came from", () => {
  expect(uploadNameParts("", jpg, { source: "paste" })).toEqual({ stem: "paste", ext: ".jpg" });
  expect(uploadNameParts("image.png", png, { source: "paste" })).toEqual({ stem: "paste", ext: ".png" }); // the browser's clipboard default
  expect(uploadNameParts("image.png", png, { source: "drop" })).toEqual({ stem: "image", ext: ".png" });  // only a PASTE's default is no name
  expect(uploadNameParts("", jpg, { source: "library" })).toEqual({ stem: "photo", ext: ".jpg" });
  expect(uploadNameParts("", text("x"), { source: "document", mime: "application/pdf" })).toEqual({ stem: "file", ext: ".pdf" });
  expect(uploadNameParts("", text("x"), { source: "document" })).toEqual({ stem: "file", ext: "" });
  expect(uploadNameParts("", text("x"), { source: "drop", mime: "text/plain" })).toEqual({ stem: "drop", ext: ".txt" });
});

test("no source, or a name that is empty once cleaned", () => {
  expect(uploadNameParts(undefined, png)).toEqual({ stem: "unknown", ext: ".png" });
  expect(uploadNameParts("..", text("x"))).toEqual({ stem: "unknown", ext: "" });
  expect(uploadNameParts("", text("x"), { source: "document" })).toEqual({ stem: "file", ext: "" });
  expect(uploadNameParts("../../etc/passwd", text("x"))).toEqual({ stem: "passwd", ext: "" });
  expect(uploadNameParts(".env", text("x"))).toEqual({ stem: ".env", ext: "" });
});

test("uploadNameCandidates: <ts>-0000.<name>, <ts>-0001.<name> — a name sort is a time sort", () => {
  const next = uploadNameCandidates("image", ".png", at);
  const names = [next(), next(), next()];
  expect(names).toEqual(["20260911-162140-0000.image.png", "20260911-162140-0001.image.png", "20260911-162140-0002.image.png"]);
  expect([...names].sort()).toEqual(names);
  expect(names[1].replace(UPLOAD_PREFIX, "")).toBe("image.png");
});

test("writeUpload: every upload carries the prefix; the counter only moves on a collision", () => {
  const d = join(dir(), "uploads");
  const first = writeUpload(d, png, "image.png", { source: "drop", at })!;
  const second = writeUpload(d, png, "image.png", { source: "drop", at })!;
  const pasted = writeUpload(d, jpg, "", { source: "paste", at })!;
  expect([basename(first), basename(second), basename(pasted)]).toEqual([
    "20260911-162140-0000.image.png", "20260911-162140-0001.image.png", "20260911-162140-0000.paste.jpg",
  ]);
  expect(first).toBe(join(d, "20260911-162140-0000.image.png")); // absolute: this is what goes into the prompt
  expect(readFileSync(first).length).toBe(png.length);            // never truncated by a later upload
  expect(writeUpload(d, new Uint8Array(0), "empty.txt")).toBeNull();
});

test("writeUpload: a dangling symlink at the name is never followed — the upload lands beside it (#530)", () => {
  const d = dir();
  symlinkSync(join(d, "nowhere"), join(d, "20260911-162140-0000.report.txt"));
  const p = writeUpload(d, text("payload"), "report.txt", { source: "document", at })!;
  expect(basename(p)).toBe("20260911-162140-0001.report.txt");
  expect(existsSync(join(d, "nowhere"))).toBe(false);
});

test("writeAttachmentExclusive: gives up after the attempts it is allowed", () => {
  const d = dir();
  writeAttachmentExclusive(d, new Uint8Array([1]), () => "data.txt");
  expect(() => writeAttachmentExclusive(d, new Uint8Array([1]), () => "data.txt")).toThrow(/free name/);
});
