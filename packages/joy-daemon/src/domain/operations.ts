// The operation catalog: every operation joy-daemon exposes, defined exactly
// once with its routing metadata for both transports. Transports derive their
// wiring from this table, so the HTTP debug surface and the v2 tunnel RPC surface
// can never drift apart — adding an op here makes it reachable everywhere.
//
//   machine scope → ctx is the SessionRegistry (registered once per daemon,
//                   RPC name prefixed joy-*)
//   session scope → ctx is a resolved Session (dispatched by the v2 tunnel
//                   executor / HTTP route per session id)
//
// Handlers return the RPC-shaped result (the frozen app contract). HTTP
// routes reuse the same result; the few legacy HTTP divergences (create's
// unwrapped 201, kill's 404) are expressed via the optional httpShape.

import type { Session } from "../claude/session";
import { sessionRecords } from "../relay/relay";
import { listEnvVars, setEnvVar, unsetEnvVar, isValidEnvName } from "./envStore";
import type { AgentSession } from "./agentSession";
import type { SessionRegistry } from "./registry";
import { processTreeStats } from "./procStats";
import { forkAgyConversation, forkPiSession, forkCodexThread } from "./forkHarness";
import { notePath, noteRequestPrompt, sessionLabel, runHandoffJob, runHandbackJob, type HandoffTarget } from "./handoff";
import { handleBash, handleReadFile, handleWriteFile, handleDeleteFile, handleListDirectory, handleGetDirectoryTree, handleRipgrep, handleDifftastic, readRoots, withPathLock } from "./fileOps";
import { computeUsage, periodToRange } from "../claude/usage";
import { fetchClaudeLimits, readCodexLimits } from "./limits";
import { readAgentConfig, applyAgentConfigAssignments, writeAgentConfigRaw, fetchAgentSchema } from "./agentConfig";
import { cwdToTranscriptDir, teleportTailOffset } from "../claude/transcript";
import { joySessionDir } from "../paths";
import { ReverseUtf8Assembler } from "./textStream";
import { existsSync, statSync, readdirSync, readFileSync, openSync, readSync, closeSync, rmSync, mkdirSync, writeFileSync, renameSync } from "fs";
import { readFile } from "fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "path";
import { hostname, platform, release, arch } from "os";
import { spawn, execFile } from "child_process";
import { randomBytes } from "crypto";

/** Accepted git URL shapes for a git-URL session spawn. */
export const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/)\S+$/;

/** Clone `gitUrl` into `cwd` for a git-URL session spawn — the ONE clone step
 *  shared by the `create` op and the relay lane (nucleusLane runs it before
 *  spawning, #151). Validates the URL, reuses an existing clone (cwd/.git
 *  present) so re-spawning the same URL lands in the same working copy,
 *  refuses a non-empty non-repo cwd. Resolves on success; throws an Error
 *  whose message is user-facing ("invalid git url", "git clone failed: …").
 *  Full clone (agents want history), generous timeout — the app extends its
 *  RPC race accordingly.
 *
 *  Two safeguards (#547): attempts for the same canonical destination are
 *  SERIALIZED, so a second create for a not-yet-existing cwd waits and then
 *  reuses the first one's checkout instead of racing it; and each attempt
 *  clones into a directory it owns (`.<name>.joy-clone-<rand>` beside the
 *  target), renaming it into place only on success. Cleanup after a failure
 *  removes only the attempt's own directory. The old code cloned straight
 *  into `target` and, on failure, `rmSync(target, {recursive})` — when the
 *  failure was "destination already exists" because a concurrent attempt
 *  had just finished, that deleted the SUCCESSFUL working copy and any work
 *  the launched agent had already done in it. */
export async function cloneForSpawn(gitUrl: string, cwd: string): Promise<void> {
  if (!GIT_URL_RE.test(gitUrl)) throw new Error("invalid git url");
  const canonical = resolvePath(cwd);
  const r = await withPathLock(`git-clone:${canonical}`, () => cloneAttempt(gitUrl, canonical));
  if ("error" in r) throw new Error(r.error);
}

function cloneAttempt(gitUrl: string, target: string): Promise<{ ok: true } | { error: string }> {
  return new Promise((resolve) => {
    // The attempt-owned staging dir. Never `target` itself.
    const staging = join(dirname(target), `.${basename(target)}.joy-clone-${randomBytes(4).toString("hex")}`);
    const cleanupStaging = () => { try { rmSync(staging, { recursive: true, force: true }); } catch { /* our own dir; best effort */ } };
    try {
      if (existsSync(target)) {
        if (existsSync(join(target, ".git"))) return resolve({ ok: true }); // existing clone — reuse
        if (readdirSync(target).length > 0) return resolve({ error: `directory ${target} exists and is not a git repo` });
      }
      mkdirSync(dirname(target), { recursive: true });
      execFile("git", ["clone", gitUrl, staging], { timeout: 220_000 }, (err, _stdout, stderr) => {
        if (err) {
          cleanupStaging();
          const detail = (stderr || String(err)).trim().split("\n").slice(-3).join(" ");
          return resolve({ error: `git clone failed: ${detail.slice(0, 300)}` });
        }
        try {
          // Something else (a user, another process) may have populated the
          // destination while we cloned. A finished repo there is reusable;
          // anything else is theirs to keep — never delete it.
          if (existsSync(target)) {
            if (existsSync(join(target, ".git"))) { cleanupStaging(); return resolve({ ok: true }); }
            if (readdirSync(target).length > 0) { cleanupStaging(); return resolve({ error: `directory ${target} exists and is not a git repo` }); }
            rmSync(target, { recursive: false, force: true }); // an EMPTY dir only — rename needs the name free
          }
          renameSync(staging, target);
          resolve({ ok: true });
        } catch (e) {
          cleanupStaging();
          resolve({ error: `git clone failed: could not move the clone into place: ${e instanceof Error ? e.message : e}` });
        }
      });
    } catch (e) {
      cleanupStaging();
      resolve({ error: `git clone failed: ${e}` });
    }
  });
}

export type HttpMethod = "GET" | "POST" | "DELETE";

/**
 * Re-exec the daemon: spawn a detached replacement that waits for this process
 * to release port 4997, then exit. There's no supervisor, so the daemon restarts
 * itself. Claude runs under tmux (not as our child), so live sessions survive and
 * are re-adopted by the new daemon's recover().
 */
function scheduleDaemonRestart(): void {
  setTimeout(() => {
    try {
      // Reconstruct however this process was launched (node + any loader flags
      // like `--import tsx` + the script path) so the replacement runs the same way.
      const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
      const cmd = argv.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      spawn("sh", ["-c", `sleep 1; exec ${cmd}`], {
        detached: true,
        stdio: "ignore",
        cwd: process.cwd(),
      }).unref();
    } catch { /* fall through to exit */ }
    process.exit(0);
  }, 300);
}

export interface OpMeta {
  /** Which transport invoked the op — send() maps this to the chat-log source. */
  via: "http" | "rpc";
}

/** Per-message text cap so a few huge turns can't bloat the RPC envelope. */
const LOG_MESSAGE_CHARS = 4000;

// Memoized app-server catalog fetch — only used when codex's on-disk
// models_cache.json is absent (see the codexModels op).
let codexModelsMemo: Promise<import("../codex/appServerClient").CodexModel[]> | null = null;

/** Flatten a transcript entry's content into plain text (string or text blocks). */
function transcriptEntryText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * Read the last `limit` real back-and-forth messages (user prompts + assistant
 * replies) from a Claude transcript JSONL — skipping meta, tool-result, and CLI
 * wrapper lines. Newest last. Each message text is capped at LOG_MESSAGE_CHARS.
 */
function parseLogLine(line: string): { role: "user" | "assistant"; text: string; ts: number | null } | null {
  if (!line.trim()) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.isMeta) return null;
  const role = o.type === "user" ? "user" : o.type === "assistant" ? "assistant" : null;
  if (!role) return null;
  let text = transcriptEntryText((o.message as { content?: unknown } | undefined)?.content);
  if (!text) return null;
  // A user line starting with "<" is a tool_result / command wrapper, not a real prompt.
  if (role === "user" && text.startsWith("<")) return null;
  if (text.length > LOG_MESSAGE_CHARS) text = text.slice(0, LOG_MESSAGE_CHARS) + "…";
  const tsRaw = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  return { role, text, ts: Number.isNaN(tsRaw) ? null : tsRaw };
}

