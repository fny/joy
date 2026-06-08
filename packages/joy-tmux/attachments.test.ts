import { test, expect } from "bun:test";
import { sniffMimeAndExt, formatPasteFilename } from "./attachments";

test("sniffMimeAndExt: detects PNG magic", () => {
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  expect(sniffMimeAndExt(png)).toEqual({ mime: "image/png", ext: "png" });
});

test("sniffMimeAndExt: detects JPEG magic", () => {
  // JPEG: FF D8 FF
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  expect(sniffMimeAndExt(jpeg)).toEqual({ mime: "image/jpeg", ext: "jpg" });
});

test("sniffMimeAndExt: detects GIF magic (GIF8)", () => {
  // GIF87a / GIF89a both start with "GIF8" = 47 49 46 38
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  expect(sniffMimeAndExt(gif)).toEqual({ mime: "image/gif", ext: "gif" });
});

test("sniffMimeAndExt: detects WEBP magic (RIFF....WEBP)", () => {
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // size (any)
    0x57, 0x45, 0x42, 0x50, // WEBP
  ]);
  expect(sniffMimeAndExt(webp)).toEqual({ mime: "image/webp", ext: "webp" });
});

test("sniffMimeAndExt: rejects unsupported / unknown formats", () => {
  expect(sniffMimeAndExt(new Uint8Array([0, 0, 0, 0]))).toBeNull();
  // BMP: not on Claude's accepted list
  expect(sniffMimeAndExt(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull();
  // HEIC ftyp box: also not accepted
  expect(sniffMimeAndExt(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeNull();
  // Empty
  expect(sniffMimeAndExt(new Uint8Array(0))).toBeNull();
});

test("formatPasteFilename: shape matches paste-YYYYMMDD-HHMMSS-XXXX.ext", () => {
  const at = new Date(2026, 5, 8, 13, 4, 5); // June 8 2026 13:04:05 local
  const name = formatPasteFilename("png", at);
  expect(name).toMatch(/^paste-20260608-130405-[0-9a-f]{4}\.png$/);
});

test("formatPasteFilename: different extensions", () => {
  const at = new Date(2026, 0, 1, 0, 0, 0);
  expect(formatPasteFilename("jpg", at)).toMatch(/^paste-20260101-000000-[0-9a-f]{4}\.jpg$/);
  expect(formatPasteFilename("webp", at)).toMatch(/^paste-20260101-000000-[0-9a-f]{4}\.webp$/);
});

test("formatPasteFilename: short ids collide-resist (probabilistic spot check)", () => {
  const at = new Date(2026, 0, 1, 0, 0, 0);
  const names = new Set<string>();
  for (let i = 0; i < 200; i++) names.add(formatPasteFilename("png", at));
  // 16-bit space → 200 draws → birthday-paradox: ~50% chance of any collision
  // around 300 samples, much higher for 200; this is a sanity-check rather
  // than a guarantee. We allow a few collisions but expect mostly unique.
  expect(names.size).toBeGreaterThan(180);
});
