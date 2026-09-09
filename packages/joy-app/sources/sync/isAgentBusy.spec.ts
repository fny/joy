import { describe, it, expect } from 'vitest';
import { EPHEMERAL_THINKING_TRUST_MS, isAgentBusy } from './sessionLiveness';

const now = Date.now();
const base = { presence: 'online' as const, activeAt: now };

describe('isAgentBusy', () => {
    it('is busy on the ephemeral flag', () => {
        expect(isAgentBusy({ ...base, thinking: true })).toBe(true);
    });

    it('is busy on the persisted mirror alone — the case that leaked messages', () => {
        // The ephemeral flag reaches connected clients only. After a cold start
        // or reconnect the mirror is the only truth, and the status line has
        // always believed it. The gate must too, or a message sent while the
        // screen says "clauding…" goes straight to the relay.
        expect(isAgentBusy({ ...base, thinking: false, metadata: { joy__thinking: { since: now - 5000 } } })).toBe(true);
    });

    it('stays busy through a long turn — an old `since` is not staleness', () => {
        expect(isAgentBusy({ ...base, metadata: { joy__thinking: { since: now - 10 * 60_000 } } })).toBe(true);
    });

    it('is not busy when neither signal is set', () => {
        expect(isAgentBusy({ ...base, thinking: false })).toBe(false);
        expect(isAgentBusy({ ...base, metadata: { joy__thinking: null } })).toBe(false);
        expect(isAgentBusy({ ...base })).toBe(false);
    });

    // The bug: finished sessions stayed blue in the sidebar. The ephemeral
    // flag is derived from turn events this client happened to see and has no
    // reset path (relay rows preserve it), so a turn-end missed while the
    // session was closed pinned it true forever.
    describe('a daemon card with no mirror ages out the derived flag', () => {
        const daemon = { ...base, metadata: { joy__source: 'joy-daemon' } };

        it('believes a FRESH derived flag — the card lags the message stream at turn start (#652)', () => {
            expect(isAgentBusy({ ...daemon, thinking: true, thinkingAt: now - 2_000 })).toBe(true);
        });

        it('stops believing a stale one — the turn-end this client never saw', () => {
            expect(isAgentBusy({ ...daemon, thinking: true, thinkingAt: now - EPHEMERAL_THINKING_TRUST_MS - 1 })).toBe(false);
        });

        it('a flag that was never stamped is not evidence of anything', () => {
            expect(isAgentBusy({ ...daemon, thinking: true })).toBe(false);
        });

        it('the mirror still outranks everything while it is set', () => {
            expect(isAgentBusy({ ...base, thinking: false, metadata: { joy__source: 'joy-daemon', joy__thinking: { since: now - 60 * 60_000 } } })).toBe(true);
        });

        it('covers the daemon\'s historical source names', () => {
            for (const joy__source of ['joy-daemon', 'joy-tmux', 'joy-server']) {
                expect(isAgentBusy({ ...base, thinking: true, thinkingAt: now - 60_000, metadata: { joy__source } }), joy__source).toBe(false);
            }
        });

        it('a session no daemon publishes keeps the old rule — nothing else can answer for it', () => {
            expect(isAgentBusy({ ...base, thinking: true, metadata: { joy__source: 'something-else' } })).toBe(true);
            expect(isAgentBusy({ ...base, thinking: true, thinkingAt: now - 60 * 60_000, metadata: {} })).toBe(true);
        });

        it('and an offline daemon session is still not busy', () => {
            expect(isAgentBusy({ presence: 'online', activeAt: now - 10 * 60_000, metadata: { joy__source: 'joy-daemon', joy__thinking: { since: now } } })).toBe(false);
        });
    });

    it('never trusts either signal from a session that is not live', () => {
        // A dead daemon must not freeze the composer into queueing forever.
        expect(isAgentBusy({ presence: 'online', activeAt: now - 10 * 60_000, thinking: true })).toBe(false);
        expect(isAgentBusy({ presence: now, activeAt: now, thinking: true })).toBe(false);
        expect(isAgentBusy({ presence: now, activeAt: now, metadata: { joy__thinking: { since: now } } })).toBe(false);
    });
});
