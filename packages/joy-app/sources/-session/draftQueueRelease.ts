import { storage } from '@/sync/storage';
import { useDraftQueueStore } from './draftQueue';

/**
 * Auto-release for the app-side message queue (draft queue).
 *
 * THE queue for messages composed while the agent is busy lives in the APP
 * (useDraftQueueStore) — not in the daemon, not in Claude's TUI buffer — so
 * items stay trivially editable/deletable right up until they're sent. This
 * module is the release valve: when a session's turn completes (thinking
 * flips false), the HEAD draft is sent through the normal send path. One
 * item per turn-completion, so everything still queued remains editable.
 *
 * Release guards:
 *  - inFlight per session: set on release, cleared when thinking goes true
 *    (the sent message started its turn) or after a 15s backstop — so a
 *    thinking flap can't machine-gun the whole queue into one turn.
 *  - joy-tmux sessions only: the thinking semantics this relies on (hook
 *    driven, persisted mirror) are joy's.
 */

type SendFn = (sessionId: string, text: string) => void;

const inFlightUntil = new Map<string, number>();
const RELEASE_BACKSTOP_MS = 15_000;

let initialized = false;

export function initDraftQueueRelease(send: SendFn): void {
    if (initialized) return;
    initialized = true;

    const maybeRelease = () => {
        const state = storage.getState();
        const drafts = useDraftQueueStore.getState().bySession;
        const now = Date.now();
        for (const [sessionId, queue] of Object.entries(drafts)) {
            if (!queue || queue.length === 0) continue;
            const session = state.sessions[sessionId];
            if (!session || session.metadata?.joy__source !== 'joy-tmux') continue;
            const busy = session.thinking === true || session.metadata?.joy__thinking != null;
            if (busy) {
                // Turn started — the previous release (if any) landed.
                inFlightUntil.delete(sessionId);
                continue;
            }
            const until = inFlightUntil.get(sessionId);
            if (until !== undefined && now < until) continue;
            // Idle + queued + not mid-release → send the head.
            const head = queue[0];
            inFlightUntil.set(sessionId, now + RELEASE_BACKSTOP_MS);
            useDraftQueueStore.getState().remove(sessionId, head.id);
            send(sessionId, head.text);
        }
    };

    // Sessions state drives the thinking transitions; drafts changing while
    // idle (user queues onto an idle session — rare, but possible from the
    // strip) also needs a look.
    storage.subscribe(maybeRelease);
    useDraftQueueStore.subscribe(maybeRelease);
}
