import { describe, it, expect } from 'vitest';
import { hasFreshPermissionRequest, msUntilNextFreshnessExpiry } from './faviconPermission';
import { SESSION_STALE_AFTER_MS } from '@/sync/sessionLiveness';

const now = 1_000_000;
const pending = { agentState: { requests: { r1: {} } } };

describe('faviconPermission', () => {
    it('#299: a session with cached presence "online" but a stale heartbeat no longer lights the favicon', () => {
        const stale = { presence: 'online' as const, activeAt: now - SESSION_STALE_AFTER_MS - 1, ...pending };
        expect(hasFreshPermissionRequest([stale], now)).toBe(false);
        const fresh = { presence: 'online' as const, activeAt: now - 1000, ...pending };
        expect(hasFreshPermissionRequest([fresh], now)).toBe(true);
    });

    it('ignores offline sessions and live sessions without requests', () => {
        expect(hasFreshPermissionRequest([{ presence: now - 5, activeAt: now, ...pending }], now)).toBe(false);
        expect(hasFreshPermissionRequest([{ presence: 'online', activeAt: now, agentState: { requests: {} } }], now)).toBe(false);
        expect(hasFreshPermissionRequest([{ presence: 'online', activeAt: now, agentState: null }], now)).toBe(false);
        expect(hasFreshPermissionRequest([], now)).toBe(false);
    });

    it('#299: reports when the earliest lit session will go stale so the indicator can re-check then', () => {
        const a = { presence: 'online' as const, activeAt: now - 10_000, ...pending };
        const b = { presence: 'online' as const, activeAt: now - 60_000, ...pending };
        expect(msUntilNextFreshnessExpiry([a, b], now)).toBe(SESSION_STALE_AFTER_MS - 60_000);
        expect(msUntilNextFreshnessExpiry([], now)).toBeNull();
        expect(msUntilNextFreshnessExpiry([{ presence: 'online', activeAt: now, agentState: null }], now)).toBeNull();
    });
});
