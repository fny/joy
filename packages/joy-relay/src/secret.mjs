// Token signing secret: JOY_RELAY_TOKEN_SECRET, else one generated once and
// kept beside the data. Losing it invalidates every device's token, so it is
// written ATOMICALLY and an incomplete first write is recognised for what it
// is instead of being served as the secret (#606): a create-then-write that
// died between the two steps (ENOSPC, a kill) left an EMPTY token.secret,
// every later start read it, createTokenAuthority refused it, and the relay
// never came back even after the disk was fixed.
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const SECRET_FILE = 'token.secret';
/** createTokenAuthority's floor; anything shorter can never have minted. */
const MIN_SECRET_CHARS = 16;

export function loadOrCreateTokenSecret(dataDir, { env = process.env, generate = () => randomBytes(48).toString('base64'), log = console } = {}) {
  if (env.JOY_RELAY_TOKEN_SECRET) return env.JOY_RELAY_TOKEN_SECRET;
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, SECRET_FILE);
  let existing = null;
  try { existing = readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  if (existing !== null) {
    const trimmed = existing.trim();
    if (trimmed.length >= MIN_SECRET_CHARS) return trimmed;
    if (trimmed.length > 0) {
      // Non-empty but unusable: it may have been placed by hand, so refuse
      // with the fix spelled out rather than silently replacing it.
      throw new Error(
        `${file} holds ${trimmed.length} characters; a token secret needs at least ${MIN_SECRET_CHARS}. ` +
        `Delete the file to generate a new one (every device re-pairs) or set JOY_RELAY_TOKEN_SECRET.`);
    }
    // Empty: a first write that never completed. No token was ever minted
    // under it (the authority refuses empty secrets), so regenerating
    // invalidates nothing.
    log.warn?.(`[joy-relay] ${file} is empty (interrupted first write) — generating a new token secret`);
  }
  const secret = generate();
  // Atomic publish: write + fsync a sibling temp file, then rename it over
  // the final name — the final path is either absent or complete. "Complete"
  // is CHECKED, not assumed: writeSync may write fewer bytes than asked (a
  // filling disk, a signal), so a single call could have fsynced and renamed
  // a truncated secret into place as a valid-looking one. Loop until every
  // byte is down, then confirm the file size before the rename; any failure
  // removes the temp file so the next start retries from scratch.
  const tmp = `${file}.${process.pid}.tmp`;
  const bytes = Buffer.from(secret, 'utf8');
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeAll(fd, bytes, tmp);
    fsyncSync(fd);
    const { size } = fstatSync(fd);
    if (size !== bytes.length) throw shortWrite(tmp, size, bytes.length);
    closeSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  renameSync(tmp, file);
  return secret;
}

/** Write every byte of `bytes` to `fd`, honouring short writes. A zero-byte
 *  write is treated as failure (a full disk that stops reporting ENOSPC would
 *  otherwise spin forever). */
function writeAll(fd, bytes, path) {
  let written = 0;
  while (written < bytes.length) {
    const n = writeSync(fd, bytes, written, bytes.length - written);
    if (!(n > 0)) throw shortWrite(path, written, bytes.length);
    written += n;
  }
}

function shortWrite(path, got, want) {
  const e = new Error(`short write to ${path}: ${got} of ${want} bytes (disk full?) — the secret was not published; fix the disk and restart`);
  e.code = 'ENOSPC';
  return e;
}
