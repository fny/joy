// File attachment helpers.
//
// When the app sends a file alongside a chat message, joy-tmux:
//   1. Downloads + decrypts the blob via the relay (see relay.ts)
//   2. Writes the file to the session's cwd
//   3. Appends the bare path to the chat text before piping into tmux
//
// Images (PNG / JPEG / GIF / WEBP, sniffed from magic bytes rather than
// trusting the wire mimeType — iOS reports image/heic or empty strings) get a
// paste-* filename, mirroring happy-cli's detectClaudeImageMime. Any other
// file type keeps its original (sanitized) name so the agent can read or
// reference it by a meaningful path.

import { writeFileSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomBytes } from "node:crypto";

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

/**
 * Build a paste-style filename: `paste-YYYYMMDD-HHMMSS-{4-hex}.{ext}`.
 * The timestamp is local time, not UTC, so the filename matches what the
 * user sees on the clock when they paste. The 4-hex short id prevents
 * collisions when two pastes land in the same second.
 */
export function formatPasteFilename(ext: string, at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = at.getFullYear();
  const mo = pad(at.getMonth() + 1);
  const d = pad(at.getDate());
  const h = pad(at.getHours());
  const mi = pad(at.getMinutes());
  const s = pad(at.getSeconds());
  const shortId = randomBytes(2).toString("hex");
  return `paste-${y}${mo}${d}-${h}${mi}${s}-${shortId}.${ext}`;
}

/**
 * Sanitize a user-supplied filename to a safe basename inside `cwd`, avoiding
 * collisions with existing files. basename() drops any directory component;
 * control characters (code points below 0x20) are stripped so the write stays
 * a single safe entry in cwd. Falls back to a paste-* name when nothing usable
 * remains.
 */
export function safeAttachmentFilename(cwd: string, name: string | undefined): string {
  let base = Array.from(name ? basename(name) : "")
    .filter((c) => c.charCodeAt(0) >= 0x20)
    .join("")
    .trim();
  if (!base || base === "." || base === "..") {
    base = formatPasteFilename("bin");
  }
  // Don't clobber an existing file: insert a short id before the extension.
  if (existsSync(join(cwd, base))) {
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    base = `${stem}-${randomBytes(2).toString("hex")}${ext}`;
  }
  return base;
}

/**
 * Decode + write a file attachment into the session's cwd. Returns the relative
 * path (e.g. `./paste-20260608-134523-a3f9.png` for images, or `./report.pdf`
 * for other files) suitable for appending to a chat message. Returns null only
 * when there are no bytes to write.
 */
export function writeAttachmentToCwd(cwd: string, bytes: Uint8Array, name?: string): string | null {
  if (bytes.length === 0) return null;
  const sniffed = sniffMimeAndExt(bytes);
  // Known image format → paste-* filename (keeps the established convention).
  // Anything else → keep the original (sanitized) name.
  const filename = sniffed ? formatPasteFilename(sniffed.ext) : safeAttachmentFilename(cwd, name);
  const absPath = join(cwd, filename);
  writeFileSync(absPath, bytes);
  // Bare relative path on its own line, as agreed: claude code interactive
  // resolves these against the session cwd.
  return `./${filename}`;
}
