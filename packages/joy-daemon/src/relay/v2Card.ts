// v2 session-card publishing: the bridge between the ONE metadata write path
// (RelaySession.doMergeMetadata — every agent flavor funnels through it) and
// the nucleus lane, which holds the v2 session identity, content key and
// lease needed to PATCH the relay's card.
//
// A tiny registry rather than imports in either direction: relay.ts must not
// depend on nucleusLane, and the lane must not reach into RelaySession
// internals. The lane registers a publisher per bound session; the metadata
// path fires it with the freshly merged card.
//
// Publishing is best-effort by design: the card is a rendering of state the
// daemon already holds durably (window records + session metadata), so a lost
// PATCH costs staleness until the next merge, never correctness. The publish
// promise is still surfaced so a caller that WANTS certainty (archive on
// kill — the app must not keep showing a dead session) can await the PATCH.

export type CardPublisher = (metadata: Record<string, unknown>) => Promise<void> | void;

const publishers = new Map<string, CardPublisher>();

export function registerV2CardPublisher(localSessionId: string, fn: CardPublisher): void {
  publishers.set(localSessionId, fn);
}

export function unregisterV2CardPublisher(localSessionId: string): void {
  publishers.delete(localSessionId);
  v2SessionIds.delete(localSessionId);
}

// local session id → relay (v2) session id. The app addresses sessions by the
// v2 id, so anything the daemon sends OUTWARD for the app to act on — push
// notifications carry a deep link — must be stamped with this, not the local
// id. Registered beside the publisher because the lane holds both ids there
// and nowhere else in this direction.
const v2SessionIds = new Map<string, string>();

export function registerV2SessionId(localSessionId: string, v2SessionId: string): void {
  v2SessionIds.set(localSessionId, v2SessionId);
}

/** The relay session id for a local session, or null when it is not bound. */
export function v2SessionIdFor(localSessionId: string): string | null {
  return v2SessionIds.get(localSessionId) ?? null;
}

/** Called from the metadata merge path with the COMPLETE merged card.
 *  Resolves true when a publisher was registered AND its PATCH resolved; a
 *  session with no registered publisher (not v2-bound yet, or the lane is
 *  down) resolves false — the lane re-publishes on rebind. Never rejects. */
export async function publishV2Card(localSessionId: string, metadata: Record<string, unknown>): Promise<boolean> {
  const fn = publishers.get(localSessionId);
  if (!fn) return false;
  try { await fn(metadata); return true; } catch { return false; }
}

/** The card's lifecycle state, derived from the daemon's joy__state. */
export function cardStateFor(joyState: unknown): "active" | "detached" | "archived" | undefined {
  if (joyState === "running") return "active";
  if (joyState === "detached") return "detached";
  if (joyState === "archived") return "archived";
  return undefined;
}
