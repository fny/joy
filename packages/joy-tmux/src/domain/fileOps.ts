// File/shell operation handlers exposed to the app for joy-tmux sessions.
//
// Mirrors the behavior of happy-cli's registerCommonHandlers so the app's
// file browser, search, diff view, and archive button behave the same against
// joy-tmux sessions as they do against happy-cli sessions. Request/response
// shapes mirror packages/happy-app/sources/sync/ops.ts.
//
// All handlers are pure functions of (workingDirectory, params) — transport
// binding (relay RPC, HTTP) happens in operations.ts.

import { createHash } from "crypto";
import { spawn as nodeSpawn, exec, type ExecOptions } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { platform } from "os";

const execAsync = promisify(exec);

// Resolve to happy-cli's bundled tool binaries the same way happy-cli does
// (postinstall unpacks them into packages/happy-cli/tools/unpacked/). The
// binaries are platform-specific and live next to joy-tmux in the monorepo.
const HAPPY_CLI_TOOLS = resolve(import.meta.dir, "..", "happy-cli", "tools", "unpacked");
const DIFFT_BIN = join(HAPPY_CLI_TOOLS, platform() === "win32" ? "difft.exe" : "difft");
const RG_BIN = join(HAPPY_CLI_TOOLS, platform() === "win32" ? "rg.exe" : "rg");

export interface BashRequest { command: string; cwd?: string; timeout?: number; }
export interface BashResponse { success: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string; }

export interface ReadFileRequest { path: string; }
export interface ReadFileResponse { success: boolean; content?: string; error?: string; }

export interface WriteFileRequest { path: string; content: string; expectedHash?: string | null; }
export interface WriteFileResponse { success: boolean; hash?: string; error?: string; }

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

// Mirrors happy-cli/src/modules/common/pathSecurity.validatePath. Restricts
// access to paths within the session's working directory; rejects traversal.
export function validatePath(targetPath: string, workingDirectory: string): { valid: boolean; resolvedPath?: string; error?: string } {
  const resolvedTarget = resolve(workingDirectory, targetPath);
  const resolvedWorkingDir = resolve(workingDirectory);
  if (
    !resolvedTarget.startsWith(resolvedWorkingDir + sep) &&
    resolvedTarget !== resolvedWorkingDir
  ) {
    return {
      valid: false,
      resolvedPath: resolvedTarget,
      error: `Access denied: Path '${targetPath}' is outside the working directory`,
    };
  }
  return { valid: true, resolvedPath: resolvedTarget };
}

export async function handleBash(workingDirectory: string, data: BashRequest): Promise<BashResponse> {
  // Special case: "/" means "use the shell's default cwd" (matches happy-cli; used by CLI detection).
  if (data.cwd && data.cwd !== "/") {
    const validation = validatePath(data.cwd, workingDirectory);
    if (!validation.valid) return { success: false, error: validation.error };
    data.cwd = validation.resolvedPath;
  }

  try {
    const options: ExecOptions = {
      // No cwd → the session's working directory. happy-cli gets this
      // implicitly (its process cwd IS the session dir); joy-tmux's daemon
      // cwd is unrelated, so it must be explicit. "/" still means "shell
      // default" (CLI detection).
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

export async function handleReadFile(workingDirectory: string, data: ReadFileRequest): Promise<ReadFileResponse> {
  const validation = validatePath(data.path, workingDirectory);
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
// ripgrep and difftastic. Matches happy-cli's behavior: ANY exit code counts
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
  // Prefer the bundled rg shipped alongside happy-cli; fall back to system `rg`.
  const binary = existsSync(RG_BIN) ? RG_BIN : "rg";
  try {
    const result = await runTool(binary, data.args, cwd ?? workingDirectory);
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
  // Always use the bundled difft (no reliable system-wide install path).
  if (!existsSync(DIFFT_BIN)) {
    return { success: false, error: `difft binary not found at ${DIFFT_BIN}. Run \`node scripts/unpack-tools.cjs\` in packages/happy-cli to unpack it.` };
  }
  try {
    const result = await runTool(DIFFT_BIN, data.args, cwd ?? workingDirectory, { FORCE_COLOR: "1" });
    return { success: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Failed to run difftastic" };
  }
}