/** `chunkBytes` is a test seam. Exported for its test only. */
export function readLastLogMessages(file: string, limit: number, chunkBytes = 256 * 1024): Array<{ role: "user" | "assistant"; text: string; ts: number | null }> {
  // Read the file BACKWARDS in chunks — callers want the last handful of
  // messages (projects-page excerpts use limit=1), and transcripts run to many
  // MB; parsing the whole file per call stalled the daemon event loop.
  const CHUNK = chunkBytes;
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      let start = size;
      // Bytes, not per-chunk strings: a character straddling a chunk boundary
      // is decoded once both halves are present (#548).
      const block = new ReverseUtf8Assembler();
      for (;;) {
        const readStart = Math.max(0, start - CHUNK);
        if (readStart < start) {
          const buf = Buffer.alloc(start - readStart);
          readSync(fd, buf, 0, buf.length, readStart);
          block.prepend(buf);
          start = readStart;
        }
        let lines = block.text().split("\n");
        // Unless we're at the file start, the first line is (possibly) a partial
        // — skip it this round; the next chunk prepend completes it.
        if (start > 0) lines = lines.slice(1);
        const collected: Array<{ role: "user" | "assistant"; text: string; ts: number | null }> = [];
        for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
          const m = parseLogLine(lines[i]);
          if (m) collected.push(m);
        }
        if (collected.length >= limit || start === 0) return collected.reverse();
      }
    } finally { closeSync(fd); }
  } catch { return []; }
}

/** JSON-Schema fragment used for OpenAPI emission (transports/openapi.ts).
 *  Plain objects rather than zod: handlers don't validate through zod today,
 *  so a literal schema keeps the table dependency-free and directly dumpable.
 *  Optional and incremental — un-annotated ops emit permissive object schemas. */
export type OpSchema = Record<string, unknown>;

export interface MachineOp {
  name: string;
  scope: "machine";
  rpcName: string;
  http: { method: HttpMethod; path: string };
  /** One-line human description — surfaces in /openapi.json. */
  summary?: string;
  /** Request params (query/body + path merged, JSON Schema `object`). */
  params?: OpSchema;
  /** Success response shape (JSON Schema). */
  result?: OpSchema;
  handler: (registry: SessionRegistry, params: Record<string, unknown>, meta: OpMeta) => Promise<unknown> | unknown;
  /** Optional HTTP-specific status/body mapping for legacy contract divergences. */
  httpShape?: (result: unknown) => { status: number; body: unknown };
}

export interface SessionOp {
  name: string;
  scope: "session";
  rpcName: string;
  /** null → no dedicated HTTP route (killSession is covered by DELETE /sessions/:id). */
  http: { method: HttpMethod; path: string } | null;
  summary?: string;
  params?: OpSchema;
  result?: OpSchema;
  handler: (session: AgentSession, params: Record<string, unknown>) => Promise<unknown> | unknown;
}

export type Op = MachineOp | SessionOp;

// ── Machine-scoped operations ───────────────────────────────────────────────


/** "Can I talk to this session right now?" — the one computation behind
 *  `joy check`, `joy wait`, and the app's needs-input state. needs_input
 *  = a held approval, or the last assistant text ended in a <joy-options>
 *  block (a question with answers offered). */
export function checkSession(registry: SessionRegistry, id: string): Record<string, unknown> {
  const session = registry.get(id);
  if (!session) return { error: "session_not_found", state: "ended" };
  const permissionMode = session.detectPermissionMode();
  if (session.status === "ended") return { state: "ended", reason: session.endReason ?? null, permissionMode };
  const approvals = session.listApprovals?.() ?? [];
  const qs = session.queueState() as { pendingCount?: number; paused?: boolean };
  const queue = qs.pendingCount ?? 0;
  if (approvals.length > 0) return { state: "needs_input", approvals, queue, permissionMode };
  if (session.busy()) {
    const started = sessionRecords(id).filter((r) => (r.record.content as { data?: { ev?: { t?: string } } }).data?.ev?.t === "turn-start").pop();
    return { state: "busy", busySince: started?.at ?? null, queue, paused: qs.paused === true, permissionMode };
  }
  // Question offered as options: the last text record ends with a joy-options block.
  const lastText = [...sessionRecords(id)].reverse().find((r) => {
    const ev = (r.record.content as { data?: { ev?: { t?: string; text?: string } } }).data?.ev;
    return ev?.t === "text" && typeof ev.text === "string";
  });
  const text = ((lastText?.record.content as { data?: { ev?: { text?: string } } })?.data?.ev?.text ?? "").trim();
  if (/<\/joy-options>\s*$/.test(text)) {
    const question = text.replace(/<joy-options>[\s\S]*$/, "").trim().split("\n").slice(-3).join("\n");
    const options = [...text.matchAll(/<joy-option>([\s\S]*?)<\/joy-option>/g)].map((m) => m[1].trim());
    return { state: "needs_input", question, options, queue, permissionMode };
  }
  return { state: "idle", queue, permissionMode, lastActiveAt: (session as { lastActiveAt?: number }).lastActiveAt ?? null };
}

