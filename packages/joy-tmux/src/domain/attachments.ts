// Image attachment helpers.
//
// When the app sends an image alongside a chat message, joy-tmux:
//   1. Downloads + decrypts the blob via the relay (see relay.ts)
//   2. Validates the bytes are a supported image format (sniffMimeAndExt)
//   3. Writes the file to the session's cwd with a paste-* filename
//   4. Appends the bare path to the chat text before piping into tmux
//
// Validation mirrors happy-cli's detectClaudeImageMime: only PNG / JPEG /
// GIF / WEBP, sniffed from magic bytes rather than trusting the wire
// mimeType (iOS picker reports things like image/heic or empty strings,
// and Claude's API rejects unknown media types with 400).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Decode + validate + write an image attachment into the session's cwd.
 * Returns the relative path (e.g. `./paste-20260608-134523-a3f9.png`)
 * suitable for appending to a chat message, or null if the bytes don't
 * look like a supported image format.
 */
export function writeAttachmentToCwd(cwd: string, bytes: Uint8Array): string | null {
  const sniffed = sniffMimeAndExt(bytes);
  if (!sniffed) return null;
  const filename = formatPasteFilename(sniffed.ext);
  const absPath = join(cwd, filename);
  writeFileSync(absPath, bytes);
  // Bare relative path on its own line, as agreed: claude code interactive
  // resolves these against the session cwd.
  return `./${filename}`;
}
