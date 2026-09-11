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
// Names (2026-09-11): `YYYYMMDD-HHMMSS-NNNN.<name>.<ext>` - a UTC timestamp
// and a per-second counter first, so a plain name sort IS a time sort and the
// app can strip the fixed-width prefix on download; then the name as given.
// With no usable name, the word for where it came from (the app sends a
// `source`): paste -> paste, library -> photo, document -> file, drop -> drop,
// and no source -> unknown. A browser's default name for a raw clipboard
// image (`image.png`) counts as no name for a paste. Images get the extension
// of what the bytes ARE (iOS names a JPEG `.HEIC`).
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

/** Where an upload came from, as the app reports it (sealed with the name). */
export type UploadSource = "paste" | "library" | "document" | "drop";
export const UPLOAD_SOURCES: readonly string[] = ["paste", "library", "document", "drop"];
const FALLBACK_STEM: Record<UploadSource, string> = { paste: "paste", library: "photo", document: "file", drop: "drop" };
const BROWSER_CLIPBOARD_DEFAULT = /^image\.(png|jpe?g|gif|webp)$/i;
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf", "text/plain": "txt", "application/json": "json", "text/csv": "csv",
  "text/markdown": "md", "application/zip": "zip", "text/html": "html",
};

/** The fixed-width prefix every upload name starts with; strip it to get the
 *  name the file arrived with. */
export const UPLOAD_PREFIX = /^\d{8}-\d{6}-\d{4}\./;

/** UTC as YYYYMMDD-HHMMSS - sorts correctly across DST and time zones. */
export function uploadTimestamp(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

/** The name part after the prefix, split into stem and extension. */
export function uploadNameParts(name: string | undefined, bytes: Uint8Array, opts: { source?: UploadSource; mime?: string } = {}): { stem: string; ext: string } {
  let clean = Array.from(name ? basename(name) : "")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  if (clean === "." || clean === "..") clean = "";
  if (opts.source === "paste" && BROWSER_CLIPBOARD_DEFAULT.test(clean)) clean = "";
  const sniffed = sniffMimeAndExt(bytes);
  if (!clean) {
    const stem = opts.source ? FALLBACK_STEM[opts.source] : "unknown";
    const fromMime = opts.mime ? MIME_EXT[opts.mime.toLowerCase()] : undefined;
    return { stem, ext: sniffed ? `.${sniffed.ext}` : fromMime ? `.${fromMime}` : "" };
  }
  let ext = extname(clean);
  let stem = ext ? clean.slice(0, -ext.length) : clean;
  if (!stem) { stem = clean; ext = ""; } // ".env" is a name, not an extension
  if (sniffed) {
    const claimed = ext.slice(1).toLowerCase().replace(/^jpeg$/, "jpg");
    if (claimed !== sniffed.ext) ext = `.${sniffed.ext}`;
  }
  return { stem, ext };
}

/** Candidate names in order: `<ts>-0000.<stem><ext>`, `<ts>-0001...`, ... */
export function uploadNameCandidates(stem: string, ext: string, at: Date = new Date()): () => string {
  const ts = uploadTimestamp(at);
  let n = 0;
  return () => `${ts}-${String(n++).padStart(4, "0")}.${stem}${ext}`;
}

/**
 * Write an upload into `dir` (created if missing) under the naming rule above.
 * Returns the absolute path - what goes into the prompt - or null when there
 * are no bytes to write.
 */
export function writeUpload(dir: string, bytes: Uint8Array, name?: string, opts: { source?: UploadSource; mime?: string; at?: Date } = {}): string | null {
  if (bytes.length === 0) return null;
  mkdirSync(dir, { recursive: true });
  const { stem, ext } = uploadNameParts(name, bytes, opts);
  const filename = writeAttachmentExclusive(dir, bytes, uploadNameCandidates(stem, ext, opts.at ?? new Date()), 10_000);
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
