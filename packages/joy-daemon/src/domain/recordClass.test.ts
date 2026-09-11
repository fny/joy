// classifyRecord, exhaustively over its fact space: every combination of
// (handle, record, windowAlive, agentAlive) that can occur has one class.
import { test, expect } from "vitest";
import { classifyRecord, isKilledHandle, isDetachedHandle, RECORD_CLASS_KINDS, type RecordFacts, type RecordClassKind } from "./recordClass";

const REC = { id: "abcd1234", launchCwd: "/w", socket: "joy-abcd1234", agent: "claude", claudeSessionId: "sid-1" } as RecordFacts["record"];
const NOSOCK = { id: "abcd1234", launchCwd: "/w", socket: null, agent: "claude" } as RecordFacts["record"];
const NOCWD = { id: "abcd1234", launchCwd: "", socket: "joy-abcd1234", agent: "claude" } as RecordFacts["record"];

const handles: Record<string, RecordFacts["handle"]> = {
  none: null,
  active: { status: "active" },
  starting: { status: "starting" },
  "ended(killed)": { status: "ended", endReason: "killed" },
  "ended(process_exited)": { status: "ended", endReason: "process_exited" },
  "ended(restart)": { status: "ended", endReason: "restart" },
};
const records: Record<string, RecordFacts["record"]> = { none: null, rec: REC, "rec(no socket)": NOSOCK, "rec(no cwd)": NOCWD };
const windows: Record<string, boolean | undefined> = { unprobed: undefined, gone: false, alive: true };
const agents: Record<string, boolean | undefined> = { unprobed: undefined, dead: false, alive: true };

/** The expected class for every row; a missing row fails. */
function expected(h: string, r: string, w: string, a: string): RecordClassKind {
  if (h === "active" || h === "starting") return "live";
  if (h === "ended(killed)") return "killed_retained";
  if (h === "ended(process_exited)") return "detached";
  // no handle, or ended(restart): the record decides
  if (r === "none") return w === "alive" ? "orphan_socket" : "unknown";
  if (w === "alive") return a === "alive" ? "live" : "detached";
  if (w === "unprobed") return r === "rec(no socket)" ? "files_only" : "unknown";
  if (r === "rec(no socket)") return "files_only";
  if (r === "rec(no cwd)") return "unknown";
  return "restorable";
}

test("every fact combination is classified", () => {
  const seen = new Set<RecordClassKind>();
  for (const [h, handle] of Object.entries(handles)) for (const [r, record] of Object.entries(records))
    for (const [w, windowAlive] of Object.entries(windows)) for (const [a, agentAlive] of Object.entries(agents)) {
      const got = classifyRecord({ handle, record, windowAlive, agentAlive });
      expect(got.kind, `${h} / ${r} / window ${w} / agent ${a}`).toBe(expected(h, r, w, a));
      seen.add(got.kind);
      if (got.kind === "restorable") expect(got.resumeId).toBe("sid-1");
    }
  expect(seen).toEqual(new Set(RECORD_CLASS_KINDS));
});

test("the handle predicates are the classifier", () => {
  expect(isKilledHandle({ status: "ended", endReason: "killed" })).toBe(true);
  expect(isKilledHandle({ status: "ended", endReason: "process_exited" })).toBe(false);
  expect(isKilledHandle({ status: "active" })).toBe(false);
  expect(isDetachedHandle({ status: "ended", endReason: "process_exited" })).toBe(true);
  expect(isDetachedHandle({ status: "ended", endReason: "killed" })).toBe(false);
});
