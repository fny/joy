// Atomic file replacement — the one write primitive every durable daemon
// store goes through (review campaign 2026-09, Wave A2: #527 #539 #555 and
// the receipts/window-record siblings).
//
// The failure the family shares: `writeFileSync(dest, data)` TRUNCATES dest
// first and then writes. ENOSPC / EIO / a daemon death between those two steps
// leaves an empty or partial dest — and the caller's "return false / log"
// error path never restores the previous complete contents. For a queue spool
// that is every acknowledged prompt; for a config file it is the user's
// settings; for a source file it is the user's work.
//
// Contract:
//   - `data` lands in a sibling temp file in the SAME directory (rename must
//     not cross filesystems), is fsync'd, then renamed over `path`. The
//     rename is the only step that touches `path`, and rename(2) is atomic:
//     readers see the old complete file or the new complete file, never a
//     mix. The directory is fsync'd afterwards so the rename itself survives
//     a power loss (best effort — some filesystems refuse fsync on a dir).
//   - On ANY failure before the rename the destination is untouched and the
//     temp file is removed. The thrown AtomicWriteError names the phase.
//   - `backup` (optional) rotates <path> → <backup> as part of a SUCCESSFUL
//     replacement only. The previous contents are staged (hard link, else
//     copy) BEFORE the rename, from a destination that is by construction
//     always complete — so a retry after a failed write can never copy a
//     partial file over the last intact backup (#527).
//   - `preserveMode` (default true) carries the existing file's permission
//     bits onto the replacement, since the new inode would otherwise get the
//     umask default (an executable script must stay executable).
//   - A SYMLINKED destination is written THROUGH (#527 residual): the temp file
//     is created beside the link's real target and renamed over the target, so
//     the link itself survives and keeps pointing where the user put it. The
//     first version renamed over `path`: rename(2) replaces the LINK with a
//     regular file (a `~/.claude/settings.json → dotfiles/…` link was silently
//     severed), and link(2) on a symlink hard-links the symlink itself, so the
//     `.joy-bak` became a second link to the now-overwritten target instead of a
//     copy of the previous contents. Backups of a symlinked file are COPIES.
//
// Every fs call goes through the DEFAULT `fs` export object (not named
// imports) so tests can inject failures with vi.spyOn(fs, "writeSync") etc.
// Node's ESM named imports of builtins are snapshots and cannot be spied.

import fs from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

export type AtomicWritePhase = "mkdir" | "open" | "write" | "fsync" | "backup" | "rename" | "cleanup";

export class AtomicWriteError extends Error {
  readonly phase: AtomicWritePhase;
  readonly path: string;
  readonly code: string | undefined;
  constructor(phase: AtomicWritePhase, path: string, cause: unknown) {
    const c = cause as { code?: string; message?: string } | undefined;
    super(`atomic write of ${path} failed during ${phase}: ${c?.message ?? String(cause)} — destination left untouched`);
    this.name = "AtomicWriteError";
    this.phase = phase;
    this.path = path;
    this.code = c?.code;
    (this as { cause?: unknown }).cause = cause;
  }
}

export interface AtomicWriteOptions {
  /** Rotate the previous contents into this path (or `<path>.joy-bak` when
   *  `true`) — only when the replacement succeeds; a fresh destination (no
   *  previous file) leaves the backup as it was. */
  backup?: string | boolean;
  /** Mode for a NEW file (ignored when the destination exists and
   *  preserveMode is on). Default: the process umask default. */
  mode?: number;
  /** Copy the existing destination's permission bits onto the replacement.
   *  Default true. */
  preserveMode?: boolean;
}

export interface AtomicWriteResult {
  /** True when a backup was requested, a previous file existed, and the
   *  rotation landed. False when no previous file existed (nothing to back
   *  up) OR the rotation rename failed AFTER the replacement had already
   *  succeeded — the previous-generation backup is then still in place and
   *  the failure is written to stderr. */
  backupRotated: boolean;
}

let tmpCounter = 0;
function tmpNameFor(path: string, tag: string): string {
  tmpCounter = (tmpCounter + 1) % 0xffff;
  return join(dirname(path), `.${basename(path)}.${tag}.${process.pid}.${Date.now().toString(36)}.${tmpCounter.toString(36)}`);
}

