// Local-only sessions: a session that never touches the relay. It is not
// announced (no relay row, no card), nothing it produces is uploaded, and no
// push names it. Its records go to the local event log instead
// (domain/localLog.ts), which clients read over the daemon's own API — the
// Joy Browser extension's Direct mode reaches that API over a peer-to-peer
// WebRTC channel, so the conversation never passes through the relay.
//
// The flag must be in place BEFORE the relay lane can see the session: the
// lane's sweep announces any live, unbound session every few seconds, and a
// session is in the registry while create() is still awaiting. So the create
// operation picks the id, marks it here, and only then creates the session;
// the window record carries the flag across daemon restarts.
import { loadWindowRecord } from "./windowRecord";

/** id → local-only. A session's answer never changes after creation, so it
 *  is read from disk once (the record sink asks for every record). */
const known = new Map<string, boolean>();

/** Mark a session id local-only, before the session exists. */
export function markLocalOnly(id: string): void { known.set(id, true); }

/** Is this session local-only? The mark covers the creation race; the window
 *  record covers a restarted daemon. */
export function isLocalOnly(id: string): boolean {
  const k = known.get(id);
  if (k !== undefined) return k;
  const v = loadWindowRecord(id)?.localOnly === true;
  known.set(id, v);
  return v;
}

/** Tests only. */
export function _resetLocalOnly(): void { known.clear(); }
