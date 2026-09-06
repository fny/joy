// File/shell operation handlers exposed to the app for joy-daemon sessions.
//
// Backs the app's file browser, search, diff view, and archive button.
// Request/response shapes are the frozen app contract (joy-app
// sources/sync/ops.ts).
//
// All handlers are pure functions of (workingDirectory, params) — transport
// binding (v2 tunnel RPC, HTTP) happens in operations.ts.

import { createHash } from "crypto";
import { spawn as nodeSpawn, exec, type ExecOptions } from "child_process";
import { promisify } from "util";
import { existsSync, realpathSync, lstatSync } from "fs";
import { readFile, readdir, stat, lstat, unlink } from "fs/promises";
import { join, resolve, sep, dirname, basename } from "path";
import { homedir, tmpdir } from "os";
import { writeFileAtomicAsync } from "./atomicWrite";
import { TextAccumulator } from "./textStream";

const execAsync = promisify(exec);

// ripgrep + difftastic come from the host: $JOY_TOOLS_DIR/<bin> if set
// (a directory holding rg/difft), else whatever is on PATH.
function toolBin(name: string): string {
  const dir = process.env.JOY_TOOLS_DIR;
  if (dir) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}
const DIFFT_BIN = toolBin("difft");
const RG_BIN = toolBin("rg");

export interface BashRequest { command: string; cwd?: string; timeout?: number; }
export interface BashResponse { success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string; }

export interface ReadFileRequest { path: string; }
export interface ReadFileResponse { success: boolean; content?: string; error?: string; }

export interface WriteFileRequest { path: string; content: string; expectedHash?: string | null; }
export interface WriteFileResponse { success: boolean; hash?: string; error?: string; }

export interface DeleteFileRequest { path: string; }
export interface DeleteFileResponse { success: boolean; error?: string; }

export interface ListDirectoryRequest { path: string; }
export interface DirectoryEntry { name: string; type: "file" | "directory" | "other"; size?: number; modified?: number; }
export interface ListDirectoryResponse { success: boolean; entries?: DirectoryEntry[]; error?: string; }

export interface GetDirectoryTreeRequest { path: string; maxDepth: number; }
export interface TreeNode { name: string; path: string; type: "file" | "directory"; size?: number; modified?: number; children?: TreeNode[]; }
export interface GetDirectoryTreeResponse { success: boolean; tree?: TreeNode; error?: string; }

export interface RipgrepRequest { args: string[]; cwd?: string; }
export interface RipgrepResponse { success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string; }

export interface DifftasticRequest { args: string[]; cwd?: string; }
export interface DifftasticResponse { success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string; }

/** Resolve symlinks in `p` even when a suffix of it does not exist yet:
 *  realpath the deepest ancestor that EXISTS AS A LINK-OR-FILE-OR-DIR
 *  (lstat, not existsSync — a dangling symlink "exists" as a link and must
 *  NOT be treated as an unborn plain suffix, or an escaping link whose target
 *  does not exist yet slips the jail on write). realpathSync then canonicalizes
 *  that ancestor, chasing a final-component link when it resolves and throwing
 *  (→ null → denied) on a dangling one. Remaining unborn components re-append. */
function lexists(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}
function realResolve(p: string): string | null {
  let base = p;
  const tail: string[] = [];
  while (!lexists(base)) {
    const parent = dirname(base);
    if (parent === base) break; // filesystem root
    tail.unshift(basename(base));
    base = parent;
  }
  try {
    return join(realpathSync(base), ...tail);
  } catch {
    return null;
  }
}

