// Whether to show a session's queue at all — the whole of the lingering-queue
// fix, in a module with nothing in its import graph so it can be tested
// without a renderer or react-native.
//
// The queue is the DAEMON'S in-memory dispatch queue, published as a snapshot
// on the session card. A card outlives the daemon that wrote it: a session
// that detaches, is archived, or whose machine reboots never gets to publish
// an empty one on the way out. So the card kept its last snapshot forever, and
// every device went on showing rows that no longer existed anywhere — and
// offered steer and cancel on them, which travel the tunnel to a daemon that
// is not running. Actions that could only ever fail.
//
// When nothing is listening there is no queue, only a memory of one.

/** Structural, so this module imports nothing. */
export interface QueueSnapshot {
    queue: unknown[];
    hidden?: unknown[];
    pendingCount?: number;
    inFlight: string | null;
    paused: boolean;
    pauseReason?: unknown;
}

/** One shared empty value, so an unreachable session re-renders nothing. */
export const EMPTY_QUEUE: QueueSnapshot = { queue: [], inFlight: null, paused: false };

export function visibleQueue<T extends QueueSnapshot>(
    snapshot: T | null | undefined,
    live: boolean,
): T | QueueSnapshot {
    return live ? (snapshot ?? EMPTY_QUEUE) : EMPTY_QUEUE;
}