export const machineOps: MachineOp[] = [
  {
    name: "list",
    scope: "machine",
    rpcName: "joy-list-sessions",
    summary: "List all sessions on this machine (includes agent flavor per record)",
    http: { method: "GET", path: "/sessions" },
    handler: (registry) => registry.list().map(s => s.toJSON()),
  },
  {
    name: "codexModels",
    scope: "machine",
    rpcName: "joy-codex-models",
    summary: "Curated codex model list",
    http: { method: "GET", path: "/codex/models" },
    // The codex model catalog for the app's picker. FAST PATH: codex's own
    // on-disk cache ($CODEX_HOME/models_cache.json — codex refreshes it on
    // every run), served instantly with no process spawn. Fallback (fresh
    // machine where codex never ran): the old short-lived app-server fetch,
    // memoized for the daemon's lifetime. Best-effort: [] if codex is absent.
    handler: async () => {
      try {
        const { loadCodexModelsCacheFile, fetchCodexModels } = await import("../codex/appServerClient");
        const cached = loadCodexModelsCacheFile();
        if (cached) return { ok: true, models: cached.filter((m) => !m.hidden) };
        if (!codexModelsMemo) codexModelsMemo = fetchCodexModels().catch((e) => { codexModelsMemo = null; throw e; });
        return { ok: true, models: await codexModelsMemo };
      } catch (e) {
        return { ok: false, models: [], error: String(e) };
      }
    },
  },
  {
    name: "agyModels",
    scope: "machine",
    rpcName: "joy-agy-models",
    summary: "Antigravity (agy) model list — display names, as `agy --model` takes them",
    http: { method: "GET", path: "/agy/models" },
    handler: async () => {
      try {
        const { listAgyModels } = await import("../agy/models");
        return { ok: true, models: await listAgyModels() };
      } catch (e) {
        return { ok: false, models: [], error: String(e) };
      }
    },
  },
  {
    name: "opencodeModels",
    scope: "machine",
    rpcName: "joy-opencode-models",
    summary: "Curated opencode model list",
    http: { method: "GET", path: "/opencode/models" },
    // Static curated allowlist (v1) — no server spawn, instant.
    handler: async () => {
      const { OPENCODE_MODELS } = await import("../opencode/models");
      return { ok: true, models: OPENCODE_MODELS };
    },
  },
  {
    name: "opencodeSessions",
    scope: "machine",
    rpcName: "joy-opencode-sessions",
    summary: "List resumable opencode server sessions",
    http: { method: "GET", path: "/opencode/sessions" },
    // Past-sessions picker: opencode sessions recorded for a directory,
    // newest first. Spawns a short-lived server (see listOpencodeSessionsForCwd).
    handler: async (_registry, params) => {
      const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
      if (!cwd) return { ok: false, error: "cwd required", sessions: [] };
      try {
        const { listOpencodeSessionsForCwd } = await import("../opencode/opencodeClient");
        const { expandHome } = await import("./registry");
        return { ok: true, sessions: await listOpencodeSessionsForCwd(expandHome(cwd)) };
      } catch (e) {
        return { ok: false, error: String(e), sessions: [] };
      }
    },
  },
  {
    name: "opencodeSetModel",
    scope: "machine",
    rpcName: "joy-opencode-set-model",
    summary: "Switch a live opencode session's model",
    http: { method: "POST", path: "/sessions/:id/opencode/model" },
    // Mid-session model switch, allowlist-validated (same policy as create).
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { ok: false, error: "session_not_found" };
      const { OPENCODE_MODELS } = await import("../opencode/models");
      const { OpencodeSession } = await import("../opencode/opencodeSession");
      if (!(session instanceof OpencodeSession)) return { ok: false, error: "not an opencode session" };
      const m = OPENCODE_MODELS.find((x) => x.id === params.model);
      if (!m) return { ok: false, error: "unknown model" };
      return await session.setModel(m.id, m.providerID);
    },
  },
  {
    name: "refreshCommands",
    scope: "machine",
    rpcName: "joy-refresh-commands",
    summary: "Re-scan slash commands on this machine",
    http: { method: "POST", path: "/commands/refresh" },
    // Machine-page refresh: re-scan personal + plugins + every known project
    // (prunes removed ones), push the union to machine metadata, and return it.
    handler: (registry) => registry.commands.refresh(),
  },
  {
    name: "get",
    scope: "machine",
    rpcName: "joy-get-session",
    summary: "Fetch one session record",
    http: { method: "GET", path: "/sessions/:id" },
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const record = session.toJSON();
      // Live CPU/RAM for the agent's process tree (sampled, ~400ms). Only on
      // this single-session read — the list op stays cheap.
      const process = await processTreeStats(record.pid);
      return process ? { ...record, process } : record;
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "create",
    scope: "machine",
    rpcName: "joy-create-session",
    summary: "Spawn an agent session (claude|codex|opencode|pi) in a directory",
    http: { method: "POST", path: "/sessions" },
    params: {
      type: "object",
      required: ["cwd"],
      properties: {
        forceNew: { type: "boolean", description: "Never revive a detached session in this folder — always start a new one (#41)" },
        cwd: { type: "string", description: "Working directory (created only with createDir)" },
        agent: { type: "string", enum: ["claude", "codex", "opencode", "pi", "agy"], default: "claude" },
        createDir: { type: "boolean" },
        gitUrl: { type: "string", description: "Clone (or reuse) into cwd before launching" },
        model: { type: "string" },
        fallbackModel: { type: "string" },
        effort: { type: "string" },
        permissionMode: { type: "string" },
        yolo: { type: "boolean", default: true },
        continue: { type: "boolean" },
        resume_id: { type: "string", description: "Claude session id to --resume" },
        resume_limit_mb: { type: "number" },
        forkSession: { type: "boolean", description: "With resume_id: --fork-session (new id, shared history)" },
        extraArgs: { type: "string" },
      },
    },
    result: { type: "object", properties: { session: { type: "object", description: "SessionRecord" }, error: { type: "string" } } },
    // Throws DirectoryCreationApprovalRequired when cwd is missing and
    // createDir isn't set — each transport maps the sentinel to its contract
    // (RPC: requestToApproveDirectoryCreation, HTTP: 422).
    handler: async (registry, params) => {
      const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
      if (!cwd) return { error: "cwd required" };
      // Reject unknown agents LOUDLY instead of falling through to claude.
      // The historical fall-through is how a stale daemon turned "pi" requests
      // into surprise claude sessions (2026-08-15): a newer app sent a flavor
      // this daemon had never heard of and got the default branch. Same
      // philosophy as DirectoryCreationApprovalRequired — never silently
      // substitute; surface it and let the client decide. The app shows this
      // string in its error alert as-is.
      const KNOWN_AGENTS = ["claude", "codex", "opencode", "pi", "agy"] as const;
      const agentRaw = typeof params.agent === "string" && params.agent.trim() ? params.agent.trim() : undefined;
      if (agentRaw && !(KNOWN_AGENTS as readonly string[]).includes(agentRaw)) {
        return { error: `unknown agent "${agentRaw}" — this joy-daemon doesn't support it yet (run \`joy update\` on this machine?)` };
      }
      // git-URL spawn: clone (or reuse) into cwd first, then launch inside it.
      const gitUrl = typeof params.gitUrl === "string" ? params.gitUrl.trim() : "";
      if (gitUrl) {
        try { await cloneForSpawn(gitUrl, cwd); }
        catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
      }
      const session = await registry.create({
        cwd,
        agent: agentRaw === "codex" || agentRaw === "opencode" || agentRaw === "pi" || agentRaw === "agy" ? agentRaw : undefined,
        createDir: params.createDir === true,
        model: typeof params.model === "string" ? params.model : undefined,
        effort: typeof params.effort === "string" ? params.effort : undefined,
        yolo: typeof params.yolo === "boolean" ? params.yolo : undefined,
        continue: params.continue === true,
        resume_id: typeof params.resume_id === "string" ? params.resume_id : undefined,
        forceNew: params.forceNew === true,
        resumeLimitMb: typeof params.resume_limit_mb === "number" ? params.resume_limit_mb : undefined,
        permissionMode: typeof params.permissionMode === "string" ? params.permissionMode : undefined,
        fallbackModel: typeof params.fallbackModel === "string" ? params.fallbackModel : undefined,
        forkSession: params.forkSession === true,
        chrome: params.chrome === true,
        detached: params.detached === true,
        extraArgs: typeof params.extraArgs === "string" ? params.extraArgs : undefined,
      });
      return { ok: true, session: session.toJSON(), relaySessionId: session.relaySessionId };
    },
    // Legacy HTTP contract: 201 with the unwrapped SessionRecord.
    httpShape: (result) => {
      const r = result as { ok?: boolean; session?: unknown; error?: string };
      if (r.ok) return { status: 201, body: r.session };
      if (r.error === "cwd required") return { status: 400, body: { error: "cwd required" } };
      return { status: 500, body: result };
    },
  },
  {
    name: "fork",
    scope: "machine",
    rpcName: "joy-fork-session",
    summary: "Fork a session from its last message into a NEW session (claude: --resume <id> --fork-session)",
    http: { method: "POST", path: "/sessions/:id/fork" },
    // ONE contract for every harness: {ok:true, localSessionId} or
    // {ok:false, error} with a sentence the app shows as-is. Claude forks
    // natively (--fork-session); agy/pi/codex fork by copying their single
    // history file under a fresh id (domain/forkHarness); opencode keeps
    // sessions inside its server with no fork surface and is refused.
    handler: async (registry, params) => {
      const id = String(params.id ?? "");
      if (!/^[0-9a-f]{8}$/.test(id)) return { ok: false, error: "invalid session id" };
      const src = registry.get(id);
      if (!src) return { ok: false, error: "session_not_found" };
      // The CURRENT model/effort, not the launch ones: a /model or /effort
      // change is tracked separately by the adapters and is what the card shows.
      const common = { cwd: src.cwd, model: src.currentModel ?? src.model, effort: (src as { currentEffort?: string }).currentEffort ?? src.effort } as const;
      try {
        let session: AgentSession;
        switch (src.agentFlavor) {
          case "claude": {
            const resumeId = src.claudeSessionId ?? (src.transcriptPath ? basename(src.transcriptPath, ".jsonl") : undefined);
            if (!resumeId) return { ok: false, error: "This session has no conversation to fork yet." };
            session = await registry.create({ ...common, resume_id: resumeId, forkSession: true, forceNew: true, permissionMode: src.detectPermissionMode() ?? undefined });
            break;
          }
          case "agy": {
            const cid = (src as { conversationId?: string }).conversationId;
            if (!cid) return { ok: false, error: "This Antigravity session has no conversation to fork yet — send it a message first." };
            session = await registry.create({ ...common, agent: "agy", resume_id: forkAgyConversation(cid), forceNew: true });
            break;
          }
          case "pi": {
            const pid = (src as { piSessionId?: string }).piSessionId;
            if (!pid) return { ok: false, error: "This pi session has no session file to fork yet." };
            session = await registry.create({ ...common, agent: "pi", resume_id: forkPiSession(pid), forceNew: true });
            break;
          }
          case "codex": {
            const tid = (src as { codexThreadId?: string }).codexThreadId;
            if (!tid) return { ok: false, error: "This Codex session has no thread to fork yet." };
            session = await registry.create({ ...common, agent: "codex", resume_id: forkCodexThread(tid), forceNew: true, permissionMode: src.detectPermissionMode() ?? undefined });
            break;
          }
          default:
            return { ok: false, error: `Fork isn't available for ${src.agentFlavor}: its sessions live inside the ${src.agentFlavor} server, which offers no way to branch one.` };
        }
        return { ok: true, session: session.toJSON(), localSessionId: session.id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "handoff",
    scope: "machine",
    rpcName: "joy-handoff",
    summary: "Hand a session's work to another model: the source writes a handoff note, a new session of the chosen harness/model picks it up in the same cwd",
    http: { method: "POST", path: "/sessions/:id/handoff" },
    params: { type: "object", required: ["agent"], properties: { agent: { type: "string", enum: ["claude", "codex", "opencode", "pi", "agy"] }, model: { type: "string" }, effort: { type: "string" }, permissionMode: { type: "string" } } },
    // Returns at once with {ok, pending:true}; progress is published on the
    // SOURCE card as joy__handoff (writing → handed_off {peer}), and the
    // target card carries picked_up {peer}. The note takes the model a
    // minute or so to write; a tunnel request must not wait on it.
    handler: async (registry, params) => {
      const id = String(params.id ?? "");
      if (!/^[0-9a-f]{8}$/.test(id)) return { ok: false, error: "invalid session id" };
      const src = registry.get(id);
      if (!src) return { ok: false, error: "session_not_found" };
      if (src.status === "ended") return { ok: false, error: "This session has ended; restart it before handing off." };
      const agent = String(params.agent ?? "");
      if (!["claude", "codex", "opencode", "pi", "agy"].includes(agent)) return { ok: false, error: `unknown agent "${agent}"` };
      const target = { agent: agent as HandoffTarget["agent"], model: typeof params.model === "string" ? params.model : undefined, effort: typeof params.effort === "string" ? params.effort : undefined, permissionMode: typeof params.permissionMode === "string" ? params.permissionMode : undefined };
      const targetLabel = `${({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", agy: "Antigravity" } as Record<string, string>)[target.agent]}${target.model ? ` (${target.model})` : ""}`;
      const path = notePath(src.id);
      src.setHandoff?.({ state: "writing", peerLabel: targetLabel, note: path, at: Date.now() });
      src.enqueue(noteRequestPrompt(path, "to", targetLabel), { source: "rpc", mirrorToRelay: true });
      void runHandoffJob(registry, src, target, path);
      return { ok: true, pending: true, note: path };
    },
  },
  {
    name: "handback",
    scope: "machine",
    rpcName: "joy-handback",
    summary: "Hand a picked-up session's work back to the session it came from (the target writes a note; the source receives it as a prompt)",
    http: { method: "POST", path: "/sessions/:id/handback" },
    handler: async (registry, params) => {
      const id = String(params.id ?? "");
      if (!/^[0-9a-f]{8}$/.test(id)) return { ok: false, error: "invalid session id" };
      const tgt = registry.get(id);
      if (!tgt) return { ok: false, error: "session_not_found" };
      const meta = tgt.cardMetadata?.()?.joy__handoff as { state?: string; peer?: string } | undefined;
      const peerId = meta?.peer;
      const src = peerId ? registry.get(peerId) : undefined;
      if (!src) return { ok: false, error: "This session was not picked up from another one (or that session is gone), so there is nothing to hand back to." };
      if (src.status === "ended") return { ok: false, error: `The original session ${peerId} has ended; restart it first.` };
      const path = notePath(tgt.id);
      tgt.setHandoff?.({ state: "writing", peer: src.id, peerLabel: sessionLabel(src), note: path, at: Date.now() });
      tgt.enqueue(noteRequestPrompt(path, "back to", sessionLabel(src)), { source: "rpc", mirrorToRelay: true });
      void runHandbackJob(registry, tgt, src.id, path);
      return { ok: true, pending: true, note: path };
    },
  },
  {
    name: "teleportExport",
    scope: "machine",
    rpcName: "joy-teleport-export",
    summary: "Package a session's conversation to continue it on ANOTHER machine (claude: the resumable transcript tail)",
    http: { method: "POST", path: "/sessions/:id/teleport-export" },
    // Files are NOT included — the folder is assumed to exist (synced) on the
    // target. Only the transcript travels, cut at the last compaction boundary
    // (what Claude actually holds) or a turn-snapped tail under the cap, so it
    // fits one sealed tunnel request on the import side.
    handler: async (registry, params) => {
      const id = String(params.id ?? "");
      if (!/^[0-9a-f]{8}$/.test(id)) return { error: "invalid session id" };
      const src = registry.get(id);
      if (!src) return { error: "session_not_found" };
      if (src.agentFlavor !== "claude") return { error: `teleport is not supported for ${src.agentFlavor} yet` };
      const claudeSessionId = src.claudeSessionId ?? (src.transcriptPath ? basename(src.transcriptPath, ".jsonl") : undefined);
      const path = src.transcriptPath ?? (claudeSessionId ? join(cwdToTranscriptDir(src.cwd), `${claudeSessionId}.jsonl`) : undefined);
      if (!claudeSessionId || !path || !existsSync(path)) return { error: "this session has no transcript to teleport yet" };
      const CAP = 6 * 1024 * 1024; // raw bytes; base64 + JSON stays under the tunnel's 10MB body cap
      const off = teleportTailOffset(path, CAP);
      const size = statSync(path).size;
      const fd = openSync(path, "r");
      let buf: Buffer;
      try {
        const raw = Buffer.alloc(size - off);
        const n = readSync(fd, raw, 0, raw.length, off);
        // The harness may be mid-append: ship only complete lines, so the
        // copy never ends inside a JSON record (codex review, 2026-09-04).
        const cut = raw.subarray(0, n).lastIndexOf(0x0a);
        buf = cut >= 0 ? raw.subarray(0, cut + 1) : raw.subarray(0, n);
      } finally { closeSync(fd); }
      return {
        ok: true, agent: "claude", claudeSessionId, cwd: src.cwd,
        model: src.currentModel ?? src.model, permissionMode: src.detectPermissionMode() ?? undefined,
        bytes: buf.length, truncated: off > 0, transcriptBase64: buf.toString("base64"),
      };
    },
  },
  {
    name: "teleportImport",
    scope: "machine",
    rpcName: "joy-teleport-import",
    summary: "Receive a teleported conversation: write the transcript under the folder's project dir and resume it here",
    http: { method: "POST", path: "/teleport-import" },
    params: {
      type: "object", required: ["cwd", "claudeSessionId", "transcriptBase64"],
      properties: {
        cwd: { type: "string" }, claudeSessionId: { type: "string" }, transcriptBase64: { type: "string" },
        model: { type: "string" }, permissionMode: { type: "string" }, createDir: { type: "boolean" },
      },
    },
    handler: async (registry, params) => {
      const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
      const sid = typeof params.claudeSessionId === "string" ? params.claudeSessionId.trim() : "";
      const b64 = typeof params.transcriptBase64 === "string" ? params.transcriptBase64 : "";
      if (!cwd) return { error: "cwd required" };
      if (!/^[0-9a-f-]{8,64}$/.test(sid)) return { error: "invalid claudeSessionId" };
      if (!b64) return { error: "transcript required" };
      const dir = cwdToTranscriptDir(cwd);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `${sid}.jsonl`);
      // Never clobber a conversation a session HERE is bound to (a same-box
      // teleport into the same folder). A file no session owns — an earlier
      // import's leftover, or the same conversation teleported again — is
      // replaced: the fork already took what it needed from it, and refusing
      // made every retry fail (codex review, 2026-09-04).
      const owned = registry.list().some((s) => s.transcriptPath === target || s.claudeSessionId === sid)
        || registry.listRecords().some((r) => r.claudeSessionId === sid);
      if (owned) return { error: `conversation ${sid.slice(0, 8)} belongs to a session in ${cwd} on this machine` };
      writeFileSync(target, Buffer.from(b64, "base64"));
      // Continue under a NEW claude id (--fork-session): the source keeps its
      // own id — which may still be live if the two machines are one (a
      // same-box teleport into another folder), where a plain --resume would
      // collide. History is intact either way. If the launch fails, remove
      // the file we wrote so a retry is not refused as "already exists".
      try {
        const session = await registry.create({
          cwd, resume_id: sid, forkSession: true, forceNew: true, createDir: params.createDir === true,
          model: typeof params.model === "string" ? params.model : undefined,
          permissionMode: typeof params.permissionMode === "string" ? params.permissionMode : undefined,
        });
        return { ok: true, session: session.toJSON(), localSessionId: session.id };
      } catch (e) {
        try { rmSync(target, { force: true }); } catch { /* best effort */ }
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  },
  {
    name: "restart",
    scope: "machine",
    rpcName: "joy-restart-session",
    summary: "Relaunch a session in place",
    http: { method: "POST", path: "/sessions/:id/restart" },
    // Kills the window and starts a fresh claude in the same cwd resuming
    // the same conversation (--resume, or --continue when the claude session
    // id was never learned). Returns the NEW session — the app should
    // navigate to the returned relaySessionId.
    handler: async (registry, params) => {
      const id = String(params.id ?? "");
      // The id flows into file paths (window-<id>.json), the tmux window name
      // (j-<id>), and the readFile extra root (~/.joy/sessions/<id>) — enforce
      // the same 8-hex shape recover() requires so `../`-style ids can't
      // relocate any of those (defense-in-depth; the surface is token-authed).
      if (!/^[0-9a-f]{8}$/.test(id)) return { error: "invalid session id" };
      const session = await registry.restart({
        id,
        cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      });
      return { ok: true, session: session.toJSON(), relaySessionId: session.relaySessionId };
    },
  },
  {
    name: "kill",
    scope: "machine",
    rpcName: "joy-kill-session",
    summary: "Kill one session",
    http: { method: "DELETE", path: "/sessions/:id" },
    params: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "joy session id" },
        ifStatus: { type: "string", enum: ["starting", "active", "ended"], description: "Only kill when the session's status is exactly this at the moment of the kill decision; otherwise nothing happens and {error:'status_mismatch', status} is returned. The app's detached-session cleanup passes 'ended' so a session that restarted between the user's confirm and the kill is never killed (#174)." },
      },
    },
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { ok: false };
      // Conditional kill (#174, TOCTOU): the app decided to clean up a session
      // it saw as ended; if it restarted in between, the kill must not land.
      // The check and the kill run in the same synchronous tick, so no status
      // change can slip between them.
      const ifStatus = typeof params.ifStatus === "string" ? params.ifStatus : undefined;
      if (ifStatus !== undefined && session.status !== ifStatus) {
        return { ok: false, error: "status_mismatch", status: session.status };
      }
      // A detached session (process already gone) needs forceKill: end() is a
      // no-op on an ended session, so the card stayed "detached", the record
      // and tmux server survived, and the next boot resurrected it (#43).
      if (session.status === "ended") session.forceKill(); else session.end("killed");
      // The REAL archive result: a failed archive must read as failure so the
      // app runs its fallback archive (Astra on 2f803b14).
      return { ok: await session.awaitArchive() };
    },
    httpShape: (result) => {
      const r = result as { ok: boolean; error?: string };
      if (r.error === "status_mismatch") return { status: 409, body: result };
      return { status: r.ok ? 200 : 404, body: result };
    },
  },
  {
    name: "killAll",
    scope: "machine",
    rpcName: "joy-kill-all-sessions",
    summary: "Kill every session on this machine",
    http: { method: "POST", path: "/sessions/kill-all" },
    // Kill every session's tmux window (active AND detached) and archive them.
    handler: (registry) => ({ ok: true, killed: registry.killAll() }),
  },
  {
    name: "restartDaemon",
    scope: "machine",
    rpcName: "joy-restart-daemon",
    summary: "Exec-restart the daemon (tmux sessions survive)",
    http: { method: "POST", path: "/daemon/restart" },
    // Re-exec the daemon. Running Claude sessions live in tmux and survive;
    // recover() re-adopts them. Responds first, then restarts shortly after.
    handler: () => { scheduleDaemonRestart(); return { ok: true }; },
  },
  {
    name: "notify",
    scope: "machine",
    rpcName: "joy-notify",
    summary: "Send a push notification to all devices",
    http: { method: "POST", path: "/notify" },
    // Push a notification to the user's devices, via the daemon's authed relay.
    handler: async (registry, params) => {
      const title = typeof params.title === "string" && params.title.trim() ? params.title.trim() : "Joy";
      const body = typeof params.body === "string" ? params.body : "";
      if (!registry.relayClient) return { ok: false, error: "relay disabled" };
      try {
        const { sent } = await registry.relayClient.sendPush(title, body);
        return { ok: true, sent };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
  },
  {
    name: "send",
    scope: "machine",
    rpcName: "joy-send",
    summary: "Deliver text to a session (queue-routed); optional provenance stamp for agent-to-agent messages",
    params: {
      type: "object",
      required: ["id", "text"],
      properties: {
        id: { type: "string", description: "joy session id" },
        text: { type: "string", description: "Message text; /steer, /title, /joy-prompt etc. are intercepted daemon-side" },
        from: { type: "string", description: "Sender identity: joy:<session id> (must exist here), cli, app, or cron:<name>. The daemon wraps the text in <joy-message from=… reply-to=…> — never trust a caller-written wrapper." },
        replyTo: { type: "string", description: "Where the callee should answer (joy:<id>); omit for no-reply-expected. Defaults to `from` when that is a joy session." },
        exclusive: { type: "boolean", description: "Scripting contract: refuse (busy) instead of queueing when work is in flight, and only drive yolo/read-only sessions" },
      },
    },
    result: { type: "object", properties: { ok: { type: "boolean" }, chat_id: { type: "string" }, queued_id: { type: "string" }, error: { type: "string" } } },
    http: { method: "POST", path: "/send" },
    handler: (registry, params, meta) => {
      const rawText = typeof params.text === "string" ? params.text : "";
      if (!rawText.trim()) return { error: "empty" };
      const session = params.session_id ? registry.get(String(params.session_id)) : undefined;
      if (!session) return { error: "session_not_found" };
      // exclusive: the scripting contract (joy CLI / other programs). Refuse
      // instead of queueing when ANY work is in flight — a script must never
      // silently line up behind a turn it doesn't know about — and only drive
      // sessions in a mode that can't park on a permission dialog mid-turn
      // (bypassPermissions or read-only plan), so a wait can't hang forever.
      if (params.exclusive === true) {
        if (session.busy()) return { error: "busy" };
        const mode = session.detectPermissionMode();
        if (mode !== "bypassPermissions" && mode !== "plan") {
          return { error: "mode_not_scriptable", mode: mode ?? "unknown" };
        }
      }
      // Provenance: the DAEMON writes the wrapper. A joy:<id> sender must be a
      // session this daemon knows (an agent cannot claim to be another one
      // that does not exist here); a caller-supplied wrapper in the text is
      // stripped so it cannot forge the attribute.
      let text = rawText.trim().replace(/^<joy-message\b[^>]*>\s*/i, "").replace(/\s*<\/joy-message>\s*$/i, "");
      const from = typeof params.from === "string" ? params.from.trim() : "";
      if (from) {
        const okFrom = /^joy:[0-9a-f]{8}$/.test(from) ? !!registry.get(from.slice(4)) : /^(cli|app|cron:[A-Za-z0-9_.-]{1,64})$/.test(from);
        if (!okFrom) return { error: "bad_from", from };
        const replyTo = typeof params.replyTo === "string" ? params.replyTo.trim() : (from.startsWith("joy:") ? from : "");
        if (replyTo && !/^joy:[0-9a-f]{8}$/.test(replyTo)) return { error: "bad_reply_to", replyTo };
        // Who, not just which id: harness (+ model) and the sender's title, so
        // the app can say "from Claude Code · Greet CLI (774a97e6)" even for a
        // session it never had a card for. Escaped for the attribute.
        const sender = from.startsWith("joy:") ? registry.get(from.slice(4)) : undefined;
        const fromLabel = sender ? `${sessionLabel(sender)}${sender.summary ? ` · ${sender.summary}` : ""}`.replace(/["<>]/g, "") : "";
        text = `<joy-message from="${from}"${fromLabel ? ` from-label="${fromLabel}"` : ""}${replyTo ? ` reply-to="${replyTo}"` : ""}>\n${text}\n</joy-message>`;
      }
      const trimmed = text;
      const source = meta.via === "http" ? "web" as const : "rpc" as const;
      // Route through the verified dispatch queue (not sendText directly) so a
      // /send while Claude is busy is serialized behind the turn and only typed
      // into an empty, ready box — same robustness as relay app-sends. visible:
      // true — unlike a relay app-send, a /send has NO chat bubble until dispatch
      // mirrors it, so showing it as a queued chip is real "not sent yet" state,
      // not a duplicate. mirrorToRelay so it reaches the app's history on dispatch.
      //
      // requireDurable (#551): a locally accepted prompt has NO relay work item
      // to replay it — this ack is the only record it was ever sent. Without
      // the flag, a failed spool write kept the prompt in memory and the API
      // still said ok:true; a daemon crash then lost an acknowledged
      // instruction silently. Now persistence failure is a refusal: nothing is
      // recorded as accepted (no chat-log row either) and the caller retries.
      let queued: { id: string } | undefined;
      try {
        queued = session.enqueue(trimmed, { source, mirrorToRelay: true, visible: true, requireDurable: true });
      } catch (e) {
        return { error: "not_durable", detail: e instanceof Error ? e.message : String(e) };
      }
      const chat_id = registry.nextChatId();
      registry.addChatMessage({ role: "user", content: trimmed, source, chat_id, session_id: session.claudeSessionId });
      return { ok: true, chat_id, queued_id: queued?.id ?? null };
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "empty") return { status: 400, body: result };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error === "busy") return { status: 409, body: result };
      if (r.error === "mode_not_scriptable") return { status: 409, body: result };
      if (r.error === "not_durable") return { status: 503, body: result };
      return { status: 200, body: result };
    },
  },
  // ── Message queue ───────────────────────────────────────────────────────────
  // Messages line up while Claude is busy and stay editable until the daemon
  // dispatches one (see Session queue). All target a session by session_id.
  {
    name: "queueList",
    scope: "machine",
    rpcName: "joy-queue-list",
    summary: "List a session's dispatch queue",
    http: { method: "GET", path: "/sessions/:id/queue" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      return { ok: true, ...session.queueState() };
    },
    httpShape: (result) =>
      (result as { error?: string }).error ? { status: 404, body: result } : { status: 200, body: result },
  },
  {
    name: "queueAdd",
    scope: "machine",
    rpcName: "joy-queue-add",
    summary: "Append a message to the dispatch queue",
    http: { method: "POST", path: "/sessions/:id/queue" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) return { error: "empty" };
      // Same durable-ack contract as `send` (#551): no spool, no acceptance.
      let msg: { id: string };
      try {
        msg = session.enqueue(text, { requireDurable: true });
      } catch (e) {
        return { error: "not_durable", detail: e instanceof Error ? e.message : String(e), ...session.queueState() };
      }
      return { ok: true, id: msg.id, ...session.queueState() };
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "empty") return { status: 400, body: result };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error === "not_durable") return { status: 503, body: result };
      return { status: 200, body: result };
    },
  },
  {
    // NOTE: registered BEFORE queueEdit on purpose — the HTTP router matches
    // routes in registration order, and queueEdit's POST /sessions/:id/queue/:qid
    // would otherwise capture the static /queue/resume path as qid="resume"
    // (resume-over-HTTP returned queueEdit's {error:"empty"}; RPC was unaffected).
    name: "queueResume",
    scope: "machine",
    rpcName: "joy-queue-resume",
    summary: "Resume a paused queue",
    http: { method: "POST", path: "/sessions/:id/queue/resume" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      session.resumeQueue();
      return { ok: true, ...session.queueState() };
    },
  },
  {
    name: "queueEdit",
    scope: "machine",
    rpcName: "joy-queue-edit",
    summary: "Edit a queued message's text",
    http: { method: "POST", path: "/sessions/:id/queue/:qid" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (!text) return { error: "empty" };
      const ok = session.editQueued(String(params.qid ?? params.queue_id ?? ""), text);
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "queueCancel",
    scope: "machine",
    rpcName: "joy-queue-cancel",
    summary: "Cancel a queued message",
    http: { method: "DELETE", path: "/sessions/:id/queue/:qid" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const ok = session.cancelQueued(String(params.qid ?? params.queue_id ?? ""));
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "queueReorder",
    scope: "machine",
    rpcName: "joy-queue-reorder",
    summary: "Move a queued message within the queue",
    http: { method: "POST", path: "/sessions/:id/queue/:qid/move" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      const ok = session.reorderQueued(String(params.qid ?? params.queue_id ?? ""), Number(params.toIndex ?? params.to ?? 0));
      return { ok, ...session.queueState() };
    },
  },
  {
    name: "sendKeys",
    scope: "machine",
    rpcName: "joy-send-keys",
    summary: "Type raw key tokens into the tmux pane (manual intervention)",
    http: { method: "POST", path: "/sessions/:id/keys" },
    // Raw keyboard intervention: bracketed key tokens (git commit<Enter><C-c>;
    // see keyTokens.ts for the dialect table). Unlike send, nothing is
    // buffered, mirrored to the relay, or recorded — it's a direct wire to
    // the pane for trust prompts, TUI menus, or unsticking claude.
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const script = typeof params.script === "string" ? params.script : "";
      if (!script) return { error: "empty" };
      // literal: send the string verbatim (no bracketed-token parsing).
      return session.sendRawKeys(script, { literal: params.literal === true });
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error === "empty") return { status: 400, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "setMode",
    scope: "machine",
    rpcName: "joy-set-mode",
    summary: "Switch permission mode / model / effort",
    http: { method: "POST", path: "/sessions/:id/mode" },
    // Absolute permission-mode set: detects the current mode from the pane
    // footer, walks Shift+Tab to the target, verifies the footer afterwards.
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const mode = typeof params.mode === "string" ? params.mode : "";
      if (!mode) return { error: "mode required" };
      return session.setPermissionMode(mode);
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "pane",
    scope: "machine",
    rpcName: "joy-pane",
    summary: "Capture the tmux pane (ANSI text)",
    http: { method: "GET", path: "/sessions/:id/pane" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      // color=true → capture with ANSI escape sequences (HTTP: ?color=1).
      return session.pane(params.color === true || params.color === "1" || params.color === "true");
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "resize",
    scope: "machine",
    rpcName: "joy-resize",
    summary: "Resize the tmux window (cols/rows)",
    http: { method: "POST", path: "/sessions/:id/resize" },
    // Set the pane's column/row size. The viewing client calls this on
    // connect and when its width changes — last connector drives the width.
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const cols = Number(params.cols);
      const rows = Number(params.rows);
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return { error: "cols and rows required" };
      return session.resize(cols, rows);
    },
    httpShape: (result) => {
      const r = result as { error?: string };
      if (r.error === "session_not_found") return { status: 404, body: result };
      if (r.error) return { status: 400, body: result };
      return { status: 200, body: result };
    },
  },
  {
    name: "transcript",
    scope: "machine",
    rpcName: "joy-transcript",
    summary: "Parsed transcript slice for a session",
    http: { method: "GET", path: "/sessions/:id/transcript" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      return session.transcript();
    },
    httpShape: (result) =>
      (result as { error?: string }).error
        ? { status: 404, body: result }
        : { status: 200, body: result },
  },
  {
    name: "check",
    scope: "machine",
    rpcName: "joy-check",
    summary: "Can this session be talked to right now? idle | busy | needs_input, with what it is waiting on",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    result: { type: "object", properties: { state: { type: "string", enum: ["idle", "busy", "needs_input", "ended"] }, busySince: { type: "number" }, queue: { type: "number" }, approvals: { type: "array" }, question: { type: "string" } } },
    http: { method: "GET", path: "/sessions/:id/check" },
    handler: (registry, params) => checkSession(registry, String(params.id ?? params.session_id ?? "")),
    httpShape: (result) => (result as { error?: string }).error === "session_not_found" ? { status: 404, body: result } : { status: 200, body: result },
  },
  {
    name: "approvalsList",
    scope: "machine",
    rpcName: "joy-approvals",
    summary: "Tool-call approvals the harness is holding for a human (codex); empty for agents without the concept",
    params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    result: { type: "object", properties: { ok: { type: "boolean" }, approvals: { type: "array" } } },
    http: { method: "GET", path: "/sessions/:id/approvals" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      return { ok: true, approvals: session.listApprovals?.() ?? [] };
    },
    httpShape: (result) => (result as { error?: string }).error ? { status: 404, body: result } : { status: 200, body: result },
  },
  {
    name: "approvalsAnswer",
    scope: "machine",
    rpcName: "joy-approvals-answer",
    summary: "Answer a held approval: { requestId, decision: 'allow' | 'deny' }",
    params: { type: "object", required: ["id", "requestId", "decision"], properties: { id: { type: "string" }, requestId: { type: "string" }, decision: { type: "string", enum: ["allow", "deny"] } } },
    result: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } },
    http: { method: "POST", path: "/sessions/:id/approvals" },
    handler: (registry, params) => {
      const session = registry.get(String(params.id ?? params.session_id ?? ""));
      if (!session) return { error: "session_not_found" };
      if (!session.answerApproval) return { error: "approvals_unsupported" };
      return session.answerApproval({ requestId: params.requestId, decision: params.decision === "allow" });
    },
    httpShape: (result) => (result as { error?: string }).error ? { status: 400, body: result } : { status: 200, body: result },
  },
  {
    name: "envList",
    scope: "machine",
    rpcName: "joy-env-list",
    summary: "Names in the sealed environment store (~/.joy/env.sealed) — values never leave the daemon",
    result: { type: "object", properties: { ok: { type: "boolean" }, names: { type: "array", items: { type: "string" } }, error: { type: "string" } } },
    http: { method: "GET", path: "/env" },
    handler: () => listEnvVars(),
  },
  {
    name: "envSet",
    scope: "machine",
    rpcName: "joy-env-set",
    summary: "Set a variable in the sealed store; reaches every agent spawned from now on",
    params: { type: "object", required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } },
    result: { type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } },
    http: { method: "POST", path: "/env" },
    handler: (_registry, params) => {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (!isValidEnvName(name)) return { error: "bad_name" };
      if (typeof params.value !== "string") return { error: "bad_value" };
      return setEnvVar(name, params.value);
    },
    httpShape: (result) => (result as { error?: string }).error ? { status: 400, body: result } : { status: 200, body: result },
  },
  {
    name: "envUnset",
    scope: "machine",
    rpcName: "joy-env-unset",
    summary: "Remove a variable from the sealed store",
    params: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    result: { type: "object", properties: { ok: { type: "boolean" }, existed: { type: "boolean" }, error: { type: "string" } } },
    http: { method: "DELETE", path: "/env/:name" },
    handler: (_registry, params) => unsetEnvVar(String(params.name ?? "")),
    httpShape: (result) => (result as { error?: string }).error ? { status: 400, body: result } : { status: 200, body: result },
  },
  {
    name: "status",
    scope: "machine",
    rpcName: "joy-status",
    summary: "Daemon + sessions snapshot",
    http: { method: "GET", path: "/status" },
    handler: (registry) => ({
      ok: true,
      messages: registry.chatHistory().length,
      sessions: registry.size,
      clients: registry.sseClientCount,
      version: "joy-daemon/0.1.0",
      uptimeMs: Date.now() - registry.startedAt,
      claude: registry.claudeInfo(),
      pid: process.pid,
      os: { platform: platform(), release: release(), arch: arch(), hostname: hostname() },
    }),
  },
  {
    name: "sessionLog",
    scope: "machine",
    rpcName: "joy-session-log",
    summary: "Raw session log tail",
    http: { method: "GET", path: "/sessions/:id/log" },
    // Ship the session's transcript JSONL so the app can offer it as a
    // download. Base64 inside the encrypted RPC envelope — capped so a
    // monster transcript doesn't wedge the socket.
    handler: async (registry, params) => {
      const session = registry.get(String(params.id ?? ""));
      if (!session) return { error: "session_not_found" };
      const path = session.transcriptPath;
      if (!path || !existsSync(path)) return { error: "no transcript on disk yet" };
      const size = statSync(path).size;
      const MAX = 25 * 1024 * 1024;
      if (size > MAX) {
        return { error: `transcript is ${Math.round(size / 1048576)}MB (cap 25MB) — copy it from ${path}` };
      }
      const contentBase64 = (await readFile(path)).toString("base64");
      return { ok: true, filename: basename(path), size, contentBase64 };
    },
  },
  {
    name: "usage",
    scope: "machine",
    rpcName: "joy-usage",
    summary: "Cost/token report from local transcripts (cached, background-warmed)",
    params: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["today", "week", "30days", "90days", "6months", "all"], default: "30days" },
      },
    },
    http: { method: "GET", path: "/usage" },
    // Usage report computed by usage.ts straight from the transcript JSONL:
    // cost/tokens, daily, per-project/model/tool/MCP.
    // period: today | week | 30days (default) | 90days | 6months.
    handler: async (_registry, params) => {
      const period = typeof params.period === "string" ? params.period : "30days";
      const range = periodToRange(period);
      const { sessions: _sessions, ...data } = await computeUsage({ fromDay: range.fromDay, toDay: range.toDay });
      return { ok: true, period: range.label, ...data };
    },
  },
  {
    name: "limits",
    scope: "machine",
    rpcName: "joy-limits",
    summary: "Server-truth account quota windows for claude (OAuth usage API) and codex (rollout rate_limits)",
    result: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        claude: {
          type: "object",
          description: "ok:true with limits {five_hour, seven_day, …} of {utilization: 0-100, resets_at: ISO} — or ok:false with error",
        },
        codex: {
          type: "object",
          description: "ok:true with limits {primary, secondary} of {used_percent, window_minutes, resets_at|resets_in_seconds} — or ok:false with error",
        },
      },
    },
    http: { method: "GET", path: "/limits" },
    // Account quota windows, server truth (limits.ts): claude via the machine's
    // own OAuth token against api/oauth/usage; codex from the newest rollout's
    // token_count.rate_limits. Two independent best-effort halves — one agent
    // missing on the box shouldn't blank the other's numbers.
    handler: async () => {
      const [claude, codex] = await Promise.all([
        fetchClaudeLimits().catch((e) => ({ ok: false as const, error: String(e) })),
        Promise.resolve().then(() => readCodexLimits()).catch((e) => ({ ok: false as const, error: String(e) })),
      ]);
      return { ok: true, claude, codex };
    },
  },
  {
    name: "agentConfigRead",
    scope: "machine",
    rpcName: "joy-agent-config-read",
    summary: "Read an agent's config file (raw + parsed)",
    http: { method: "GET", path: "/agent-config/:agent" },
    // Raw + parsed view of the agent's own config file (claude settings.json,
    // codex config.toml, opencode opencode.json, pi settings.json).
    handler: async (_registry, params) => readAgentConfig(String(params.agent ?? "")),
  },
  {
    name: "agentConfigSet",
    scope: "machine",
    rpcName: "joy-agent-config-set",
    summary: "Merge JSON-path assignment lines into an agent's config (backup kept)",
    http: { method: "POST", path: "/agent-config/:agent/set" },
    // Merge JSON-path assignment lines (`examples[0].title = "hi"`; value null
    // deletes) into the existing config — other keys untouched, previous file
    // kept as <name>.joy-bak.
    handler: async (_registry, params) => {
      const lines = Array.isArray(params.lines) ? params.lines.map(String) : [];
      if (lines.length === 0) return { ok: false, error: "no assignment lines" };
      return applyAgentConfigAssignments(String(params.agent ?? ""), lines);
    },
  },
  {
    name: "agentConfigWrite",
    scope: "machine",
    rpcName: "joy-agent-config-write",
    summary: "Replace an agent's config file (must parse)",
    http: { method: "POST", path: "/agent-config/:agent" },
    // Full raw replacement — refused unless it parses as the file's format.
    handler: async (_registry, params) => writeAgentConfigRaw(String(params.agent ?? ""), String(params.raw ?? "")),
  },
  {
    name: "agentConfigSchema",
    scope: "machine",
    rpcName: "joy-agent-config-schema",
    summary: "Published JSON Schema for an agent's config (fetched + cached)",
    http: { method: "GET", path: "/agent-config/:agent/schema" },
    // Published JSON Schema (claude via schemastore, opencode via its own
    // $schema URL), fetched by the daemon and disk-cached for offline reuse.
    handler: async (_registry, params) => fetchAgentSchema(String(params.agent ?? "")),
  },
  {
    name: "sessionUsage",
    scope: "machine",
    rpcName: "joy-session-usage",
    summary: "Per-session cost rows (subagent burn rolled into parent)",
    http: { method: "GET", path: "/usage/sessions" },
    // Per-session cost rows from usage.ts (keyed by claude session id, with
    // subagent burn rolled into the parent and a per-model breakdown).
    // period like joy-usage plus "all"; claudeSessionId returns just that
    // conversation's row.
    handler: async (_registry, params) => {
      const period = typeof params.period === "string" ? params.period : "30days";
      const range = periodToRange(period);
      const { sessions } = await computeUsage({ fromDay: range.fromDay, toDay: range.toDay });
      const claudeSessionId = typeof params.claudeSessionId === "string" ? params.claudeSessionId : undefined;
      if (claudeSessionId) {
        return { ok: true, entry: sessions.find((s) => s.id === claudeSessionId) ?? null };
      }
      return { ok: true, sessions: sessions.slice(0, 20) };
    },
  },
  {
    name: "listLogs",
    scope: "machine",
    rpcName: "joy-list-logs",
    summary: "List past-session transcripts for a directory",
    http: { method: "GET", path: "/logs" },
    // List every Claude transcript JSONL for a project directory (one per
    // conversation Claude has had in that cwd), newest first. `directory` is the
    // absolute cwd; we map it to ~/.claude/projects/<encoded>/ ourselves. Just
    // stats (id + size + mtime) — no file reads, so it stays fast.
    handler: (_registry, params) => {
      const directory = String(params.directory ?? "");
      if (!directory) return { ok: false, error: "directory required", directory: "", logs: [] };
      const dir = cwdToTranscriptDir(directory);
      const logs: Array<{ sessionId: string; sizeBytes: number; mtimeMs: number }> = [];
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          try {
            const st = statSync(join(dir, f));
            logs.push({ sessionId: f.slice(0, -".jsonl".length), sizeBytes: st.size, mtimeMs: st.mtimeMs });
          } catch { /* vanished mid-scan */ }
        }
      } catch { /* no transcript dir for this cwd yet → empty */ }
      logs.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { ok: true, directory, logs };
    },
  },
  {
    name: "readLog",
    scope: "machine",
    rpcName: "joy-read-log",
    summary: "Read a past-session transcript's messages",
    http: { method: "GET", path: "/logs/messages" },
    // Last N back-and-forth messages (user + assistant) from one transcript, for
    // a quick preview without shipping the whole file (see joy-session-log for the
    // full download). `sessionId` is the bare .jsonl basename under the project's
    // transcript dir — validated against path traversal.
    handler: (_registry, params) => {
      const directory = String(params.directory ?? "");
      const sessionId = String(params.sessionId ?? "");
      const limit = Math.max(1, Math.min(100, Math.floor(Number(params.limit)) || 10));
      if (!directory || !sessionId) return { ok: false, error: "directory and sessionId required", messages: [] };
      if (sessionId.includes("/") || sessionId.includes("\\") || sessionId.includes("..")) {
        return { ok: false, error: "invalid sessionId", messages: [] };
      }
      const file = join(cwdToTranscriptDir(directory), `${sessionId}.jsonl`);
      if (!existsSync(file)) return { ok: false, error: "log not found", messages: [] };
      return { ok: true, sessionId, messages: readLastLogMessages(file, limit) };
    },
  },
];

