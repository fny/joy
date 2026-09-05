// /v2/* — the machine-plane surface, mounted ADDITIVELY beside the v1
// catalog routes on the same localhost HTTP server. Nothing in v1 moves.
// The tunnel is endpoint-agnostic, so every route here is remotely reachable
// through the relay's /machines/{machineId}/http with ZERO relay changes.
//
// Adapters over the existing operation handlers wherever one exists; new
// logic only where v2 adds surface v1 never had: git status/entries/diff
// (porcelain parsed daemon-side), typed grep parameters (no raw argv from
// the caller), files/content as GET/PUT/DELETE verbs, harness descriptors
// and the normalized limits[] schema.
import type { IncomingMessage, ServerResponse } from "http";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { join, delimiter, dirname } from "path";
import { machineOps, sessionOps } from "../domain/operations";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";
import { validatePath } from "../domain/fileOps";
import { readAgentConfig, writeAgentConfigRaw, applyAgentConfigAssignments, fetchAgentSchema, agentConfigSpec } from "../domain/agentConfig";
import { fetchClaudeLimits, readCodexLimits, claudeLimitRows } from "../domain/limits";

const HARNESSES = ["claude", "codex", "opencode", "pi", "agy"] as const;
type Harness = (typeof HARNESSES)[number];

const mops = new Map(machineOps.map(o => [o.name, o]));
const sops = new Map(sessionOps.map(o => [o.name, o]));
const mcall = (name: string, registry: SessionRegistry, params: Record<string, unknown>) =>
  mops.get(name)!.handler(registry, params, { via: "http" });
const scall = (name: string, session: AgentSession, params: Record<string, unknown>) =>
  sops.get(name)!.handler(session, params);

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return true;
  }
  return false;
}

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile("git", args, { cwd, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? Number((err as { code?: unknown }).code) : err ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/** Parse `git status --porcelain=v2 --branch -z` (NUL-separated) into a
 *  typed shape. -z means paths arrive raw — no C-quoting to undo — and a
 *  rename's original path is the FOLLOWING record. Unmerged (`u`) records
 *  surface as conflicted entries; a conflict-only tree is NOT clean. */
export function parsePorcelainV2(out: string): {
  branch: string | null; oid: string | null; upstream: string | null;
  ahead: number; behind: number; clean: boolean;
  entries: Array<{ path: string; staged: string; unstaged: string; untracked?: boolean; conflicted?: boolean; renamedFrom?: string }>;
} {
  let branch: string | null = null, oid: string | null = null, upstream: string | null = null;
  let ahead = 0, behind = 0;
  const entries: Array<{ path: string; staged: string; unstaged: string; untracked?: boolean; conflicted?: boolean; renamedFrom?: string }> = [];
  const records = out.split("\0");
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice(14).trim() || null;
    else if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim() || null;
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18).trim() || null;
    else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith("1 ")) {
      // 1 XY sub mH mI mW hH hI path
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      entries.push({ path: parts.slice(8).join(" "), staged: xy[0] === "." ? "" : xy[0], unstaged: xy[1] === "." ? "" : xy[1] });
    } else if (line.startsWith("2 ")) {
      // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const orig = records[++i]; // -z: original path is the next record
      entries.push({ path: parts.slice(9).join(" "), staged: xy[0] === "." ? "" : xy[0], unstaged: xy[1] === "." ? "" : xy[1], renamedFrom: orig });
    } else if (line.startsWith("u ")) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      entries.push({ path: parts.slice(10).join(" "), staged: xy[0] === "." ? "" : xy[0], unstaged: xy[1] === "." ? "" : xy[1], conflicted: true });
    } else if (line.startsWith("? ")) {
      entries.push({ path: line.slice(2), staged: "", unstaged: "", untracked: true });
    }
  }
  return { branch, oid, upstream, ahead, behind, clean: entries.length === 0, entries };
}

type BodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string };
function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const MAX_BODY = 10 * 1024 * 1024;
  return new Promise(resolve => {
    let data = "";
    let overflow = false;
    req.on("data", chunk => {
      if (overflow) return;
      data += chunk;
      if (data.length > MAX_BODY) { overflow = true; data = ""; req.destroy(); resolve({ ok: false, status: 413, error: "body_too_large" }); }
    });
    req.on("end", () => {
      if (overflow) return;
      if (data === "") return resolve({ ok: true, body: {} });
      try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return resolve({ ok: true, body: parsed as Record<string, unknown> });
        resolve({ ok: false, status: 400, error: "bad_json" });
      } catch { resolve({ ok: false, status: 400, error: "bad_json" }); }
    });
    req.on("error", () => resolve({ ok: false, status: 400, error: "bad_body" }));
  });
}