function backupPathFor(path: string, backup: string | boolean | undefined): string | null {
  if (!backup) return null;
  return backup === true ? `${path}.joy-bak` : backup;
}

function rmQuiet(p: string | null): void {
  if (!p) return;
  try { fs.rmSync(p, { force: true }); } catch { /* the temp is our own; nothing else to protect */ }
}

/** fsync the directory holding `path` so the rename is on disk. Best effort:
 *  a filesystem that refuses (EINVAL on some network/overlay mounts) does not
 *  fail a write whose data is already durable in the file itself. */
function fsyncDirQuiet(path: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dirname(path), "r");
    fs.fsyncSync(fd);
  } catch { /* best effort */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function existingMode(path: string): number | null {
  try { return fs.statSync(path).mode & 0o7777; } catch { return null; }
}

/** Where the bytes must land when `path` is (a chain of) symlink(s): the
 *  final non-link path, resolved link by link so a DANGLING link still
 *  resolves to the place it points at (writing there creates the target and
 *  makes the link valid — the semantics of writing through a link). A plain
 *  file or a missing path resolves to itself. Bounded so a link loop cannot
 *  spin forever (the kernel's own limit is 40). Returns whether any hop was
 *  a symlink, which decides copy-vs-link for the backup (#527). */
export function resolveWriteTarget(path: string): { target: string; viaSymlink: boolean } {
  let cur = path;
  let viaSymlink = false;
  for (let hop = 0; hop < 40; hop++) {
    let st: fs.Stats;
    try { st = fs.lstatSync(cur); } catch { return { target: cur, viaSymlink }; }
    if (!st.isSymbolicLink()) return { target: cur, viaSymlink };
    viaSymlink = true;
    cur = resolve(dirname(cur), fs.readlinkSync(cur));
  }
  return { target: cur, viaSymlink };
}

/**
 * Synchronous atomic replace. Throws AtomicWriteError (destination untouched,
 * temp removed) on failure; returns whether the backup rotated.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): AtomicWriteResult {
  const buf: Uint8Array = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const backupPath = backupPathFor(path, opts.backup);
  const preserveMode = opts.preserveMode ?? true;

  // The path the rename must hit: the real file behind a symlinked `path`.
  const { target, viaSymlink } = resolveWriteTarget(path);
  try { fs.mkdirSync(dirname(path), { recursive: true }); if (target !== path) fs.mkdirSync(dirname(target), { recursive: true }); }
  catch (e) { throw new AtomicWriteError("mkdir", path, e); }

  const prevMode = preserveMode ? existingMode(target) : null;
  const tmp = tmpNameFor(target, "tmp");
  let fd: number | null = null;
  // Phase 1 — the new contents, complete and durable, beside the destination.
  try {
    try { fd = fs.openSync(tmp, "wx", prevMode ?? opts.mode ?? 0o666); }
    catch (e) { throw new AtomicWriteError("open", path, e); }
    try {
      let off = 0;
      while (off < buf.byteLength) {
        off += fs.writeSync(fd, buf, off, buf.byteLength - off);
      }
    } catch (e) { throw new AtomicWriteError("write", path, e); }
    try { fs.fsyncSync(fd); }
    catch (e) { throw new AtomicWriteError("fsync", path, e); }
    try { fs.closeSync(fd); fd = null; }
    catch (e) { throw new AtomicWriteError("fsync", path, e); }
    // preserveMode on: carry the destination's bits. preserveMode OFF with an
    // explicit mode: ENFORCE it — `open(…, mode)` is masked by the umask, and
    // a secret file must not depend on how the daemon was launched (#48).
    const want = prevMode ?? (opts.preserveMode === false ? opts.mode : undefined);
    if (want !== undefined) { try { fs.chmodSync(tmp, want); } catch { /* keep going — content beats mode */ } }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    rmQuiet(tmp);
    throw e;
  }

  // Phase 2 — stage the previous generation for the backup. Hard link first
  // (zero copy, shares the inode the rename is about to unlink from the
  // target), copy when the filesystem refuses links. The source is the target
  // as it stands — always a complete file, because nothing here ever
  // truncates it. A symlinked destination is always COPIED: link(2) does not
  // follow symlinks, so linking `path` produced a backup that was itself a
  // link to the file about to change, i.e. no backup at all (#527).
  let stagedBackup: string | null = null;
  if (backupPath && fs.existsSync(target)) {
    stagedBackup = tmpNameFor(backupPath, "bak");
    try {
      if (viaSymlink) fs.copyFileSync(target, stagedBackup);
      else {
        try { fs.linkSync(target, stagedBackup); }
        catch { fs.copyFileSync(target, stagedBackup); }
      }
    } catch (e) {
      rmQuiet(tmp); rmQuiet(stagedBackup);
      throw new AtomicWriteError("backup", path, e);
    }
  }

  // Phase 3 — the single step that touches the destination (the REAL target:
  // renaming over a symlink would replace the link, not the file it names).
  try { fs.renameSync(tmp, target); }
  catch (e) {
    rmQuiet(tmp); rmQuiet(stagedBackup);
    throw new AtomicWriteError("rename", path, e);
  }
  fsyncDirQuiet(target);

  // Phase 4 — rotate the staged previous generation into place. The
  // replacement has already succeeded; a failure here leaves the OLDER backup
  // intact (never a partial one) and is reported, not thrown.
  let backupRotated = false;
  if (stagedBackup && backupPath) {
    try { fs.renameSync(stagedBackup, backupPath); backupRotated = true; }
    catch (e) {
      rmQuiet(stagedBackup);
      process.stderr.write(`[atomic-write] ${path}: replaced, but rotating the backup to ${backupPath} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }
  return { backupRotated };
}

/**
 * Async twin of writeFileAtomic for the request-path file ops (#539). Same
 * phases and guarantees; uses fs.promises through the default `fs` object so
 * `vi.spyOn(fs.promises, "rename")` can inject the failure.
 */
export async function writeFileAtomicAsync(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): Promise<AtomicWriteResult> {
  const fsp = fs.promises;
  const buf: Uint8Array = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const backupPath = backupPathFor(path, opts.backup);
  const preserveMode = opts.preserveMode ?? true;

  const { target, viaSymlink } = resolveWriteTarget(path); // write THROUGH a symlink (#527)
  try { await fsp.mkdir(dirname(path), { recursive: true }); if (target !== path) await fsp.mkdir(dirname(target), { recursive: true }); }
  catch (e) { throw new AtomicWriteError("mkdir", path, e); }

  const prevMode = preserveMode ? existingMode(target) : null;
  const tmp = tmpNameFor(target, "tmp");
  let fh = null as fs.promises.FileHandle | null;
  try {
    try { fh = await fsp.open(tmp, "wx", prevMode ?? opts.mode ?? 0o666); }
    catch (e) { throw new AtomicWriteError("open", path, e); }
    try { await fh.writeFile(buf); }
    catch (e) { throw new AtomicWriteError("write", path, e); }
    try { await fh.sync(); }
    catch (e) { throw new AtomicWriteError("fsync", path, e); }
    try { await fh.close(); fh = null; }
    catch (e) { throw new AtomicWriteError("fsync", path, e); }
    const want = prevMode ?? (opts.preserveMode === false ? opts.mode : undefined);
    if (want !== undefined) { try { await fsp.chmod(tmp, want); } catch { /* content beats mode */ } }
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    rmQuiet(tmp);
    throw e;
  }

  let stagedBackup: string | null = null;
  if (backupPath && fs.existsSync(target)) {
    stagedBackup = tmpNameFor(backupPath, "bak");
    try {
      if (viaSymlink) await fsp.copyFile(target, stagedBackup); // a link's backup is a copy (#527)
      else {
        try { await fsp.link(target, stagedBackup); }
        catch { await fsp.copyFile(target, stagedBackup); }
      }
    } catch (e) {
      rmQuiet(tmp); rmQuiet(stagedBackup);
      throw new AtomicWriteError("backup", path, e);
    }
  }

  try { await fsp.rename(tmp, target); }
  catch (e) {
    rmQuiet(tmp); rmQuiet(stagedBackup);
    throw new AtomicWriteError("rename", path, e);
  }
  fsyncDirQuiet(target);

  let backupRotated = false;
  if (stagedBackup && backupPath) {
    try { await fsp.rename(stagedBackup, backupPath); backupRotated = true; }
    catch (e) {
      rmQuiet(stagedBackup);
      process.stderr.write(`[atomic-write] ${path}: replaced, but rotating the backup to ${backupPath} failed: ${e instanceof Error ? e.message : e}\n`);
    }
  }
  return { backupRotated };
}
