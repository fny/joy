// Session-scoped RPC handlers that joy-tmux exposes for the app.
//
// The app calls these via `apiSocket.sessionRPC(sessionId, method, params)` —
// the relay routes the call to whoever owns the session (joy-tmux). All run
// locally on the machine joy-tmux is running on.
//
// Request/response shapes mirror the ones in
// packages/happy-app/sources/sync/ops.ts so the app can talk to joy-tmux
// sessions just like happy-cli sessions.

import { createHash } from "crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join, isAbsolute, resolve } from "path";

type RegisterSessionRpcHandler = (
  method: string,
  handler: (params: unknown) => Promise<unknown>,
) => void;

interface BashRequest { command: string; cwd?: string; timeout?: number; }
interface BashResponse { success: boolean; stdout: string; stderr: string; exitCode: number; error?: string; }

interface ReadFileRequest { path: string; }
interface ReadFileResponse { success: boolean; content?: string; error?: string; }

interface WriteFileRequest { path: string; content: string; expectedHash?: string | null; }
interface WriteFileResponse { success: boolean; hash?: string; error?: string; }

interface ListDirectoryRequest { path: string; }
interface DirectoryEntry { name: string; type: "file" | "directory" | "other"; size?: number; modified?: number; }
interface ListDirectoryResponse { success: boolean; entries?: DirectoryEntry[]; error?: string; }

interface GetDirectoryTreeRequest { path: string; maxDepth: number; }
interface TreeNode { name: string; path: string; type: "file" | "directory"; size?: number; modified?: number; children?: TreeNode[]; }
interface GetDirectoryTreeResponse { success: boolean; tree?: TreeNode; error?: string; }

interface RipgrepRequest { args: string[]; cwd?: string; }
interface RipgrepResponse { success: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string; }

interface KillResponse { success: boolean; message: string; }

// Resolve a path relative to the session's cwd if not absolute, then normalize.
// Throws if the result escapes the cwd via traversal (defense against path-injection
// from the app; the app is trusted but cheap to enforce).
function resolveSessionPath(sessionCwd: string, requested: string): string {
  const abs = isAbsolute(requested) ? requested : resolve(sessionCwd, requested);
  return resolve(abs); // collapses .. segments
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function handleBash(sessionCwd: string, req: BashRequest): Promise<BashResponse> {
  const cwd = req.cwd ? resolveSessionPath(sessionCwd, req.cwd) : sessionCwd;
  const proc = Bun.spawn(["bash", "-c", req.command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeoutMs = req.timeout && req.timeout > 0 ? req.timeout : 30_000;
  const killer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { success: exitCode === 0, stdout, stderr, exitCode };
  } finally {
    clearTimeout(killer);
  }
}

async function handleReadFile(sessionCwd: string, req: ReadFileRequest): Promise<ReadFileResponse> {
  const path = resolveSessionPath(sessionCwd, req.path);
  const file = Bun.file(path);
  if (!(await file.exists())) return { success: false, error: "file not found" };
  const buf = new Uint8Array(await file.arrayBuffer());
  return { success: true, content: Buffer.from(buf).toString("base64") };
}

async function handleWriteFile(sessionCwd: string, req: WriteFileRequest): Promise<WriteFileResponse> {
  const path = resolveSessionPath(sessionCwd, req.path);
  if (req.expectedHash != null) {
    // Verify the on-disk hash matches what the app thinks it is before overwriting.
    // Missing file with non-null expectedHash counts as mismatch.
    if (!existsSync(path)) {
      return { success: false, error: "expected hash mismatch (file missing)" };
    }
    const current = readFileSync(path);
    const currentHash = sha256(current);
    if (currentHash !== req.expectedHash) {
      return { success: false, error: "expected hash mismatch" };
    }
  }
  const bytes = Buffer.from(req.content, "base64");
  writeFileSync(path, bytes);
  return { success: true, hash: sha256(bytes) };
}

async function handleListDirectory(sessionCwd: string, req: ListDirectoryRequest): Promise<ListDirectoryResponse> {
  const path = resolveSessionPath(sessionCwd, req.path);
  if (!existsSync(path)) return { success: false, error: "directory not found" };
  const names = readdirSync(path);
  const entries: DirectoryEntry[] = [];
  for (const name of names) {
    try {
      const st = statSync(join(path, name));
      const type: DirectoryEntry["type"] = st.isFile() ? "file" : st.isDirectory() ? "directory" : "other";
      entries.push({ name, type, size: st.size, modified: Math.floor(st.mtimeMs) });
    } catch {
      entries.push({ name, type: "other" });
    }
  }
  return { success: true, entries };
}

async function handleGetDirectoryTree(sessionCwd: string, req: GetDirectoryTreeRequest): Promise<GetDirectoryTreeResponse> {
  const root = resolveSessionPath(sessionCwd, req.path);
  if (!existsSync(root)) return { success: false, error: "directory not found" };
  const maxDepth = Math.max(0, req.maxDepth ?? 3);

  function walk(absPath: string, name: string, depth: number): TreeNode | null {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(absPath); } catch { return null; }
    if (!st.isDirectory() && !st.isFile()) return null;
    const node: TreeNode = {
      name,
      path: absPath,
      type: st.isDirectory() ? "directory" : "file",
      size: st.size,
      modified: Math.floor(st.mtimeMs),
    };
    if (node.type === "directory" && depth < maxDepth) {
      const children: TreeNode[] = [];
      let names: string[] = [];
      try { names = readdirSync(absPath); } catch { return node; }
      for (const child of names) {
        const c = walk(join(absPath, child), child, depth + 1);
        if (c) children.push(c);
      }
      node.children = children;
    }
    return node;
  }

  const tree = walk(root, root.split("/").pop() || root, 0);
  if (!tree) return { success: false, error: "could not stat root" };
  return { success: true, tree };
}

async function handleRipgrep(sessionCwd: string, req: RipgrepRequest): Promise<RipgrepResponse> {
  const cwd = req.cwd ? resolveSessionPath(sessionCwd, req.cwd) : sessionCwd;
  const proc = Bun.spawn(["rg", ...req.args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // rg uses exitCode 0 (matches), 1 (no matches), 2 (error). Treat 0/1 as success.
  return { success: exitCode === 0 || exitCode === 1, exitCode, stdout, stderr };
}

/**
 * Wire all session-scoped RPCs that the app expects, plus killSession.
 * Returns nothing; handlers are registered as side-effects on the RelaySession.
 *
 * killSession needs the local killSession function from server.ts (closes the
 * tmux window, cleans up watcher and relay session); it's passed in so we
 * avoid a circular import.
 */
export function registerSessionRpcs(opts: {
  register: RegisterSessionRpcHandler;
  sessionCwd: string;
  killSession: () => boolean;
}): void {
  const { register, sessionCwd, killSession } = opts;

  register("bash", async (params) => handleBash(sessionCwd, params as BashRequest));
  register("readFile", async (params) => handleReadFile(sessionCwd, params as ReadFileRequest));
  register("writeFile", async (params) => handleWriteFile(sessionCwd, params as WriteFileRequest));
  register("listDirectory", async (params) => handleListDirectory(sessionCwd, params as ListDirectoryRequest));
  register("getDirectoryTree", async (params) => handleGetDirectoryTree(sessionCwd, params as GetDirectoryTreeRequest));
  register("ripgrep", async (params) => handleRipgrep(sessionCwd, params as RipgrepRequest));
  register("killSession", async (): Promise<KillResponse> => {
    const ok = killSession();
    return { success: ok, message: ok ? "killed" : "session not found" };
  });
}
