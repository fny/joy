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
import { readFile, writeFile, readdir, stat, lstat, unlink } from "fs/promises";
import { join, resolve, sep, dirname, basename } from "path";
import { homedir } from "os";

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
    return realTarget === r || realTarget.startsWith(r + sep);
  };
  // Jailed to the session cwd, plus any explicitly allowed extra roots (the
  // readFile op passes the session's own ~/.joy/sessions/<id> dir so the app
  // can fetch joy-img media — each session reaches ONLY its own folder).
  if (!within(workingDirectory) && !extraRoots.some(within)) return denied;
  return { valid: true, resolvedPath: realTarget, lexicalPath: resolvedTarget };
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

export async function handleWriteFile(workingDirectory: string, data: WriteFileRequest): Promise<WriteFileResponse> {
  const validation = validatePath(data.path, workingDirectory);
  if (!validation.valid) return { success: false, error: validation.error };
  const targetPath = validation.resolvedPath!;
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
    await writeFile(targetPath, buffer);
    const hash = createHash("sha256").update(buffer).digest("hex");
    return { success: true, hash };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to write file" };
  }
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

export async function handleListDirectory(workingDirectory: string, data: ListDirectoryRequest): Promise<ListDirectoryResponse> {
  const validation = validatePath(data.path, workingDirectory);
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

export async function handleGetDirectoryTree(workingDirectory: string, data: GetDirectoryTreeRequest): Promise<GetDirectoryTreeResponse> {
  const validation = validatePath(data.path, workingDirectory);
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

// Spawn an external tool, capture stdout/stderr, return result. Used by
// ripgrep and difftastic. ANY exit code counts
// as success — the app inspects exitCode itself. Only spawn errors (ENOENT,
// permission denied) cause success=false.
function runTool(binary: string, args: string[], cwd?: string, extraEnv?: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = nodeSpawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      windowsHide: true,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { resolveResult({ exitCode: code ?? 0, stdout, stderr }); });
    child.on("error", (err) => { rejectResult(err); });
  });
}

export async function handleRipgrep(workingDirectory: string, data: RipgrepRequest): Promise<RipgrepResponse> {
  let cwd = data.cwd;
  if (cwd) {
    const validation = validatePath(cwd, workingDirectory);
    if (!validation.valid) return { success: false, error: validation.error };
    cwd = validation.resolvedPath;
  }
  try {
    const result = await runTool(RG_BIN, data.args, cwd ?? workingDirectory);
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
  try {
    const result = await runTool(DIFFT_BIN, data.args, cwd ?? workingDirectory, { FORCE_COLOR: "1" });
    return { success: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to run difftastic" };
  }
}
