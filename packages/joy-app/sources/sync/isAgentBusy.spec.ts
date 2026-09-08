import { describe, it, expect } from 'vitest';
import { isAgentBusy } from './sessionLiveness';

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

    it('never trusts either signal from a session that is not live', () => {
        // A dead daemon must not freeze the composer into queueing forever.
        expect(isAgentBusy({ presence: 'online', activeAt: now - 10 * 60_000, thinking: true })).toBe(false);
        expect(isAgentBusy({ presence: now, activeAt: now, thinking: true })).toBe(false);
        expect(isAgentBusy({ presence: now, activeAt: now, metadata: { joy__thinking: { since: now } } })).toBe(false);
    });
});
