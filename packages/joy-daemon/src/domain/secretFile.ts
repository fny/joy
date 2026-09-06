// Permission modes for the daemon's secret-bearing state (#48).
//
// `daemon.json` carries the HTTP bearer token — full session/bash/file access
// to this machine — and `window-<id>.json` carries `v2SessionKey`, the key
// that decrypts every app↔daemon message of that session. The ledger holds
// prompt text and the outbox rows' content keys. All three were written with
// the process umask default (`-rw-rw-r--` on this box), readable by every
// local account, while `env.sealed` next to them was deliberately 0600: the
// intent existed but was not applied to the files that matter most.
//
// One place to say it, so a new store cannot forget: 0600 files inside 0700
// directories, and the mode is ENFORCED on rewrite (an existing 0644 file is
// replaced by a 0600 inode) rather than preserved.

import fs from "node:fs";
import { writeFileAtomic, type AtomicWriteResult } from "./atomicWrite";

/** Owner-only file: secrets, keys, prompt text. */
export const SECRET_FILE_MODE = 0o600;
/** Owner-only directory: the state and credential dirs holding them. */
export const SECRET_DIR_MODE = 0o700;

/** mkdir -p with an owner-only mode, and tighten a directory that already
 *  exists with looser bits (the state dir predates this rule on every box
 *  that ran an older daemon). Best effort on the chmod: a dir we do not own
 *  is not worth failing a boot over. */
export function mkdirSecure(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  try {
    if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, SECRET_DIR_MODE);
  } catch { /* not ours / racing removal — the file mode is the real belt */ }
}

/** Atomic replace at 0600, enforced: `preserveMode` is off so a record
 *  written world-readable by an older daemon comes back owner-only. */
export function writeSecretFileAtomic(path: string, data: string | Uint8Array): AtomicWriteResult {
  return writeFileAtomic(path, data, { mode: SECRET_FILE_MODE, preserveMode: false });
}

/** Tighten an existing file the daemon did not write itself (a SQLite file
 *  the driver created, a log opened elsewhere). Best effort. */
export function chmodSecretQuiet(path: string): void {
  try { fs.chmodSync(path, SECRET_FILE_MODE); } catch { /* missing / not ours */ }
}
