// One structured read of a session cwd's git state (Wave E2, architecture
// item 1). The daemon parses git's MACHINE formats exactly once — porcelain v2
// with NUL terminators, NUL-terminated numstat including its two-path rename
// form, and a NUL-delimited for-each-ref listing — and returns a versioned
// response the app renders without touching git text again. Nothing here
// trims, splits on whitespace, or decodes C-quoted paths: every record is cut
// at git's own terminators and every path is decoded from the bytes git wrote.
//
// Path identity vs display (see GitPath): a filename is bytes on disk. When
// those bytes are valid UTF-8 the identity strings ARE the filename. When they
// are not, the strings carry U+FFFD where the bytes could not be decoded (a
// lossy DISPLAY of the name) and `rawBase64` carries the exact repo-relative
// bytes, so nothing is silently renamed. `display` additionally shows C0
// control characters as their Unicode control pictures (a newline in a name
// renders as "␊" instead of breaking the row).
import { execFile } from "child_process";
import { existsSync } from "fs";
import { posix, resolve, isAbsolute } from "path";

export const GIT_STATUS_SCHEMA_VERSION = 2 as const;

/** Exact per-side line counts, or an explicit "we do not know" — never a
 *  silent zero. Binary files and untracked files are 'unavailable'; so is
 *  every entry of a side whose numstat read failed. */
export type LineCount = { added: number; removed: number } | "unavailable";

export interface GitPath {
  /** Repository-root-relative path, POSIX separators. Identity when `utf8`. */
  repo: string;
  /** Session-cwd-relative path ("../x" for a rename partner outside the cwd).
   *  This is what files/*, git/diff?path= and git/entries?path= accept. */
  cwd: string;
  /** Cwd-relative DISPLAY text: control characters shown as control pictures,
   *  undecodable bytes as U+FFFD. Never send this back to git or the FS. */
  display: string;
  /** False when the filename bytes are not valid UTF-8; `repo`/`cwd` are then
   *  lossy and `rawBase64` holds the exact bytes. */
  utf8: boolean;
  /** Base64 of the exact repo-relative filename bytes; present only when !utf8. */
  rawBase64?: string;
}

export interface GitStatusEntry {
  path: GitPath;
  /** Porcelain XY letters: index (staged) and worktree columns; "." = no
   *  change in that column, "?" for both on an untracked entry. Conflicted
   *  entries carry the unmerged pair (UU, AA, DD, AU, UA, DU, UD) verbatim. */
  index: string;
  worktree: string;
  untracked: boolean;
  /** Set for every `u` (unmerged) record — AA and DD included, which have no
   *  U column and were invisible to column-based classification. */
  conflict: { xy: string } | null;
  /** Rename (or copy) source; `score` is git's similarity percentage. */
  rename: { from: GitPath; score: number | null; copy: boolean } | null;
  submodule: boolean;
  /** From numstat's "-\t-" marker; null when no numstat covered the entry
   *  (untracked, or the read failed). */
  binary: boolean | null;
  lines: { staged: LineCount; unstaged: LineCount };
}

export type GitHead =
  | { kind: "branch"; name: string; oid: string }
  | { kind: "detached"; oid: string }
  /** No commit yet; `name` is the branch HEAD points at (usually the default). */
  | { kind: "unborn"; name: string | null };

export interface GitBranchRef {
  name: string;
  oid: string;
  /** Checked out in THIS worktree. */
  current: boolean;
  /** Absolute path of the worktree that has it checked out (linked worktrees
   *  included), null when nowhere. */
  worktree: string | null;
  upstream: string | null;
}

export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "bisect";

export interface GitStatusRepo {
  v: typeof GIT_STATUS_SCHEMA_VERSION;
  ok: true;
  /** "root": the session cwd IS the worktree root; "inside": a subdirectory. */
  relation: "root" | "inside";
  cwd: string;
  repository: {
    /** Absolute worktree root. */
    root: string;
    gitDir: string;
    commonDir: string;
    /** `git worktree add` checkout (gitDir differs from commonDir). */
    linkedWorktree: boolean;
    /** The cwd's path under root, "" at the root, "sub/dir/" otherwise. */
    prefix: string;
  };
  head: GitHead;
  upstream: { name: string; ahead: number | null; behind: number | null } | null;
  /** In-progress operation detected from the git dir's state files. */
  operation: GitOperation | null;
  stashCount: number;
  branches: GitBranchRef[];
  /** Scoped to the session cwd (pathspec "."), untracked files listed
   *  individually (never collapsed to a directory). */
  entries: GitStatusEntry[];
  totals: {
    staged: LineCount;
    unstaged: LineCount;
    counts: { staged: number; unstaged: number; untracked: number; conflicted: number; entries: number };
  };
  /** No entries at all — a conflict-only tree is NOT clean. */
  clean: boolean;
}

