import { describe, expect, it } from 'vitest';
import { visibleQueue } from './queueVisibility';

/**
 * The queue is the DAEMON'S in-memory dispatch queue, published as a snapshot
 * on the session card. A card outlives the daemon that wrote it — so a session
 * that detaches, is archived, or whose machine reboots leaves its last
 * snapshot there forever, and every device went on showing rows that no longer
 * existed anywhere and could not be cleared: steer and cancel travel the
 * tunnel to a daemon that is not running.
 *
 * When nothing is listening there is no queue, only a memory of one.
 */
const SNAPSHOT = { queue: [{ id: 'q1', text: 'do the thing' }], inFlight: null, paused: false } as any;

describe('visibleQueueState', () => {
    it('shows the daemon queue while the session is reachable', () => {
        expect(visibleQueue(SNAPSHOT, true).queue).toHaveLength(1);
    });

    it('shows NOTHING when the session is not reachable', () => {
        expect(visibleQueue(SNAPSHOT, false).queue).toHaveLength(0);
    });

    it('drops a paused flag with the rest — a dead daemon is not paused', () => {
        expect(visibleQueue({ ...SNAPSHOT, paused: true } as any, false).paused).toBe(false);
    });

    it('drops an in-flight message too: nothing is in flight with no daemon', () => {
        expect(visibleQueue({ ...SNAPSHOT, inFlight: 'q0' } as any, false).inFlight).toBeNull();
    });

    it('is empty for a session that never had a queue, either way', () => {
        expect(visibleQueue(null, true).queue).toHaveLength(0);
        expect(visibleQueue(undefined, false).queue).toHaveLength(0);
    });

    it('returns the SAME empty object, so an offline session re-renders nothing', () => {
        expect(visibleQueue(SNAPSHOT, false)).toBe(visibleQueue(null, false));
    });
});
