// v2 session-card publishing: the bridge between the ONE metadata write path
// (RelaySession.doMergeMetadata — every agent flavor funnels through it) and
// the nucleus lane, which holds the v2 session identity, content key and
// lease needed to PATCH the relay's card.
//
// A tiny registry rather than imports in either direction: relay.ts must not
// depend on nucleusLane (it predates v2), and the lane must not reach into
// RelaySession internals. The lane registers a publisher per bound session;
// the metadata path fires it with the freshly merged card.
//
// Publishing is fire-and-forget by design: the card is a rendering of state
// the daemon already holds durably (window records + happy metadata), so a
// lost PATCH costs staleness until the next merge, never correctness.

export type CardPublisher = (metadata: Record<string, unknown>) => void;

const publishers = new Map<string, CardPublisher>();

export function registerV2CardPublisher(localSessionId: string, fn: CardPublisher): void {
  publishers.set(localSessionId, fn);
}

export function unregisterV2CardPublisher(localSessionId: string): void {
  publishers.delete(localSessionId);
}

/** Called from the metadata merge path with the COMPLETE merged card. A
 *  session with no registered publisher (not v2-bound yet, or the lane is
 *  down) is silently skipped — the lane re-publishes on rebind. */
export function publishV2Card(localSessionId: string, metadata: Record<string, unknown>): void {
  try { publishers.get(localSessionId)?.(metadata); } catch { /* fire-and-forget */ }
}

/** The card's lifecycle state, derived from the daemon's joy__state. */
export function cardStateFor(joyState: unknown): "active" | "detached" | "archived" | undefined {
  if (joyState === "running") return "active";
  if (joyState === "detached") return "detached";
  if (joyState === "archived") return "archived";
  return undefined;
}