/** A caller-supplied file path for grep/diff positional args: resolved and
 *  jailed to the session cwd (validatePath), returned RELATIVE-safe. */
function jailed(session: AgentSession, p: string): { ok: true; path: string } | { ok: false; error: string } {
  const v = validatePath(p, session.cwd);
  if (!v.valid || !v.resolvedPath) return { ok: false, error: v.error ?? "invalid path" };
  return { ok: true, path: v.resolvedPath };
}

interface Ctx {
  registry: SessionRegistry;
  method: string;
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  corsHeaders: Record<string, string>;
}

type Handler = (ctx: Ctx, params: Record<string, string>, body: Record<string, unknown>) =>
  Promise<{ status: number; body: unknown } | null> | { status: number; body: unknown } | null;

interface Route { method: string; regex: RegExp; names: string[]; handler: Handler; sse?: boolean }

const routes: Route[] = [];
function route(method: string, pattern: string, handler: Handler, opts: { sse?: boolean } = {}) {
  const names: string[] = [];
  const rx = pattern.split("/").map(seg => {
    if (seg.startsWith(":")) { names.push(seg.slice(1)); return "([^/]+)"; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("/");
  routes.push({ method, regex: new RegExp(`^${rx}$`), names, handler, ...opts });
}

const ok = (body: unknown, status = 200) => ({ status, body });
const notFoundSession = () => ok({ error: "session_not_found" }, 404);
const unknownHarness = () => ok({ error: "unknown_harness" }, 422);

function withSession(fn: (ctx: Ctx, session: AgentSession, params: Record<string, string>, body: Record<string, unknown>) => ReturnType<Handler>): Handler {
  return (ctx, params, body) => {
    const session = ctx.registry.get(params.id ?? "");
    if (!session) return notFoundSession();
    return fn(ctx, session, params, body);
  };
}

// ── machine: status / usage / restart ───────────────────────────────────────
route("GET", "/v2/status", async (ctx) => ok(await mcall("status", ctx.registry, {})));
route("POST", "/v2/daemon/restart", async (ctx) => ok(await mcall("restartDaemon", ctx.registry, {})));
route("GET", "/v2/usage", async (ctx) => {
  const harness = ctx.url.searchParams.get("harness");
  if (harness && harness !== "claude") {
    // Usage is computed from claude transcripts today; an explicit filter for
    // a harness we cannot answer must fail loudly, never silently zero.
    return ok({ error: "unsupported_filter", detail: "usage covers harness=claude only" }, 422);
  }
  const result = await mcall("usage", ctx.registry, { period: ctx.url.searchParams.get("period") ?? "30days" }) as Record<string, unknown>;
  const model = ctx.url.searchParams.get("model");
  if (model && Array.isArray(result.models)) {
    result.models = (result.models as Array<{ name: string }>).filter(m => m.name === model);
  }
  return ok(result);
});

// ── machine: harnesses ──────────────────────────────────────────────────────
function harnessDescriptor(h: Harness) {
  return { id: h, available: onPath(h), config: agentConfigSpec(h) !== null };
}
route("GET", "/v2/harnesses", () => ok({ harnesses: HARNESSES.map(harnessDescriptor) }));
route("GET", "/v2/harnesses/:harness", (_ctx, p) => {
  if (!HARNESSES.includes(p.harness as Harness)) return unknownHarness();
  return ok(harnessDescriptor(p.harness as Harness));
});
route("GET", "/v2/harnesses/:harness/models", async (ctx, p) => {
  switch (p.harness) {
    case "codex": return ok(await mcall("codexModels", ctx.registry, {}));
    case "opencode": return ok(await mcall("opencodeModels", ctx.registry, {}));
    case "agy": return ok(await mcall("agyModels", ctx.registry, {}));
    case "claude":
    case "pi":
      // No machine-side catalog for these: the CLI owns model choice.
      return ok({ ok: true, models: [] });
    default: return unknownHarness();
  }
});
route("GET", "/v2/harnesses/:harness/config", (_ctx, p) => {
  if (!HARNESSES.includes(p.harness as Harness)) return unknownHarness();
  return ok(readAgentConfig(p.harness));
});
route("PATCH", "/v2/harnesses/:harness/config", (_ctx, p, body) => {
  if (!HARNESSES.includes(p.harness as Harness)) return unknownHarness();
  const lines = Array.isArray(body.edits) ? body.edits.map(String) : [];
  if (lines.length === 0) return ok({ ok: false, error: "edits[] required (JSON-path assignment lines)" }, 400);
  return ok(applyAgentConfigAssignments(p.harness, lines));
});
route("PUT", "/v2/harnesses/:harness/config", (_ctx, p, body) => {
  if (!HARNESSES.includes(p.harness as Harness)) return unknownHarness();
  if (typeof body.raw !== "string") return ok({ ok: false, error: "raw required" }, 400);
  return ok(writeAgentConfigRaw(p.harness, body.raw));
});
route("GET", "/v2/harnesses/:harness/config/schema", async (_ctx, p) => {
  if (!HARNESSES.includes(p.harness as Harness)) return unknownHarness();
  return ok(await fetchAgentSchema(p.harness));
});
route("GET", "/v2/harnesses/:harness/limits", async (_ctx, p) => {
  const observedAt = Date.now();
  if (p.harness === "claude") {
    const r = await fetchClaudeLimits().catch(e => ({ ok: false as const, error: String(e) }));
    if (!r.ok) return ok({ ok: true, harness: "claude", limits: [], status: { state: "unknown" }, error: { code: "read_failed", message: r.error }, observedAt });
    const limits = claudeLimitRows(r.limits);
    return ok({ ok: true, harness: "claude", limits, status: { state: "ok" }, source: "oauth-usage-api", observedAt, stale: false, raw: r.limits });
  }
  if (p.harness === "codex") {
    const r = ((): { ok: true; limits: object } | { ok: false; error: string } => {
      try { return readCodexLimits(); } catch (e) { return { ok: false, error: String(e) }; }
    })();
    if (!r.ok) return ok({ ok: true, harness: "codex", limits: [], status: { state: "unknown" }, error: { code: "read_failed", message: r.error }, observedAt });
    const limits = Object.entries(r.limits as Record<string, { used_percent?: number; window_minutes?: number; resets_at?: string; resets_in_seconds?: number } | undefined>)
      .filter((e): e is [string, { used_percent?: number; window_minutes?: number; resets_at?: string; resets_in_seconds?: number }] =>
        !!e[1] && typeof e[1] === "object" && typeof e[1].used_percent === "number")
      .map(([id, w]) => ({
        id, kind: "window" as const, usedPercent: w.used_percent ?? 0,
        windowMinutes: w.window_minutes,
        resetsAt: w.resets_at ?? (typeof w.resets_in_seconds === "number" ? new Date(observedAt + w.resets_in_seconds * 1000).toISOString() : null),
        unit: "percent",
      }));
    return ok({ ok: true, harness: "codex", limits, status: { state: "ok" }, source: "rollout-rate-limits", observedAt, stale: false, raw: r.limits });
  }
  if (HARNESSES.includes(p.harness as Harness)) {
    return ok({ ok: true, harness: p.harness, limits: [], status: { state: "unknown" }, error: { code: "unsupported", message: `${p.harness} exposes no quota surface` }, observedAt });
  }
  return unknownHarness();
});

// ── machine: history (on-disk transcripts) ─────────────────────────────────
// Past opencode conversations for a directory (the resume picker).
route("GET", "/v2/harnesses/opencode/sessions", async (ctx) =>
  ok(await mcall("opencodeSessions", ctx.registry, { cwd: ctx.url.searchParams.get("cwd") ?? "" })));
route("GET", "/v2/history", async (ctx) =>
  ok(await mcall("listLogs", ctx.registry, { directory: ctx.url.searchParams.get("directory") ?? "" })));
route("GET", "/v2/history/:sessionId/messages", async (ctx, p) =>
  ok(await mcall("readLog", ctx.registry, {
    directory: ctx.url.searchParams.get("directory") ?? "",
    sessionId: p.sessionId,
    limit: ctx.url.searchParams.get("limit") ?? undefined,
  })));

// ── machine: slash commands ─────────────────────────────────────────────────
route("GET", "/v2/slash-commands", (ctx) => {
  if (ctx.url.searchParams.get("refresh") === "1") return ok(ctx.registry.commands.refresh());
  return ok({ slashCommands: ctx.registry.commands.union() });
});

// ── sessions ────────────────────────────────────────────────────────────────
route("GET", "/v2/sessions", async (ctx) => ok({ sessions: await mcall("list", ctx.registry, {}) }));
route("POST", "/v2/sessions", async (ctx, _p, body) => ok(await mcall("create", ctx.registry, body)));
route("DELETE", "/v2/sessions", async (ctx) => ok(await mcall("killAll", ctx.registry, {})));
route("GET", "/v2/sessions/:id", withSession((_ctx, session) => ok(session.toJSON())));
route("DELETE", "/v2/sessions/:id", withSession(async (ctx, _s, p) => ok(await mcall("kill", ctx.registry, { id: p.id }))));
route("POST", "/v2/sessions/:id/restart", async (ctx, p, body) =>
  ok(await mcall("restart", ctx.registry, { id: p.id, ...body })));
route("POST", "/v2/sessions/:id/fork", async (ctx, p) => ok(await mcall("fork", ctx.registry, { id: p.id })));
route("POST", "/v2/sessions/:id/handoff", async (ctx, p, body) => ok(await mcall("handoff", ctx.registry, { id: p.id, ...body })));
route("POST", "/v2/sessions/:id/handback", async (ctx, p) => ok(await mcall("handback", ctx.registry, { id: p.id })));
route("POST", "/v2/sessions/:id/teleport-export", async (ctx, p) => ok(await mcall("teleportExport", ctx.registry, { id: p.id })));
route("POST", "/v2/teleport-import", async (ctx, _p, body) => ok(await mcall("teleportImport", ctx.registry, body)));
route("PATCH", "/v2/sessions/:id", withSession(async (ctx, session, p, body) => {
  // Desired-config update: each provided field applies independently.
  const applied: Record<string, unknown> = {};
  if (typeof body.permissionMode === "string") {
    applied.permissionMode = await mcall("setMode", ctx.registry, { id: p.id, mode: body.permissionMode });
  }
  if (typeof body.model === "string") {
    if (session.agentFlavor !== "opencode") return ok({ error: "model_switch_unsupported", harness: session.agentFlavor }, 422);
    applied.model = await mcall("opencodeSetModel", ctx.registry, { id: p.id, model: body.model });
  }
  if (Object.keys(applied).length === 0) return ok({ error: "no_supported_fields" }, 400);
  return ok({ ok: true, applied });
}));
route("GET", "/v2/sessions/:id/slash-commands", withSession((ctx, session) => {
  if (ctx.url.searchParams.get("refresh") === "1") ctx.registry.commands.refresh();
  return ok({ slashCommands: ctx.registry.commands.forProject(session.cwd, session.agentFlavor) });
}));
// ── session queue (the daemon-local dispatch queue) ─────────────────────────
// The editable line of messages waiting for the agent. Distinct from the
// relay's durable turn queue: this one lives on the machine, next to the
// agent, and the app reaches it over the sealed tunnel.
route("GET", "/v2/sessions/:id/queue", withSession(async (ctx, _s, p) =>
  ok(await mcall("queueList", ctx.registry, { id: p.id }))));
route("POST", "/v2/sessions/:id/queue", withSession(async (ctx, _s, p, body) =>
  ok(await mcall("queueAdd", ctx.registry, { id: p.id, ...(body as Record<string, unknown>) }))));
route("PATCH", "/v2/sessions/:id/queue/:qid", withSession(async (ctx, _s, p, body) =>
  ok(await mcall("queueEdit", ctx.registry, { id: p.id, qid: p.qid, ...(body as Record<string, unknown>) }))));
route("DELETE", "/v2/sessions/:id/queue/:qid", withSession(async (ctx, _s, p) =>
  ok(await mcall("queueCancel", ctx.registry, { id: p.id, qid: p.qid }))));
route("POST", "/v2/sessions/:id/queue/:qid/move", withSession(async (ctx, _s, p, body) =>
  ok(await mcall("queueReorder", ctx.registry, { id: p.id, qid: p.qid, ...(body as Record<string, unknown>) }))));
route("POST", "/v2/sessions/:id/queue/resume", withSession(async (ctx, _s, p) =>
  ok(await mcall("queueResume", ctx.registry, { id: p.id }))));

// ── environment store (sealed provider keys; names only leave the daemon) ──
route("GET", "/v2/env", async (ctx) => ok(await mcall("envList", ctx.registry, {})));
route("POST", "/v2/env", async (ctx, _p, body) => ok(await mcall("envSet", ctx.registry, body)));
route("DELETE", "/v2/env/:name", async (ctx, p) => ok(await mcall("envUnset", ctx.registry, { name: p.name })));

// ── talk-ability + held approvals (joy check / joy approvals) ──────────────
route("GET", "/v2/sessions/:id/check", async (ctx, p) => ok(await mcall("check", ctx.registry, { id: p.id })));
route("GET", "/v2/sessions/:id/approvals", async (ctx, p) => ok(await mcall("approvalsList", ctx.registry, { id: p.id })));

// ── approvals (codex holds tool calls for a human decision) ─────────────────
route("POST", "/v2/sessions/:id/approvals", withSession(async (_ctx, session, _p, body) => {
  const answer = (session as { answerApproval?: (p: Record<string, unknown>) => { ok: boolean } }).answerApproval;
  if (!answer) return ok({ error: "approvals_unsupported" }, 400);
  return ok(answer.call(session, body as Record<string, unknown>));
}));

route("POST", "/v2/sessions/:id/hooks", withSession(async (_ctx, session, _p, body) =>
  ok(await scall("hookEvent", session, body))));

// This session's cost row. Session-scoped so the client never has to fetch the
// session record first just to learn its claude session id (the v1 usage screen
// made that extra round-trip). A session that hasn't bound a claude id yet has
// no usage to report — `entry: null`, not an error.
// The daemon's own event log for one session (spawn/dispatch/lifecycle
// breadcrumbs — the debugging view in session info).
route("GET", "/v2/sessions/:id/log", withSession(async (ctx, _s, p) =>
  ok(await mcall("sessionLog", ctx.registry, { id: p.id }))));
route("GET", "/v2/sessions/:id/usage", withSession(async (ctx, session) => {
  const claudeSessionId = session.claudeSessionId;
  if (!claudeSessionId) return ok({ ok: true, entry: null });
  return ok(await mcall("sessionUsage", ctx.registry, {
    period: ctx.url.searchParams.get("period") ?? "all",
    claudeSessionId,
  }));
}));

// ── session events (SSE, filtered to this session) ─────────────────────────
route("GET", "/v2/sessions/:id/events", withSession((ctx, session, p) => {
  ctx.res.writeHead(200, {
    ...ctx.corsHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  ctx.res.write(`event: session\ndata: ${JSON.stringify(session.toJSON())}\n\n`);
  const forward = (frame: string) => {
    // Forward only frames whose payload names THIS session.
    const m = /\ndata: (.+)\n/.exec(frame);
    if (!m) return;
    try {
      const d = JSON.parse(m[1]) as Record<string, unknown>;
      // Chat rows carry session_id — the local id for codex/opencode/pi, the
      // Claude transcript uuid for claude; `id` on those is the row number,
      // which never matched and dropped every message (#76).
      if (typeof d.session_id === "string") {
        // Resolve the live object each time: an in-place restart replaces it
        // (and its transcript uuid) while this stream stays open.
        const cur = ctx.registry.get(p.id) ?? session;
        if (d.session_id === p.id || (!!cur.claudeSessionId && d.session_id === cur.claudeSessionId)) ctx.res.write(frame);
        return;
      }
      const sid = d.id ?? d.sessionId ?? (d.session as Record<string, unknown> | undefined)?.id;
      if (sid === p.id) ctx.res.write(frame);
    } catch { /* non-JSON frame — drop */ }
  };
  const unsubscribe = ctx.registry.subscribeSse(forward);
  ctx.res.on("close", unsubscribe);
  return null; // handler owns the response
}), { sse: true });

// ── session files ───────────────────────────────────────────────────────────
route("GET", "/v2/sessions/:id/files/content", withSession(async (ctx, session) => {
  const path = ctx.url.searchParams.get("path") ?? "";
  if (!path) return ok({ success: false, error: "path required" }, 400);
  return ok(await scall("readFile", session, { path }));
}));
route("PUT", "/v2/sessions/:id/files/content", withSession(async (_ctx, session, _p, body) => {
  // REST PUT = create-or-replace (v1 writeFile is a base64 CAS op with
  // must-be-new semantics — wrong verb contract for this route). Optional
  // expectedHash still guards concurrent edits; parent dirs are created.
  if (typeof body.path !== "string" || typeof body.content !== "string") {
    return ok({ success: false, error: "path and content required" }, 400);
  }
  const v = validatePath(body.path, session.cwd);
  if (!v.valid || !v.resolvedPath) return ok({ success: false, error: v.error ?? "invalid path" }, 400);
  const buf = Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8");
  try {
    if (typeof body.expectedHash === "string") {
      const existing = await fs.readFile(v.resolvedPath).catch(() => null);
      if (!existing) return ok({ success: false, error: "expectedHash given but file does not exist" }, 409);
      const h = createHash("sha256").update(existing).digest("hex");
      if (h !== body.expectedHash) return ok({ success: false, error: "hash_mismatch", actual: h }, 409);
    }
    await fs.mkdir(dirname(v.resolvedPath), { recursive: true });
    await fs.writeFile(v.resolvedPath, buf);
    return ok({ success: true, hash: createHash("sha256").update(buf).digest("hex"), size: buf.length });
  } catch (e) {
    return ok({ success: false, error: String(e) }, 500);
  }
}));
route("DELETE", "/v2/sessions/:id/files/content", withSession(async (ctx, session) => {
  const path = ctx.url.searchParams.get("path") ?? "";
  if (!path) return ok({ success: false, error: "path required" }, 400);
  return ok(await scall("deleteFile", session, { path }));
}));
route("GET", "/v2/sessions/:id/files/entries", withSession(async (ctx, session) => {
  const path = ctx.url.searchParams.get("path") ?? ".";
  const depth = Number(ctx.url.searchParams.get("depth") ?? 1);
  if (Number.isFinite(depth) && depth > 1) {
    return ok(await scall("getDirectoryTree", session, { path, maxDepth: Math.min(depth, 10) }));
  }
  return ok(await scall("listDirectory", session, { path }));
}));
route("GET", "/v2/sessions/:id/files/grep", withSession(async (ctx, session) => {
  // Typed grep: the caller supplies WHAT to search, never raw argv.
  const q = ctx.url.searchParams.get("q") ?? "";
  if (!q) return ok({ success: false, error: "q required" }, 400);
  const args = ["--line-number", "--with-filename", "--no-heading"];
  if (ctx.url.searchParams.get("caseSensitive") !== "1") args.push("-i");
  const glob = ctx.url.searchParams.get("glob");
  if (glob) args.push("-g", glob);
  const maxResults = Number(ctx.url.searchParams.get("maxResults") ?? 0);
  if (Number.isFinite(maxResults) && maxResults > 0) args.push("-m", String(Math.min(maxResults, 1000)));
  args.push("-e", q);
  const p = ctx.url.searchParams.get("path");
  if (p) {
    const j = jailed(session, p);
    if (!j.ok) return ok({ success: false, error: j.error }, 400);
    args.push(j.path);
  } else {
    // A positional path is MANDATORY: with none, rg waits on stdin forever.
    args.push("./");
  }
  return ok(await scall("ripgrep", session, { args }));
}));
route("GET", "/v2/sessions/:id/files/diff", withSession(async (ctx, session) => {
  const a = ctx.url.searchParams.get("a") ?? "";
  const b = ctx.url.searchParams.get("b") ?? "";
  if (!a || !b) return ok({ success: false, error: "a and b required" }, 400);
  const ja = jailed(session, a); const jb = jailed(session, b);
  if (!ja.ok) return ok({ success: false, error: ja.error }, 400);
  if (!jb.ok) return ok({ success: false, error: jb.error }, 400);
  const context = ctx.url.searchParams.get("context");
  const args = [...(context ? ["--context", String(Number(context) || 3)] : []), ja.path, jb.path];
  return ok(await scall("difftastic", session, { args }));
}));

// ── session git (NEW: porcelain parsed daemon-side) ─────────────────────────
route("GET", "/v2/sessions/:id/git/status", withSession(async (_ctx, session) => {
  // "--" "." scopes to the session cwd even when it is a subdirectory of a
  // larger repository (git otherwise reports the whole worktree).
  const r = await git(session.cwd, ["status", "--porcelain=v2", "--branch", "-z", "--", "."]);
  if (r.code !== 0) return ok({ ok: false, error: r.stderr.trim() || "git failed" });
  return ok({ ok: true, ...parsePorcelainV2(r.stdout) });
}));
route("GET", "/v2/sessions/:id/git/entries", withSession(async (ctx, session) => {
  // untracked=1: tracked + untracked-but-not-ignored — what an "All files"
  // tab wants (the app used to shell out for this; #5).
  const args = ctx.url.searchParams.get("untracked") === "1" ? ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"] : ["ls-files"];
  const p = ctx.url.searchParams.get("path");
  if (p) {
    const j = jailed(session, p);
    if (!j.ok) return ok({ ok: false, error: j.error }, 400);
    args.push("--", j.path);
  }
  const r = await git(session.cwd, args);
  if (r.code !== 0) return ok({ ok: false, error: r.stderr.trim() || "git failed" });
  return ok({ ok: true, files: r.stdout.split("\n").filter(Boolean) });
}));
// Interrupt the running turn whatever started it (terminal, peer message,
// daemon-dispatched queue item): the app's Stop used to cancel only relay
// turns and silently did nothing otherwise (#8).
route("POST", "/v2/sessions/:id/abort", withSession(async (_ctx, session) => ok(await session.abort())));
route("GET", "/v2/sessions/:id/git/diff", withSession(async (ctx, session) => {
  const args = ["-c", "core.quotepath=false", "diff", "--no-ext-diff"];
  if (ctx.url.searchParams.get("staged") === "1") args.push("--cached");
  // head=1: working tree vs HEAD (staged + unstaged in one patch) — the
  // all-files diff overlay's view (#5).
  else if (ctx.url.searchParams.get("head") === "1") args.push("HEAD");
  // numstat=1 returns per-file added/removed counts instead of the patch text —
  // what the file-list UI needs, without shipping whole diffs to render a "+3 −1".
  if (ctx.url.searchParams.get("numstat") === "1") args.push("--numstat");
  const p = ctx.url.searchParams.get("path");
  if (p) {
    const j = jailed(session, p);
    if (!j.ok) return ok({ ok: false, error: j.error }, 400);
    args.push("--", j.path);
  } else {
    args.push("--", "."); // scope to the session cwd, not the whole worktree
  }
  const r = await git(session.cwd, args);
  if (r.code !== 0) return ok({ ok: false, error: r.stderr.trim() || "git failed" });
  return ok({ ok: true, diff: r.stdout });
}));

// ── session terminal ────────────────────────────────────────────────────────
route("GET", "/v2/sessions/:id/terminal", withSession(async (ctx, _s, p) =>
  ok(await mcall("pane", ctx.registry, { id: p.id, color: ctx.url.searchParams.get("color") ?? undefined }))));
route("PATCH", "/v2/sessions/:id/terminal", withSession(async (ctx, _s, p, body) => {
  const r = await mcall("resize", ctx.registry, { id: p.id, ...body }) as { error?: string };
  return ok(r, r.error ? 400 : 200);
}));
route("POST", "/v2/sessions/:id/terminal/keys", withSession(async (ctx, _s, p, body) => {
  const r = await mcall("sendKeys", ctx.registry, { id: p.id, ...body }) as { error?: string };
  return ok(r, r.error === "empty" ? 400 : 200);
}));

/** Dispatch a /v2/* request. Returns true when handled. */
export async function handleV2(ctx: Ctx): Promise<boolean> {
  if (!(ctx.url.pathname === "/v2" || ctx.url.pathname.startsWith("/v2/"))) return false;
  const json = (data: unknown, status = 200) => {
    ctx.res.writeHead(status, { ...ctx.corsHeaders, "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify(data));
  };
  for (const r of routes) {
    if (r.method !== ctx.method) continue;
    const m = ctx.url.pathname.match(r.regex);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    let body: Record<string, unknown> = {};
    if (ctx.method === "POST" || ctx.method === "PUT" || ctx.method === "PATCH") {
      const parsed = await readJsonBody(ctx.req);
      if (!parsed.ok) { json({ error: parsed.error }, parsed.status); return true; }
      body = parsed.body;
    }
    try {
      const out = await r.handler(ctx, params, body);
      if (out === null) return true; // SSE — handler owns the response
      json(out.body, out.status);
    } catch (e) {
      if (e instanceof DirectoryCreationApprovalRequired) {
        json({ error: "dir_not_found", cwd: e.directory }, 422);
      } else {
        json({ error: String(e) }, 500);
      }
    }
    return true;
  }
  json({ error: "not_found" }, 404);
  return true;
}
