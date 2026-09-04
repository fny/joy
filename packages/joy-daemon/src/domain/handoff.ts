// Handoff — move the WORK of a session to a different model (any harness →
// any harness, same machine) via a note the source model writes itself, and
// hand it back the same way.
//
// Why a note and not the transcript: harnesses cannot read each other's
// history, and the only thing that knows what matters in a context is the
// model holding it (Claude's own /compact summary is exactly this). The
// daemon supplies the template and stamps a Reference block with the paths
// that are true (transcript, assets, prior notes); the model supplies the
// judgment. The source session is never destroyed — it goes idle — so
// handing BACK is just delivering the target's note into it as a prompt.
//
// Completion signal: the note FILE. The daemon asks the agent to write it to a
// path it chose, then polls for that file to exist with a stable size while
// the session is no longer busy. That works identically for every harness
// (no tag parsing to keep in sync); the <joy-handoff/> tag the prompt also
// asks for is only a courtesy for the chat.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

import type { AgentSession } from "./agentSession";
import { saveWindowRecord, listWindowRecords, type HandoffJob } from "./windowRecord";
import { joySessionDir } from "../paths";
import { findCodexRollout, findPiSessionFile } from "./forkHarness";

export type HandoffState = "writing" | "handed_off" | "picked_up" | "handed_back" | "returned" | "failed";

/** Card metadata (session.metadata.joy__handoff) the app renders as a bar. */
export interface JoyHandoffInfo {
  state: HandoffState;
  /** The other session's joy id. */
  peer?: string;
  peerLabel?: string;
  /** Absolute path of the handoff note (readable through the session's media root). */
  note?: string;
  error?: string;
  at: number;
}

export interface HandoffTarget { agent: "claude" | "codex" | "opencode" | "pi" | "agy"; model?: string; effort?: string; permissionMode?: string }

const HARNESS_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "pi", agy: "Antigravity" };

export function sessionLabel(s: AgentSession): string {
  const model = s.currentModel ?? s.model;
  return `${HARNESS_NAMES[s.agentFlavor] ?? s.agentFlavor}${model ? ` (${model})` : ""}`;
}

/** Where a session's full history lives on this machine, per harness. */
export function transcriptLocation(s: AgentSession): string | null {
  switch (s.agentFlavor) {
    case "claude": return s.transcriptPath ?? null;
    case "codex": { const t = (s as { codexThreadId?: string }).codexThreadId; return t ? findCodexRollout(t) : null; }
    case "pi": { const p = (s as { piSessionId?: string }).piSessionId; const hit = p ? findPiSessionFile(p) : null; return hit ? join(hit.dir, hit.file) : null; }
    case "agy": { const c = (s as { conversationId?: string }).conversationId; return c ? join(homedir(), ".gemini", "antigravity-cli", "conversations", `${c}.db`) : null; }
    default: return null;
  }
}

