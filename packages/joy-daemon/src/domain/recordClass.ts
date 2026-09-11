// What a session record IS, decided in one place. Three callers used to
// each decide it from their own fields: registry.recover() from a window
// scan plus pid probes, restorable.ts from a record plus one `alive`
// probe, and the "killed but retained" handle predicate written out twice
// (registry.#isKilled, nucleusLane.isKilledHandle). Same question, three
// answers that had to agree. `classifyRecord` takes FACTS — a record, an
// in-memory handle, whether the tmux server/window is there, whether the
// agent process is — and never does I/O; the callers gather the facts and
// ask. Tabled exhaustively in recordClass.test.ts.
//
//   live             the agent is running here (a live handle, or a window
//                    whose agent process answers)
//   detached         the window/server is there but the agent has exited:
//                    its cwd still answers file/git RPCs (registry keeps it
//                    listed)
//   killed_retained  a handle the registry keeps after a kill — dedup and
//                    recovery bookkeeping only: not live, not listed, no
//                    card publisher of its own
//   files_only       a record with no per-session socket (predates
//                    per-session servers): cannot be probed one at a time,
//                    so it is left alone — relaunching a session that is
//                    actually running would put two agents in one folder
//   restorable       a record whose server is gone: what a reboot leaves
//                    behind (records are DELETED on kill/archive, so a
//                    record that still exists was not deliberately ended)
//   orphan_socket    a server with no record: the orphan sweep's business
//   unknown          nothing to go on
import type { WindowRecord } from "./windowRecord";
import { resumeIdOf } from "./restorable";

export interface HandleFacts { status: "starting" | "active" | "ended"; endReason?: string }

export interface RecordFacts {
  /** The window record on disk, if any. */
  record?: Pick<WindowRecord, "id" | "launchCwd" | "socket" | "agent" | "claudeSessionId" | "codexThreadId" | "opencodeSessionId" | "piSettings" | "agySettings"> | null;
  /** The registry's in-memory handle, if any. */
  handle?: HandleFacts | null;
  /** The tmux server/window for the session is there. */
  windowAlive?: boolean;
  /** The agent process in the pane answers (kill -0). */
  agentAlive?: boolean;
}

export type RecordClass =
  | { kind: "live" }
  | { kind: "detached" }
  | { kind: "killed_retained" }
  | { kind: "files_only" }
  | { kind: "restorable"; resumeId?: string }
  | { kind: "orphan_socket" }
  | { kind: "unknown" };
export type RecordClassKind = RecordClass["kind"];
export const RECORD_CLASS_KINDS: readonly RecordClassKind[] = ["live", "detached", "killed_retained", "files_only", "restorable", "orphan_socket", "unknown"];

export function classifyRecord(f: RecordFacts): RecordClass {
  // A handle is the freshest fact: the registry saw the session end, or is
  // running it now.
  if (f.handle) {
    if (f.handle.status === "active" || f.handle.status === "starting") return { kind: "live" };
    if (f.handle.endReason === "killed") return { kind: "killed_retained" };
    if (f.handle.endReason === "process_exited") return { kind: "detached" };
    // ended for another reason (restart, unknown): the record decides below
  }
  const rec = f.record;
  if (!rec || !rec.id) return f.windowAlive ? { kind: "orphan_socket" } : { kind: "unknown" };
  if (f.windowAlive) return f.agentAlive ? { kind: "live" } : { kind: "detached" };
  if (f.windowAlive === undefined) {
    // Not probed. A record without a socket cannot be; with one, we do not know.
    return rec.socket ? { kind: "unknown" } : { kind: "files_only" };
  }
  if (!rec.socket) return { kind: "files_only" };
  if (!rec.launchCwd) return { kind: "unknown" };
  return { kind: "restorable", resumeId: resumeIdOf(rec as WindowRecord) };
}

/** A handle the registry keeps after a kill: not live, not listed, no card
 *  publisher of its own. The one predicate, for both sites that need it. */
export const isKilledHandle = (h: HandleFacts): boolean => classifyRecord({ handle: h }).kind === "killed_retained";
/** A handle whose agent exited on its own; its window and cwd remain. */
export const isDetachedHandle = (h: HandleFacts): boolean => classifyRecord({ handle: h }).kind === "detached";
