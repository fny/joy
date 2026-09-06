import { describe, expect, it } from 'vitest';
import { isMachineOnline, MACHINE_ONLINE_WINDOW_MS } from './machineUtils';
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

describe('isMachineOnline (#323)', () => {
    it('a live lease with a fresh record is online', () => {
        expect(isMachineOnline(machine({ leaseAlive: true, activeAt: NOW - 5_000 }), NOW)).toBe(true);
    });

    it('a live lease whose record went stale (no relay updates) expires like a legacy record', () => {
        const stale = machine({ leaseAlive: true, activeAt: NOW - MACHINE_ONLINE_WINDOW_MS - 100 });
        expect(isMachineOnline(stale, NOW)).toBe(false);
        // the same timestamp without leaseAlive already expired before the fix
        expect(isMachineOnline(machine({ activeAt: stale.activeAt }), NOW)).toBe(false);
    });

    it('a dead lease is offline even when the record is fresh (relay is authoritative for offline)', () => {
        expect(isMachineOnline(machine({ leaseAlive: false, activeAt: NOW }), NOW)).toBe(false);
    });

    it('legacy records (no leaseAlive) use the heartbeat window', () => {
        expect(isMachineOnline(machine({ activeAt: NOW - 30_000 }), NOW)).toBe(true);
        expect(isMachineOnline(machine({ activeAt: NOW - MACHINE_ONLINE_WINDOW_MS }), NOW)).toBe(false);
    });
});