/** The block the DAEMON appends: authoritative paths, not remembered ones. */
export function referenceBlock(s: AgentSession): string {
  const dir = joySessionDir(s.id);
  let prior: string[] = [];
  try { prior = readdirSync(dir).filter((f) => /^handoff-.*\.md$/.test(f)).sort(); } catch { /* none */ }
  return [
    "",
    "## Reference (added by joy)",
    `- From: ${sessionLabel(s)} · joy session ${s.id} · machine ${hostname()} · ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
    `- Working directory: ${s.cwd}`,
    `- Full transcript: ${transcriptLocation(s) ?? "(not recorded yet)"}`,
    `- Session assets: ${join(dir, "media")}/`,
    prior.length ? `- Prior handoff notes: ${prior.map((f) => join(dir, f)).join(", ")}` : `- Prior handoff notes: none`,
    "",
  ].join("\n");
}

export function notePath(sessionId: string): string {
  const dir = joySessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
}

/** The prompt that asks a session to write its note. Same for hand-off and hand-back. */
export function noteRequestPrompt(path: string, direction: "to" | "back to", targetLabel: string): string {
  return [
    `Your work here is being handed ${direction} ${targetLabel}, which has none of your context. Write a handoff note so it can continue without you.`,
    "",
    `Write the note as a Markdown file at exactly this path: ${path}`,
    `(If you cannot write outside the working directory, write it to ./.joy/handoffs/${path.split("/").pop()} instead.)`,
    "Use these sections, in this order, and keep the whole note under ~2,500 words:",
    "",
    "## Goal",
    "What we are trying to accomplish, in the user's terms.",
    "## State",
    "What is DONE, what is IN PROGRESS (and exactly where you stopped), what is NOT started.",
    "## Files touched",
    "Paths, one per line, with a few words on what changed in each.",
    "## Decisions and constraints",
    "Choices already made and why; things the user said not to do; conventions to follow.",
    "## Open questions",
    "Anything unresolved, ambiguous, or that you'd have asked the user about.",
    "## Next steps",
    "The concrete ordered list of what to do next.",
    "## How to verify",
    "Exact commands (tests, typecheck, a curl) that prove the work is right.",
    "",
    "Write only what you actually know from this session — say \"unknown\" rather than guess. Do not include secrets.",
    `When the file is written, reply with a single line: <joy-handoff path="${path}"/>`,
  ].join("\n");
}

export function pickupPrompt(fromLabel: string, fromId: string, note: string): string {
  return [
    `You are picking up work from ${fromLabel} (joy session ${fromId}). Its handoff note is below.`,
    "Start by stating, in a few lines, what you understand the goal and the current state to be, and anything in the note you cannot verify — then continue the work.",
    "The note's Reference section says where its full transcript lives on this machine; read it only if the note leaves you unsure about something specific.",
    "",
    "---",
    note.trim(),
  ].join("\n");
}

export function handbackPrompt(fromLabel: string, fromId: string, note: string): string {
  return [
    `Picking back up: ${fromLabel} (joy session ${fromId}) worked on this while you were paused and has handed it back. Its note is below; it describes what changed since you stopped.`,
    "Read it, reconcile it with what you remember, state anything that conflicts, and continue.",
    "",
    "---",
    note.trim(),
  ].join("\n");
}

/** Poll for the note to land: file exists, size stable across two reads, and
 *  the session is no longer mid-turn. Resolves the note text or throws. */
export async function awaitNote(session: AgentSession, path: string, timeoutMs = 6 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // A sandboxed harness (codex safe-yolo/read-only) cannot write under ~/.joy;
  // the prompt offers ./.joy/handoffs/<name> inside the cwd as the fallback.
  const fallback = join(session.cwd, ".joy", "handoffs", path.split("/").pop() ?? "handoff.md");
  let lastSize = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    if (session.status === "ended") throw new Error("the session ended before the note was written");
    const where = existsSync(path) ? path : existsSync(fallback) ? fallback : null;
    if (!where) continue;
    const size = statSync(where).size;
    if (size > 0 && size === lastSize && !session.busy()) {
      const text = readFileSync(where, "utf8");
      if (text.trim().length > 0) return text;
    }
    lastSize = size;
  }
  throw new Error("the session did not write a handoff note within 6 minutes");
}

/** Final note on disk = the model's note + the daemon's Reference block. */
export function finalizeNote(path: string, body: string, source: AgentSession): string {
  const text = body.trimEnd() + "\n" + referenceBlock(source);
  writeFileSync(path, text);
  return text;
}


// ── Jobs: persisted so a daemon restart mid-note resumes the poll ──────────

/** Minimal registry surface the jobs need (avoids importing the class). */
export interface HandoffRegistry {
  get(id: string): AgentSession | undefined;
  list(): AgentSession[];
  create(opts: { cwd: string; agent?: HandoffTarget["agent"]; model?: string; effort?: string; permissionMode?: string; createDir?: boolean; forceNew?: boolean }): Promise<AgentSession>;
}

const HARNESS_LABEL: Record<string, string> = HARNESS_NAMES;

/** Source side: wait for the note, create the target, hand it the note. */
export async function runHandoffJob(registry: HandoffRegistry, src: AgentSession, target: HandoffTarget, path: string): Promise<void> {
  const targetLabel = `${HARNESS_LABEL[target.agent] ?? target.agent}${target.model ? ` (${target.model})` : ""}`;
  saveWindowRecord(src.id, { handoffJob: { role: "source", path, target, at: Date.now() } });
  try {
    const body = await awaitNote(src, path);
    const note = finalizeNote(path, body, src);
    const dst = await registry.create({ cwd: src.cwd, agent: target.agent, model: target.model, effort: target.effort, permissionMode: target.permissionMode, createDir: false, forceNew: true });
    dst.enqueue(pickupPrompt(sessionLabel(src), src.id, note), { source: "rpc", mirrorToRelay: true });
    dst.setHandoff?.({ state: "picked_up", peer: src.id, peerLabel: sessionLabel(src), note: path, at: Date.now() });
    src.setHandoff?.({ state: "handed_off", peer: dst.id, peerLabel: sessionLabel(dst), note: path, at: Date.now() });
    process.stderr.write(`[handoff] ${src.id} → ${dst.id} (${targetLabel}) note=${path}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[handoff] ${src.id} failed: ${msg}\n`);
    src.setHandoff?.({ state: "failed", error: msg, note: path, at: Date.now() });
  } finally {
    saveWindowRecord(src.id, { handoffJob: null });
  }
}

/** Target side: wait for the note, deliver it into the source as a prompt. */
export async function runHandbackJob(registry: HandoffRegistry, tgt: AgentSession, srcId: string, path: string): Promise<void> {
  saveWindowRecord(tgt.id, { handoffJob: { role: "target", path, peer: srcId, at: Date.now() } });
  try {
    const src = registry.get(srcId);
    if (!src || src.status === "ended") throw new Error(`the original session ${srcId} is gone; restart it and hand back again`);
    const body = await awaitNote(tgt, path);
    const note = finalizeNote(path, body, tgt);
    src.enqueue(handbackPrompt(sessionLabel(tgt), tgt.id, note), { source: "rpc", mirrorToRelay: true });
    src.setHandoff?.({ state: "handed_back", peer: tgt.id, peerLabel: sessionLabel(tgt), note: path, at: Date.now() });
    tgt.setHandoff?.({ state: "returned", peer: src.id, peerLabel: sessionLabel(src), note: path, at: Date.now() });
    process.stderr.write(`[handoff] ${tgt.id} → back to ${src.id} note=${path}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[handoff] handback ${tgt.id} failed: ${msg}\n`);
    tgt.setHandoff?.({ state: "failed", peer: srcId, error: msg, note: path, at: Date.now() });
  } finally {
    saveWindowRecord(tgt.id, { handoffJob: null });
  }
}

/** After recovery: pick up every job a previous daemon left mid-note. The
 *  note may already be on disk (awaitNote returns at once) or still coming. */
export function resumeHandoffJobs(registry: HandoffRegistry): void {
  for (const rec of listWindowRecords()) {
    const job = rec.handoffJob as HandoffJob | undefined;
    if (!job) continue;
    const s = registry.get(rec.id);
    if (!s || s.status === "ended") { saveWindowRecord(rec.id, { handoffJob: null }); continue; }
    process.stderr.write(`[handoff] resuming ${job.role} job for ${rec.id} (note ${job.path})\n`);
    if (job.role === "source" && job.target) void runHandoffJob(registry, s, job.target, job.path);
    else if (job.role === "target" && job.peer) void runHandbackJob(registry, s, job.peer, job.path);
    else saveWindowRecord(rec.id, { handoffJob: null });
  }
}