// Path jail for every file op. Restricts
// access to paths within the session's working directory; rejects traversal.
//
// Containment is checked on REAL paths, not lexical ones: a symlink planted
// inside the tree (`cwd/link -> /etc`) used to pass the lexical prefix check
// and let reads AND writes follow it out of the jail. Both sides of the
// comparison are realpath'd so a cwd that is itself behind a symlink still
// admits its own files. The returned resolvedPath is the REAL path, so
// downstream operations cannot re-traverse a link the check already chased.
// (Validation-to-use raciness — a dir swapped for a symlink after the check —
// is not closed here; that needs O_NOFOLLOW-style opens.)
export function validatePath(targetPath: string, workingDirectory: string, extraRoots: string[] = []): { valid: boolean; resolvedPath?: string; lexicalPath?: string; error?: string } {
  // Expand a leading ~/ — resolve() doesn't, and the joy-img contract points at
  // files under the caller's home (the per-session media dir).
  const expanded = targetPath === "~" || targetPath.startsWith("~/")
    ? join(homedir(), targetPath.slice(1))
    : targetPath;
  const resolvedTarget = resolve(workingDirectory, expanded);
  const denied = {
    valid: false,
    resolvedPath: resolvedTarget,
    error: `Access denied: Path '${targetPath}' is outside the working directory`,
  };
  const realTarget = realResolve(resolvedTarget);
  if (realTarget === null) return denied;
  const within = (root: string) => {
    const r = realResolve(resolve(root));
    if (r === null) return false;
    // A root that already ends in the separator (the filesystem root "/")
    // must not grow a second one: `"//"` is a prefix of nothing, so a session
    // whose cwd is "/" rejected every one of its own descendants (#536).
    const prefix = r.endsWith(sep) ? r : r + sep;
    return realTarget === r || realTarget.startsWith(prefix);
  };
  // Jailed to the session cwd, plus any explicitly allowed extra roots (the
  // readFile op passes the session's own ~/.joy/sessions/<id> dir so the app
  // can fetch joy-img media — each session reaches ONLY its own folder).
  if (!within(workingDirectory) && !extraRoots.some(within)) return denied;
  return { valid: true, resolvedPath: realTarget, lexicalPath: resolvedTarget };
}

/** Roots the app may READ from in every session, beyond the session cwd: the
 *  machine's temp dir(s). Agents drop reports, renders and exports in /tmp and
 *  hand the app a <joy-file> link to them; until 2026-09-03 every such tap was
 *  refused as "outside the working directory". /tmp is shared by every process
 *  on the box, so this is a real widening — deliberately READ-ONLY (view,
 *  download, list, grep): write and delete stay jailed to the cwd. Both the
 *  literal /tmp and os.tmpdir() are listed because macOS agents write to
 *  $TMPDIR (/var/folders/…), not /tmp. */
export const TEMP_ROOTS: string[] = [...new Set(["/tmp", tmpdir()])];

/** Extra roots for a read-side op: the caller's per-session roots plus the temp dirs. */
export function readRoots(sessionRoots: string[] = []): string[] {
  return [...sessionRoots, ...TEMP_ROOTS];
}

export async function handleBash(workingDirectory: string, data: BashRequest): Promise<BashResponse> {
  // Special case: "/" means "use the shell's default cwd" (used by CLI detection).
  if (data.cwd && data.cwd !== "/") {
    const validation = validatePath(data.cwd, workingDirectory);
    if (!validation.valid) return { success: false, error: validation.error };
    data.cwd = validation.resolvedPath;
  }

  try {
    const options: ExecOptions = {
      // No cwd → the session's working directory (the daemon's own cwd is
      // unrelated, so it must be explicit). "/" still means "shell default"
      // (CLI detection).
      cwd: data.cwd === "/" ? undefined : (data.cwd ?? workingDirectory),
      timeout: data.timeout || 30_000,
      windowsHide: true,
    };
    const { stdout, stderr } = await execAsync(data.command, options);
    return {
      success: true,
      stdout: stdout ? stdout.toString() : "",
      stderr: stderr ? stderr.toString() : "",
      exitCode: 0,
    };
  } catch (error) {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string; stderr?: string; code?: number | string; killed?: boolean;
    };
    if (execError.code === "ETIMEDOUT" || execError.killed) {
      return {
        success: false,
        stdout: execError.stdout || "",
        stderr: execError.stderr || "",
        exitCode: typeof execError.code === "number" ? execError.code : -1,
        error: "Command timed out",
      };
    }
    return {
      success: false,
      stdout: execError.stdout ? execError.stdout.toString() : "",
      stderr: execError.stderr ? execError.stderr.toString() : execError.message || "Command failed",
      exitCode: typeof execError.code === "number" ? execError.code : 1,
      error: execError.message || "Command failed",
    };
  }
}