export type GitStatusResult =
  | GitStatusRepo
  | { v: typeof GIT_STATUS_SCHEMA_VERSION; ok: true; relation: "none"; cwd: string }
  | { v: typeof GIT_STATUS_SCHEMA_VERSION; ok: false; code: "git_missing" | "git_failed" | "timeout"; error: string };

// ── git process ─────────────────────────────────────────────────────────────

interface GitRun { code: number; stdout: Buffer; stderr: string; spawnError: string | null; timedOut: boolean }

export interface GitRunner { (cwd: string, args: string[]): Promise<GitRun> }

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export const runGit: GitRunner = (cwd, args) => new Promise(resolvePromise => {
  execFile("git", args, { cwd, encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
    const spawnError = e && typeof e.code === "string" ? e.code : null;
    const timedOut = !!(e && e.killed);
    const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
    resolvePromise({
      code, spawnError, timedOut,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? "")),
      stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
    });
  });
});

// ── bytes → text ────────────────────────────────────────────────────────────

// ignoreBOM: a filename that BEGINS with U+FEFF keeps it — the default
// decoder eats a leading byte-order mark and names a different file (#357).
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function decodeBytes(bytes: Uint8Array): { text: string; utf8: boolean } {
  try { return { text: strictUtf8.decode(bytes), utf8: true }; }
  catch { return { text: lossyUtf8.decode(bytes), utf8: false }; }
}

/** Exactly ONE trailing LF removed (git's line terminator on single-value
 *  commands like rev-parse); every other byte, including a trailing space or
 *  an embedded newline, is kept. */
function stripOneLf(buf: Buffer): Buffer {
  return buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.subarray(0, buf.length - 1) : buf;
}

/** Split on NUL. A trailing NUL terminates the last record (no empty tail). */
export function splitNul(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) { out.push(buf.subarray(start, i)); start = i + 1; }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

/** Index just past the n-th 0x20 byte, or -1. */
function afterNthSpace(buf: Buffer, n: number): number {
  let seen = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x20 && ++seen === n) return i + 1;
  }
  return -1;
}

/** Exact-bytes map key (latin1 is a bijection on bytes). */
const byteKey = (b: Uint8Array): string => Buffer.from(b).toString("latin1");

const controlPicture = (ch: string): string => {
  const c = ch.charCodeAt(0);
  return c === 0x7f ? "␡" : String.fromCharCode(0x2400 + c);
};
const toDisplay = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, controlPicture);

/** Build the path triple from git's raw repo-relative bytes. */
export function makeGitPath(repoBytes: Uint8Array, prefix: string): GitPath {
  const { text: repo, utf8 } = decodeBytes(repoBytes);
  const cwd = prefix === "" ? repo : repo.startsWith(prefix) ? repo.slice(prefix.length) : posix.relative(prefix, repo);
  const p: GitPath = { repo, cwd, display: toDisplay(cwd), utf8 };
  if (!utf8) p.rawBase64 = Buffer.from(repoBytes).toString("base64");
  return p;
}

// ── porcelain v2 -z ─────────────────────────────────────────────────────────

export interface PorcelainRecord {
  kind: "ordinary" | "rename" | "unmerged" | "untracked";
  xy: string;
  sub: string;
  path: Buffer;
  /** rename/copy source (the FOLLOWING NUL record in -z output). */
  from?: Buffer;
  score?: { copy: boolean; value: number | null };
}

export interface PorcelainHeaders {
  oid: string | null;        // "(initial)" for an unborn branch
  head: string | null;       // "(detached)" when detached
  upstream: string | null;
  ab: { ahead: number; behind: number } | null;
  stash: number;
}

