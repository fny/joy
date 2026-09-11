// File attachment helpers.
//
// When the app sends a file alongside a chat message, joy-daemon
// (relay/nucleusLane.ts runTurn):
//   1. Fetches the sealed blob from the relay's v2 attachment store and opens
//      it with the session key (openAttachmentBytes)
//   2. Writes the file into the session's uploads directory,
//      ~/.joy/sessions/<id>/uploads/ (writeUpload) — never into the project:
//      pasted screenshots used to pile up as paste-*.png in the repo root
//   3. Appends the file's absolute path to the prompt text on its own line
//
// Names (2026-09-11): the name as given — `report.pdf`, `IMG_2041.jpg`. When
// that name is taken, a timestamp goes between it and the extension:
// `report.20260911-081518.pdf`, then `report.20260911-081518-2.pdf` for a
// second one in the same second. No name → `paste.<ext>`. Images get the
// extension of what the bytes ARE (sniffed from magic bytes — iOS names a
// JPEG `.HEIC`, a clipboard paste may have no name at all).
import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";

export type ClaudeImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export function sniffMimeAndExt(bytes: Uint8Array): { mime: ClaudeImageMime; ext: "png" | "jpg" | "gif" | "webp" } | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { mime: "image/gif", ext: "gif" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/** Local time as YYYYMMDD-HHMMSS — the clock the user saw when they pasted. */
export function uploadTimestamp(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** The stem and extension an upload is saved under: the given name reduced to
 *  a safe basename (no directory part, no control characters), `paste` when
 *  nothing usable remains, and — for images — the extension of the real
 *  format rather than the claimed one. */
export function uploadNameParts(name: string | undefined, bytes: Uint8Array): { stem: string; ext: string } {
  let base = Array.from(name ? basename(name) : "")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  if (!base || base === "." || base === "..") base = "paste";
  let ext = extname(base);
  let stem = ext ? base.slice(0, -ext.length) : base;
  if (!stem) { stem = base; ext = ""; } // ".env" is a name, not an extension
  const sniffed = sniffMimeAndExt(bytes);
  if (sniffed) {
    const claimed = ext.slice(1).toLowerCase().replace(/^jpeg$/, "jpg");
    if (claimed !== sniffed.ext) ext = `.${sniffed.ext}`;
  }
  return { stem, ext };
}

/** Candidate names in order: `name.ext`, then `name.<ts>.ext`, then
 *  `name.<ts>-2.ext`, `name.<ts>-3.ext`, … */
export function uploadNameCandidates(stem: string, ext: string, at: Date = new Date()): () => string {
  const ts = uploadTimestamp(at);
  let n = 0;
  return () => {
    n++;
    if (n === 1) return `${stem}${ext}`;
    if (n === 2) return `${stem}.${ts}${ext}`;
    return `${stem}.${ts}-${n - 1}${ext}`;
  };
}

/**
 * Write an upload into `dir` (created if missing) under the naming rule above.
 * Returns the absolute path — what goes into the prompt — or null when there
 * are no bytes to write.
 */
export function writeUpload(dir: string, bytes: Uint8Array, name?: string, at: Date = new Date()): string | null {
  if (bytes.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  const { stem, ext } = uploadNameParts(name, bytes);
  const filename = writeAttachmentExclusive(dir, bytes, uploadNameCandidates(stem, ext, at), 50);
  return join(dir, filename);
}

/**
 * Create the attachment EXCLUSIVELY (`wx` = O_CREAT|O_EXCL): the kernel
 * refuses if any entry — including a symlink, dangling or not — already
 * sits at that name, so the write can never follow a link out of the
 * directory nor truncate an earlier upload (#530). On EEXIST the next
 * candidate name is tried; returns the name that landed.
 */
export function writeAttachmentExclusive(dir: string, bytes: Uint8Array, nextName: () => string, maxAttempts = 8): string {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const filename = nextName();
    try {
      writeFileSync(join(dir, filename), bytes, { flag: "wx" });
      return filename;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`attachment: no free name in ${dir} after ${maxAttempts} attempts`);
}