export async function handleReadFile(workingDirectory: string, data: ReadFileRequest, extraRoots: string[] = []): Promise<ReadFileResponse> {
  const validation = validatePath(data.path, workingDirectory, extraRoots);
  if (!validation.valid) return { success: false, error: validation.error };
  try {
    const buffer = await readFile(validation.resolvedPath!);
    return { success: true, content: buffer.toString("base64") };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to read file" };
  }
}

// Per-path write serialization (#63): the expectedHash compare and the write
// must be ONE critical section. Two clients PUTting different content against
// the same expectedHash both read the file (both hashes match), then both
// wrote — both returned success and one edit was silently lost. Keyed by the
// REAL path so two spellings of one file (symlink, `./`) share the lock.
// In-process only: the daemon is the sole writer on behalf of the app; other
// processes editing the tree are outside this contract.
const pathLocks = new Map<string, Promise<unknown>>();
export async function withPathLock<T>(realPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(realPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const mine = prev.then(() => gate);
  pathLocks.set(realPath, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(realPath) === mine) pathLocks.delete(realPath);
  }
}

export async function handleWriteFile(workingDirectory: string, data: WriteFileRequest): Promise<WriteFileResponse> {
  const validation = validatePath(data.path, workingDirectory);
  if (!validation.valid) return { success: false, error: validation.error };
  const targetPath = validation.resolvedPath!;
  return withPathLock(targetPath, async () => {
    try {
      if (data.expectedHash !== null && data.expectedHash !== undefined) {
        // Must match existing file's hash.
        try {
          const existingBuffer = await readFile(targetPath);
          const existingHash = createHash("sha256").update(existingBuffer).digest("hex");
          if (existingHash !== data.expectedHash) {
            return { success: false, error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}` };
          }
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== "ENOENT") throw error;
          return { success: false, error: "File does not exist but hash was provided" };
        }
      } else {
        // expectedHash === null → expecting a NEW file; reject if one exists.
        try {
          await stat(targetPath);
          return { success: false, error: "File already exists but was expected to be new" };
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== "ENOENT") throw error;
          // File doesn't exist — proceed.
        }
      }
      const buffer = Buffer.from(data.content, "base64");
      // Atomic replace (#539): fs.writeFile truncates first, so an ENOSPC
      // mid-write left only a partial replacement of the user's source file
      // with no backup and no rollback. The complete new contents land in a
      // sibling temp file and are renamed in; on any failure the original is
      // still there, byte for byte.
      await writeFileAtomicAsync(targetPath, buffer);
      const hash = createHash("sha256").update(buffer).digest("hex");
      return { success: true, hash };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : "Failed to write file" };
    }
  });
}

/**
 * Delete a single FILE inside the session cwd. Same jail as every other file op
 * (validatePath — no traversal, no extra roots: unlike readFile there is no
 * reason to reach the session media dir).
 *
 * Deliberately refuses directories: rmdir/recursive removal is a categorically
 * bigger blast radius than "delete the file I am looking at", which is the only
 * thing the app exposes. A missing file reports failure rather than succeeding
 * silently, so the UI can tell "already gone" from "deleted".
 */
export async function handleDeleteFile(workingDirectory: string, data: DeleteFileRequest): Promise<DeleteFileResponse> {
  const validation = validatePath(data.path, workingDirectory);
  if (!validation.valid) return { success: false, error: validation.error };
  // Unlink the path the user NAMED (the link), never the canonical target —
  // validatePath already proved the real target is inside the jail.
  const targetPath = validation.lexicalPath ?? validation.resolvedPath!;
  try {
    const info = await lstat(targetPath);
    if (info.isDirectory()) return { success: false, error: "Path is a directory; only files can be deleted" };
    await unlink(targetPath);
    return { success: true };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return { success: false, error: "File does not exist" };
    return { success: false, error: error instanceof Error ? error.message : "Failed to delete file" };
  }
}

export async function handleListDirectory(workingDirectory: string, data: ListDirectoryRequest, extraRoots: string[] = []): Promise<ListDirectoryResponse> {
  const validation = validatePath(data.path, workingDirectory, extraRoots);
  if (!validation.valid) return { success: false, error: validation.error };
  try {
    const directoryPath = validation.resolvedPath!;
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const directoryEntries: DirectoryEntry[] = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(directoryPath, entry.name);
        let type: DirectoryEntry["type"] = "other";
        if (entry.isDirectory()) type = "directory";
        else if (entry.isFile()) type = "file";
        let size: number | undefined;
        let modified: number | undefined;
        try {
          const stats = await stat(fullPath);
          size = stats.size;
          modified = stats.mtime.getTime();
        } catch { /* skip stat failure */ }
        return { name: entry.name, type, size, modified };
      }),
    );
    // Sort: directories first, then files, alphabetic.
    directoryEntries.sort((a, b) => {
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });
    return { success: true, entries: directoryEntries };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to list directory" };
  }
}

export async function handleGetDirectoryTree(workingDirectory: string, data: GetDirectoryTreeRequest, extraRoots: string[] = []): Promise<GetDirectoryTreeResponse> {
  const validation = validatePath(data.path, workingDirectory, extraRoots);
  if (!validation.valid) return { success: false, error: validation.error };
  if (data.maxDepth < 0) return { success: false, error: "maxDepth must be non-negative" };

  async function buildTree(path: string, name: string, currentDepth: number): Promise<TreeNode | null> {
    try {
      const stats = await stat(path);
      const node: TreeNode = {
        name,
        path,
        type: stats.isDirectory() ? "directory" : "file",
        size: stats.size,
        modified: stats.mtime.getTime(),
      };
      if (stats.isDirectory() && currentDepth < data.maxDepth) {
        const entries = await readdir(path, { withFileTypes: true });
        const children: TreeNode[] = [];
        await Promise.all(
          entries.map(async (entry) => {
            // Skip symlinks to avoid cycles.
            if (entry.isSymbolicLink()) return;
            const childPath = join(path, entry.name);
            const childNode = await buildTree(childPath, entry.name, currentDepth + 1);
            if (childNode) children.push(childNode);
          }),
        );
        children.sort((a, b) => {
          if (a.type === "directory" && b.type !== "directory") return -1;
          if (a.type !== "directory" && b.type === "directory") return 1;
          return a.name.localeCompare(b.name);
        });
        node.children = children;
      }
      return node;
    } catch {
      return null;
    }
  }

  try {
    const rootPath = validation.resolvedPath!;
    const baseName = rootPath === "/" ? "/" : rootPath.split("/").pop() || rootPath;
    const tree = await buildTree(rootPath, baseName, 0);
    if (!tree) return { success: false, error: "Failed to access the specified path" };
    return { success: true, tree };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to get directory tree" };
  }
}

/** The child environment for a jailed tool run: the daemon's env minus every
 *  variable through which the TOOL reads configuration of its own. The argv
 *  jail below only sees what the caller passed; rg also honours
 *  RIPGREP_CONFIG_PATH, and a user config holding `--follow` made a jailed
 *  `rg pattern .` walk a symlink out of the tree and return an outside file
 *  (#537 residual). difftastic reads DFT_* the same way. Inherited config is
 *  therefore dropped for the child (the forced `--no-config` on rg is the
 *  second belt — see handleRipgrep). */
/** Wall-clock cap on one jailed tool run (#538). */
export const TOOL_TIMEOUT_MS = 120_000;

export function jailedToolEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "RIPGREP_CONFIG_PATH" || k.startsWith("DFT_")) continue;
    env[k] = v;
  }
  return extraEnv ? { ...env, ...extraEnv } : env;
}

// Spawn an external tool, capture stdout/stderr, return result. Used by
// ripgrep and difftastic. ANY exit code counts
// as success — the app inspects exitCode itself. Only spawn errors (ENOENT,
// permission denied) cause success=false. Exported for its test only.
export function runTool(binary: string, args: string[], cwd?: string, extraEnv?: Record<string, string>, timeoutMs = TOOL_TIMEOUT_MS): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = nodeSpawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      windowsHide: true,
      env: jailedToolEnv(extraEnv),
    });
    // Nothing is ever fed to the tool: close stdin so a tool that would read
    // it (rg with no path operand) exits instead of waiting forever. The
    // handlers ALSO give rg a path so it searches the tree rather than this
    // empty pipe — see handleRipgrep (#538).
    child.stdin.end();
    // One decoder per stream: a multibyte character split between two pipe
    // chunks must not become replacement characters in matched text or
    // filenames (#540).
    const stdout = new TextAccumulator();
    const stderr = new TextAccumulator();
    // Deadline (#538): a child that never exits — a tool wedged on a fifo, a
    // pathological regex over a huge tree — used to hold the request and this
    // promise forever. SIGTERM, then SIGKILL, then settle whether or not
    // `close` ever fires: `close` waits for every holder of the pipes, and a
    // signalled shell can leave a grandchild holding them open indefinitely.
    let settled = false;
    let timedOut = false;
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolveResult({ exitCode, stdout: stdout.end(), stderr: stderr.end(), timedOut });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const hard = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        settle(-1);
      }, 2_000);
      hard.unref?.();
    }, timeoutMs);
    deadline.unref?.();
    child.stdout.on("data", (d: Buffer) => { stdout.push(d); });
    child.stderr.on("data", (d: Buffer) => { stderr.push(d); });
    child.on("close", (code) => { settle(code ?? 0); });
    child.on("error", (err) => { if (settled) return; settled = true; clearTimeout(deadline); rejectResult(err); });
  });
}

// ── Tool argv jail (#537) ────────────────────────────────────────────────────
// The app's typed grep/diff routes build argv from validated fields, but the
// session-scoped `ripgrep`/`difftastic` ops take RAW argv, and only `cwd` was
// checked: a positional `/etc/passwd`, `-f /etc/shadow` (pattern FILE),
// `--pre <cmd>` (run a preprocessor on every file), `-L` (follow symlinks
// out of the tree) or `--ignore-file ~/.ssh/config` all read outside every
// allowed root. Policy: allow-list of options the app needs; every positional
// that names a path must validate against the jail; anything else (including
// every unknown option) is refused rather than forwarded. Positionals keep
// the caller's spelling (rg prints filenames relative to the operand it was
// given, and the app parses that), only their containment is checked.
interface ArgvSpec {
  /** Options taking no value. */
  flags: Set<string>;
  /** Options taking one value (also accepted as --opt=value). Value must
   *  match the validator when one is given. */
  valued: Map<string, ((v: string) => boolean) | null>;
  /** Positional handling: which positionals (after options) are paths. */
  positionals: (positionals: string[]) => { paths: string[]; error?: string };
}
const isCount = (v: string) => /^\d{1,7}$/.test(v);
const isWord = (v: string) => /^[A-Za-z0-9_.+:-]{1,64}$/.test(v);
const RG_SPEC: ArgvSpec = {
  flags: new Set([
    "-i", "--ignore-case", "-s", "--case-sensitive", "-S", "--smart-case",
    "-n", "--line-number", "-N", "--no-line-number", "-H", "--with-filename", "-I", "--no-filename",
    "--no-heading", "--heading", "--column", "--no-column", "-o", "--only-matching",
    "-w", "--word-regexp", "-x", "--line-regexp", "-F", "--fixed-strings", "-v", "--invert-match",
    "-l", "--files-with-matches", "--files-without-match", "-c", "--count", "--count-matches",
    "--json", "--files", "--hidden", "--no-ignore", "--no-ignore-vcs", "-U", "--multiline", "--multiline-dotall",
    "--no-messages", "--trim", "--stats", "--null", "-0", "--no-config", "--sort-files",
  ]),
  valued: new Map<string, ((v: string) => boolean) | null>([
    ["-e", null], ["--regexp", null],
    ["-g", null], ["--glob", null], ["--iglob", null],
    ["-t", isWord], ["--type", isWord], ["-T", isWord], ["--type-not", isWord],
    ["-m", isCount], ["--max-count", isCount], ["--max-depth", isCount], ["--maxdepth", isCount],
    ["-A", isCount], ["--after-context", isCount], ["-B", isCount], ["--before-context", isCount], ["-C", isCount], ["--context", isCount],
    ["-M", isCount], ["--max-columns", isCount], ["--max-filesize", (v) => /^\d{1,12}[KMG]?$/.test(v)],
    ["--color", isWord], ["--colors", null], ["--sort", isWord], ["--sortr", isWord], ["-E", isWord], ["--encoding", isWord],
    ["-r", null], ["--replace", null],
  ]),
  // rg: [PATTERN] [PATH...] — the first positional is the pattern unless -e/--regexp
  // supplied it (then every positional is a path). `--files` has no pattern.
  positionals: (ps) => ps.length ? { paths: ps } : { paths: [] },
};
/** Prepended to every jailed rg invocation — see handleRipgrep (#537). */
export const RG_FORCED_ARGS: readonly string[] = ["--no-config", "--no-follow"];
const DIFFT_SPEC: ArgvSpec = {
  flags: new Set(["--skip-unchanged", "--check-only", "--ignore-comments", "--strip-cr", "--exit-code", "--missing-as-empty", "--sort-paths", "--syntax-highlight", "--no-syntax-highlight"]),
  valued: new Map<string, ((v: string) => boolean) | null>([
    ["--context", isCount], ["--width", isCount], ["--tab-width", isCount], ["--graph-limit", isCount], ["--byte-limit", isCount], ["--parse-error-limit", isCount],
    ["--display", isWord], ["--color", isWord], ["--background", isWord], ["--language", isWord], ["--override", null],
  ]),
  positionals: (ps) => ps.length > 2 ? { paths: ps, error: "difftastic accepts at most two paths" } : { paths: ps },
};

/** Validate raw tool argv against the jail. Returns the argv to run (the
 *  caller's own strings — never rewritten) or an error. */
export function jailToolArgs(
  tool: "rg" | "difft",
  args: unknown,
  workingDirectory: string,
  extraRoots: string[] = [],
): { ok: true; args: string[]; pathOperands: string[] } | { ok: false; error: string } {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { ok: false, error: "args must be an array of strings" };
  const spec = tool === "rg" ? RG_SPEC : DIFFT_SPEC;
  const argv = args as string[];
  const positionals: string[] = [];
  let sawPatternFlag = false;
  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (optionsEnded || !a.startsWith("-") || a === "-") {
      // `-` alone means stdin for both tools — refuse it as a path below.
      positionals.push(a);
      continue;
    }
    if (a === "--") { optionsEnded = true; continue; }
    // --opt=value form.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = eq > 0 ? a.slice(eq + 1) : undefined;
    if (spec.flags.has(name)) {
      if (inlineValue !== undefined) return { ok: false, error: `option ${name} takes no value` };
      continue;
    }
    if (spec.valued.has(name)) {
      const check = spec.valued.get(name) ?? null;
      const value = inlineValue ?? argv[++i];
      if (value === undefined) return { ok: false, error: `option ${name} needs a value` };
      if (check && !check(value)) return { ok: false, error: `invalid value for ${name}` };
      if (name === "-e" || name === "--regexp") sawPatternFlag = true;
      continue;
    }
    // Every other option — `-f/--file`, `--pre`, `--pre-glob`, `-L/--follow`,
    // `--ignore-file`, `--type-add`, `--config`, `-z/--search-zip`, combined
    // short flags (`-in`) — is refused: unknown options can name files.
    return { ok: false, error: `option ${name} is not allowed` };
  }
  const { paths, error } = spec.positionals(positionals);
  if (error) return { ok: false, error };
  // rg's first positional is the PATTERN unless -e supplied one; patterns
  // are not paths and are not checked (they never open a file).
  const pathOperands = tool === "rg" && !sawPatternFlag && !argv.includes("--files") ? paths.slice(1) : paths;
  for (const p of pathOperands) {
    if (p === "-" || p === "") return { ok: false, error: "stdin / empty path operands are not allowed" };
    const v = validatePath(p, workingDirectory, extraRoots);
    if (!v.valid) return { ok: false, error: v.error ?? `Access denied: Path '${p}' is outside the working directory` };
  }
  return { ok: true, args: argv, pathOperands };
}

export async function handleRipgrep(workingDirectory: string, data: RipgrepRequest, extraRoots: string[] = []): Promise<RipgrepResponse> {
  let cwd = data.cwd;
  if (cwd) {
    const validation = validatePath(cwd, workingDirectory, extraRoots);
    if (!validation.valid) return { success: false, error: validation.error };
    cwd = validation.resolvedPath;
  }
  // Path operands resolve against the cwd rg will run in, not the session
  // root — the two differ when the caller passed a (validated) `cwd`.
  const jailed = jailToolArgs("rg", data.args, cwd ?? workingDirectory, extraRoots);
  if (!jailed.ok) return { success: false, error: jailed.error };
  try {
    // Forced, and FIRST (a caller's `--` ends option parsing, so anything
    // appended after it would be read as a path): `--no-config` so no
    // RIPGREP_CONFIG_PATH file can add options the jail refused, `--no-follow`
    // so no config, alias or default can make the walk cross a symlink out of
    // the jail (#537 residual). Nothing in RG_SPEC can turn either back on.
    // Default search path (#538). rg searches STDIN, not the tree, when it is
    // given no path operand and stdin is not a tty — and runTool always hands
    // it a pipe. `rg review-needle` in a project full of matches therefore
    // hung on that pipe (and, once it was closed, answered "no matches" while
    // never opening a single project file). An explicit `.` makes the cwd the
    // operand, which is what every caller meant. `--files` lists the tree and
    // never reads stdin, so it is left alone. Filenames then print `./`-
    // prefixed, the way rg always renders them relative to the given operand.
    // Appended bare, never after a `--` of our own: a caller that already
    // ended option parsing would see a second `--` as a literal path.
    const needsDefaultPath = jailed.pathOperands.length === 0 && !jailed.args.includes("--files");
    const argv = [...RG_FORCED_ARGS, ...jailed.args, ...(needsDefaultPath ? ["."] : [])];
    const result = await runTool(RG_BIN, argv, cwd ?? workingDirectory);
    if (result.timedOut) return { success: false, error: `ripgrep exceeded ${TOOL_TIMEOUT_MS / 1000}s and was terminated` };
    return { success: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to run ripgrep" };
  }
}

export async function handleDifftastic(workingDirectory: string, data: DifftasticRequest): Promise<DifftasticResponse> {
  let cwd = data.cwd;
  if (cwd) {
    const validation = validatePath(cwd, workingDirectory);
    if (!validation.valid) return { success: false, error: validation.error };
    cwd = validation.resolvedPath;
  }
  const jailed = jailToolArgs("difft", data.args, cwd ?? workingDirectory);
  if (!jailed.ok) return { success: false, error: jailed.error };
  try {
    const result = await runTool(DIFFT_BIN, jailed.args, cwd ?? workingDirectory, { FORCE_COLOR: "1" });
    if (result.timedOut) return { success: false, error: `difftastic exceeded ${TOOL_TIMEOUT_MS / 1000}s and was terminated` };
    return { success: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to run difftastic" };
  }
}