/** `git status --porcelain=v2 -z --branch [--show-stash]`. Every record is
 *  a NUL-terminated buffer; a `2` record's original path is the NEXT record.
 *  Header values are the bytes after the fixed key — no trimming, so a
 *  branch name with U+00A0 or a trailing space survives (#364). */
export function parsePorcelainV2Z(out: Buffer): { headers: PorcelainHeaders; records: PorcelainRecord[] } {
  const headers: PorcelainHeaders = { oid: null, head: null, upstream: null, ab: null, stash: 0 };
  const records: PorcelainRecord[] = [];
  const recs = splitNul(out);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.length === 0) continue;
    const tag = r[0];
    if (tag === 0x23 /* # */) {
      const line = decodeBytes(r).text;
      if (line.startsWith("# branch.oid ")) headers.oid = line.slice(13);
      else if (line.startsWith("# branch.head ")) headers.head = line.slice(14);
      else if (line.startsWith("# branch.upstream ")) headers.upstream = line.slice(18);
      else if (line.startsWith("# branch.ab ")) {
        const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
        if (m) headers.ab = { ahead: Number(m[1]), behind: Number(m[2]) };
      } else if (line.startsWith("# stash ")) {
        const n = Number(line.slice(8));
        if (Number.isInteger(n) && n >= 0) headers.stash = n;
      }
      continue;
    }
    if (tag === 0x3f /* ? */) { records.push({ kind: "untracked", xy: "??", sub: "N...", path: r.subarray(2) }); continue; }
    if (tag === 0x21 /* ! */) continue; // ignored entries (only with --ignored)
    // Fixed-width, space-separated fields precede the path; the path itself
    // may contain spaces, so cut at the n-th space and never split the tail.
    //   1 XY sub mH mI mW hH hI <path>                  (8 fields)
    //   2 XY sub mH mI mW hH hI Xscore <path> NUL <orig> (9 fields)
    //   u XY sub m1 m2 m3 mW h1 h2 h3 <path>            (10 fields)
    const nFields = tag === 0x31 ? 8 : tag === 0x32 ? 9 : tag === 0x75 ? 10 : 0;
    if (nFields === 0) continue; // unknown record type: skip, never guess
    const at = afterNthSpace(r, nFields);
    if (at < 0) continue;
    const fields = r.subarray(0, at - 1).toString("latin1").split(" ");
    const xy = fields[1] ?? "..";
    const sub = fields[2] ?? "N...";
    const path = r.subarray(at);
    if (tag === 0x31) records.push({ kind: "ordinary", xy, sub, path });
    else if (tag === 0x75) records.push({ kind: "unmerged", xy, sub, path });
    else {
      const sc = fields[8] ?? "";
      const value = /^\d+$/.test(sc.slice(1)) ? Number(sc.slice(1)) : null;
      const from = recs[++i] ?? Buffer.alloc(0);
      records.push({ kind: "rename", xy, sub, path, from, score: { copy: sc[0] === "C", value } });
    }
  }
  return { headers, records };
}

// ── numstat -z ──────────────────────────────────────────────────────────────

export interface NumstatRecord { added: number | null; removed: number | null; binary: boolean; path: Buffer; from?: Buffer }

/** `git diff --numstat -z`. Records are `<added>TAB<removed>TAB<path>NUL`;
 *  a rename/copy is `<added>TAB<removed>TAB NUL <source> NUL <dest> NUL` —
 *  the stat record ends at its second tab and the two paths follow as their
 *  own records. "-" counts mark a binary file. Statistics are keyed by the
 *  DESTINATION path (#365), never by git's "old => new" display expression. */
export function parseNumstatZ(out: Buffer): NumstatRecord[] {
  const recs = splitNul(out);
  const result: NumstatRecord[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const t1 = r.indexOf(0x09);
    if (t1 < 0) continue;
    const t2 = r.indexOf(0x09, t1 + 1);
    if (t2 < 0) continue;
    const a = r.subarray(0, t1).toString("latin1");
    const d = r.subarray(t1 + 1, t2).toString("latin1");
    const binary = a === "-" || d === "-";
    const added = binary || !/^\d+$/.test(a) ? null : Number(a);
    const removed = binary || !/^\d+$/.test(d) ? null : Number(d);
    if (t2 === r.length - 1) {
      // two-path form: next two records are source, then destination
      const from = recs[++i];
      const path = recs[++i];
      if (from === undefined || path === undefined) break;
      result.push({ added, removed, binary, path, from });
    } else {
      result.push({ added, removed, binary, path: r.subarray(t2 + 1) });
    }
  }
  return result;
}