// ── Session-scoped operations ───────────────────────────────────────────────
// Registered on each session's RelaySession under the bare rpcName (the relay
// prefixes them with the relay session id). HTTP paths nest under the session.

export const sessionOps: SessionOp[] = [
  {
    name: "abort",
    scope: "session",
    rpcName: "abort",
    summary: "Abort the running turn (Escape; does not clear the input box)",
    http: { method: "POST", path: "/sessions/:id/abort" },
    handler: (session) => session.abort(),
  },
  {
    // Generic Claude Code hook ingest (SessionStart/UserPromptSubmit/Stop/
    // Notification/PreCompact) — hit by the generated joy-hook.mjs forwarder
    // (hooks.ts). Best-effort on the sender side; unknown events return
    // ok:false.
    name: "hookEvent",
    scope: "session",
    rpcName: "joy-hook",
    summary: "Claude hook event ingress (PreCompact etc.)",
    http: { method: "POST", path: "/sessions/:id/hook" },
    handler: (session, params) => session.onHookEvent(params as Record<string, unknown>),
  },
  {
    // Hit by the LEGACY PreCompact hook script (precompact-hook.mjs): sessions
    // launched before the generic /hook forwarder snapshot their hook config
    // at claude startup and keep posting here until they restart. Keep until
    // the fleet has cycled. trigger = "manual" | "auto".
    name: "compacting",
    scope: "session",
    rpcName: "compacting",
    summary: "Mark the session as compacting (hook-driven)",
    http: { method: "POST", path: "/sessions/:id/compacting" },
    handler: (session, params) => {
      session.markCompacting(typeof params.trigger === "string" ? params.trigger : "auto");
      return { ok: true };
    },
  },
  {
    name: "killSession",
    scope: "session",
    rpcName: "killSession",
    summary: "Session-scope kill (RPC only; HTTP uses DELETE /sessions/:id)",
    http: null, // covered by DELETE /sessions/:id
    handler: async (session) => {
      // Idempotent: the op is bound to an existing session, so killing one
      // that already ended still reports success (matches the app's
      // archive flow, which treats success=false as "CLI unreachable" and
      // falls back to a server-side archive).
      if (session.status === "ended") session.forceKill(); else session.end("killed"); // detached needs forceKill (#43)
      // Await the (retrying) archive POST and report its real result: a genuine
      // failure now surfaces success:false so the app runs its fallback archive
      // instead of leaving the killed session in the active list.
      const archived = await session.awaitArchive();
      return archived
        ? { success: true, message: "killed" }
        : { success: false, error: "archive failed" };
    },
  },
  {
    name: "bash",
    scope: "session",
    rpcName: "bash",
    summary: "Run a shell command in the session cwd",
    http: { method: "POST", path: "/sessions/:id/bash" },
    handler: (session, params) => handleBash(session.cwd, params as unknown as Parameters<typeof handleBash>[1]),
  },
  {
    name: "readFile",
    scope: "session",
    rpcName: "readFile",
    summary: "Read a file (inline base64)",
    http: { method: "POST", path: "/sessions/:id/readFile" },
    // Second allowed root: the session's own ~/.joy/sessions/<id>/ so the app
    // can fetch joy-img media the agent saved there — scoped per session.
    handler: async (session, params) => {
      const p = params as unknown as Parameters<typeof handleReadFile>[1];
      // Remap a joy-media path that names the WRONG session id onto THIS
      // session's media dir (2026-07-13). The agent hand-constructs the
      // <joy-img src> absolute path and can put the wrong session id in it
      // (e.g. a claude conversation UUID instead of $JOY_SESSION_ID) while
      // saving the bytes to the correct dir — the image then 404s in the app.
      // The basename + media/ namespace are preserved and the result is still
      // jailed to this session's dir, so this can't reach another session.
      const m = typeof p?.path === "string" ? /[/\\]\.joy[/\\]sessions[/\\][^/\\]+[/\\]media[/\\](.+)$/.exec(p.path) : null;
      let effective = p;
      if (m) {
        const remapped = join(joySessionDir(session.id), "media", m[1]);
        if (remapped !== p.path && existsSync(remapped)) effective = { ...p, path: remapped };
      }
      // Always inline: both transports (local HTTP, v2 tunnel) carry the
      // response as one HTTP body with no per-message size cap.
      return handleReadFile(session.cwd, effective, readRoots([joySessionDir(session.id)]));
    },
  },
  {
    name: "writeFile",
    scope: "session",
    rpcName: "writeFile",
    summary: "Write a file in the session cwd",
    http: { method: "POST", path: "/sessions/:id/writeFile" },
    handler: (session, params) => handleWriteFile(session.cwd, params as unknown as Parameters<typeof handleWriteFile>[1]),
  },
  {
    name: "deleteFile",
    scope: "session",
    rpcName: "deleteFile",
    summary: "Delete a file in the session cwd",
    http: { method: "POST", path: "/sessions/:id/deleteFile" },
    handler: (session, params) => handleDeleteFile(session.cwd, params as unknown as Parameters<typeof handleDeleteFile>[1]),
  },
  {
    name: "listDirectory",
    scope: "session",
    rpcName: "listDirectory",
    summary: "List a directory",
    http: { method: "POST", path: "/sessions/:id/listDirectory" },
    handler: (session, params) => handleListDirectory(session.cwd, params as unknown as Parameters<typeof handleListDirectory>[1], readRoots()),
  },
  {
    name: "getDirectoryTree",
    scope: "session",
    rpcName: "getDirectoryTree",
    summary: "Directory tree for the file browser",
    http: { method: "POST", path: "/sessions/:id/getDirectoryTree" },
    handler: (session, params) => handleGetDirectoryTree(session.cwd, params as unknown as Parameters<typeof handleGetDirectoryTree>[1], readRoots()),
  },
  {
    name: "ripgrep",
    scope: "session",
    rpcName: "ripgrep",
    summary: "Search files with ripgrep",
    http: { method: "POST", path: "/sessions/:id/ripgrep" },
    handler: (session, params) => handleRipgrep(session.cwd, params as unknown as Parameters<typeof handleRipgrep>[1], readRoots()),
  },
  {
    name: "difftastic",
    scope: "session",
    rpcName: "difftastic",
    summary: "Structural diff via difftastic",
    http: { method: "POST", path: "/sessions/:id/difftastic" },
    handler: (session, params) => handleDifftastic(session.cwd, params as unknown as Parameters<typeof handleDifftastic>[1]),
  },
];
