import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMachineOnline, isMachineOnlineAt, MACHINE_ONLINE_WINDOW_MS, msUntilNextMachineOffline } from './machineUtils';
import type { Machine } from '@/sync/storageTypes';

const NOW = 1_700_000_000_000;

function machine(over: Partial<Machine>): Machine {
    return {
        id: 'm1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: NOW,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        ...over,
    } as Machine;
}

describe('isMachineOnlineAt (#323)', () => {
    it('a live lease with a fresh record is online', () => {
        expect(isMachineOnlineAt(machine({ leaseAlive: true, activeAt: NOW - 5_000 }), NOW)).toBe(true);
    });

    it('a live lease whose record went stale (no relay updates) expires like a legacy record', () => {
        const stale = machine({ leaseAlive: true, activeAt: NOW - MACHINE_ONLINE_WINDOW_MS - 100 });
        expect(isMachineOnlineAt(stale, NOW)).toBe(false);
        // the same timestamp without leaseAlive already expired before the fix
        expect(isMachineOnlineAt(machine({ activeAt: stale.activeAt }), NOW)).toBe(false);
    });

    it('a dead lease is offline even when the record is fresh (relay is authoritative for offline)', () => {
        expect(isMachineOnlineAt(machine({ leaseAlive: false, activeAt: NOW }), NOW)).toBe(false);
    });

    it('legacy records (no leaseAlive) use the heartbeat window', () => {
        expect(isMachineOnlineAt(machine({ activeAt: NOW - 30_000 }), NOW)).toBe(true);
        expect(isMachineOnlineAt(machine({ activeAt: NOW - MACHINE_ONLINE_WINDOW_MS }), NOW)).toBe(false);
    });
});

describe('isMachineOnline as a filter callback (#323 #180)', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => { vi.useRealTimers(); });

    it('Array.filter(isMachineOnline) drops a stale cached lease and a stale legacy record', () => {
        const staleLease = machine({ id: 'lease', leaseAlive: true, activeAt: NOW - MACHINE_ONLINE_WINDOW_MS - 1 });
        const staleLegacy = machine({ id: 'legacy', activeAt: NOW - MACHINE_ONLINE_WINDOW_MS - 1 });
        const fresh = machine({ id: 'fresh', leaseAlive: true, activeAt: NOW - 1_000 });
        // The row index used to arrive as `now`, so index 0 read as the epoch
        // and every cached lease stayed "online" — the direct call disagreed.
        expect([staleLease, staleLegacy, fresh].filter(isMachineOnline).map((m) => m.id)).toEqual(['fresh']);
        expect(isMachineOnline(staleLease)).toBe(false);
        expect(isMachineOnline(staleLegacy)).toBe(false);
    });
});

describe('msUntilNextMachineOffline (#180)', () => {
    it('reports when the earliest online machine leaves the window', () => {
        const a = machine({ id: 'a', activeAt: NOW - 10_000 });
        const b = machine({ id: 'b', activeAt: NOW - 50_000 });
        expect(msUntilNextMachineOffline([a, b], NOW)).toBe(MACHINE_ONLINE_WINDOW_MS - 50_000);
    });

    it('ignores machines that are already offline and returns null with nothing online', () => {
        const dead = machine({ leaseAlive: false, activeAt: NOW });
        const stale = machine({ activeAt: NOW - MACHINE_ONLINE_WINDOW_MS - 1 });
        expect(msUntilNextMachineOffline([dead, stale], NOW)).toBeNull();
        expect(msUntilNextMachineOffline([], NOW)).toBeNull();
    });
});