// ── for-each-ref ────────────────────────────────────────────────────────────

// Five NUL-terminated fields per branch; git then appends its own LF. No
// field can contain a NUL, so splitting on NUL and taking fields in groups
// of five is exact — the LF that precedes every record but the first is
// stripped from that record's first field only, so a worktree path with a
// newline inside it is untouched.
const REF_FIELDS = 5;
const REF_FORMAT = "%(refname:short)%00%(objectname)%00%(HEAD)%00%(worktreepath)%00%(upstream:short)%00";

export function parseForEachRefZ(out: Buffer): GitBranchRef[] {
  const refs: GitBranchRef[] = [];
  const fields = splitNul(out).map(b => decodeBytes(b).text);
  for (let i = 0; i + REF_FIELDS <= fields.length; i += REF_FIELDS) {
    const name = i === 0 ? fields[i] : fields[i].replace(/^\n/, "");
    refs.push({ name, oid: fields[i + 1], current: fields[i + 2] === "*", worktree: fields[i + 3] || null, upstream: fields[i + 4] || null });
  }
  return refs;
}

// ── assembly ────────────────────────────────────────────────────────────────

const NOT_A_REPO = /not a git repository|must be run in a work tree/i;

function detectOperation(gitDir: string): GitOperation | null {
  if (existsSync(resolve(gitDir, "rebase-merge")) || existsSync(resolve(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(resolve(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(resolve(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(resolve(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(resolve(gitDir, "BISECT_LOG"))) return "bisect";
  return null;
}

function failure(r: GitRun, what: string): Extract<GitStatusResult, { ok: false }> {
  if (r.spawnError === "ENOENT") return { v: 2, ok: false, code: "git_missing", error: "git is not installed or not on PATH" };
  if (r.timedOut) return { v: 2, ok: false, code: "timeout", error: `${what} timed out after ${GIT_TIMEOUT_MS}ms` };
  return { v: 2, ok: false, code: "git_failed", error: r.stderr.replace(/\r?\n$/, "") || `${what} failed (exit ${r.code})` };
}

/** Read one session cwd's git state. `git` is injectable for tests. */
export async function readGitStatus(cwd: string, git: GitRunner = runGit): Promise<GitStatusResult> {
  // Single-value queries, one process each: rev-parse has no -z, so asking for
  // several values at once would need a newline split that a path with a
  // newline in it defeats. Each answer is the bytes minus ONE trailing LF.
  const [top, pfx, gd, cd] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--show-prefix"]),
    git(cwd, ["rev-parse", "--absolute-git-dir"]),
    git(cwd, ["rev-parse", "--git-common-dir"]),
  ]);
  if (top.code !== 0) {
    if (top.spawnError || top.timedOut) return failure(top, "git rev-parse");
    if (NOT_A_REPO.test(top.stderr)) return { v: 2, ok: true, relation: "none", cwd };
    return failure(top, "git rev-parse");
  }
  const root = decodeBytes(stripOneLf(top.stdout)).text;
  const prefix = decodeBytes(stripOneLf(pfx.stdout)).text;
  const gitDir = decodeBytes(stripOneLf(gd.stdout)).text;
  const commonRaw = decodeBytes(stripOneLf(cd.stdout)).text;
  const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw);

  const [status, staged, unstaged, refs] = await Promise.all([
    // --no-optional-locks: a read must never take the index lock from the
    // user's own git. -uall lists untracked FILES, not collapsed directories.
    // "-- ." scopes the report to the session cwd inside a larger repository.
    git(cwd, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--branch", "--show-stash", "--untracked-files=all", "--", "."]),
    git(cwd, ["--no-optional-locks", "diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-color", "--", "."]),
    git(cwd, ["--no-optional-locks", "diff", "--numstat", "-z", "--no-ext-diff", "--no-color", "--", "."]),
    git(cwd, ["for-each-ref", `--format=${REF_FORMAT}`, "refs/heads"]),
  ]);
  if (status.code !== 0) return failure(status, "git status");

  const { headers, records } = parsePorcelainV2Z(status.stdout);
  const stagedStats = staged.code === 0 ? indexNumstat(parseNumstatZ(staged.stdout)) : null;
  const unstagedStats = unstaged.code === 0 ? indexNumstat(parseNumstatZ(unstaged.stdout)) : null;
  const branches = refs.code === 0 ? parseForEachRefZ(refs.stdout) : [];

  const head: GitHead = headers.oid === "(initial)"
    ? { kind: "unborn", name: headers.head && headers.head !== "(detached)" ? headers.head : null }
    : headers.head === "(detached)" || headers.head === null
      ? { kind: "detached", oid: headers.oid ?? "" }
      : { kind: "branch", name: headers.head, oid: headers.oid ?? "" };
  const upstream = headers.upstream
    ? { name: headers.upstream, ahead: headers.ab?.ahead ?? null, behind: headers.ab?.behind ?? null }
    : null;

  const entries: GitStatusEntry[] = [];
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, entries: 0 };
  const sumStaged = { added: 0, removed: 0 };
  const sumUnstaged = { added: 0, removed: 0 };
  const side = (code: string, stats: Map<string, NumstatRecord> | null, key: string, sum: { added: number; removed: number }): { lines: LineCount; binary: boolean | null } => {
    if (code === ".") return { lines: { added: 0, removed: 0 }, binary: null };
    if (stats === null) return { lines: "unavailable", binary: null };
    const s = stats.get(key);
    if (!s) return { lines: "unavailable", binary: null };
    if (s.binary || s.added === null || s.removed === null) return { lines: "unavailable", binary: s.binary };
    sum.added += s.added; sum.removed += s.removed;
    return { lines: { added: s.added, removed: s.removed }, binary: false };
  };
  for (const rec of records) {
    const key = byteKey(rec.path);
    const path = makeGitPath(rec.path, prefix);
    counts.entries++;
    if (rec.kind === "untracked") {
      counts.untracked++;
      entries.push({ path, index: "?", worktree: "?", untracked: true, conflict: null, rename: null, submodule: false, binary: null, lines: { staged: { added: 0, removed: 0 }, unstaged: "unavailable" } });
      continue;
    }
    const index = rec.xy[0] ?? ".";
    const worktree = rec.xy[1] ?? ".";
    const submodule = rec.sub[0] === "S";
    const conflict = rec.kind === "unmerged" ? { xy: rec.xy } : null;
    if (conflict) counts.conflicted++;
    else {
      if (index !== ".") counts.staged++;
      if (worktree !== ".") counts.unstaged++;
    }
    const st = side(conflict ? "U" : index, stagedStats, key, sumStaged);
    const un = side(conflict ? "U" : worktree, unstagedStats, key, sumUnstaged);
    const binary = st.binary === true || un.binary === true ? true : st.binary === false || un.binary === false ? false : null;
    const rename = rec.kind === "rename" && rec.from
      ? { from: makeGitPath(rec.from, prefix), score: rec.score?.value ?? null, copy: rec.score?.copy ?? false }
      : null;
    entries.push({ path, index, worktree, untracked: false, conflict, rename, submodule, binary, lines: { staged: st.lines, unstaged: un.lines } });
  }

  return {
    v: 2, ok: true,
    relation: prefix === "" ? "root" : "inside",
    cwd,
    repository: { root, gitDir, commonDir, linkedWorktree: resolve(gitDir) !== resolve(commonDir), prefix },
    head, upstream,
    operation: detectOperation(gitDir),
    stashCount: headers.stash,
    branches,
    entries,
    totals: {
      staged: stagedStats === null ? "unavailable" : sumStaged,
      unstaged: unstagedStats === null ? "unavailable" : sumUnstaged,
      counts,
    },
    clean: entries.length === 0,
  };
}

function indexNumstat(recs: NumstatRecord[]): Map<string, NumstatRecord> {
  const m = new Map<string, NumstatRecord>(); // a Map: "__proto__" is just a filename here (#370)
  for (const r of recs) m.set(byteKey(r.path), r);
  return m;
}
