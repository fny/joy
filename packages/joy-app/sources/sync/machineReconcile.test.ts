import { describe, it, expect } from 'vitest';
import { reconcileMachineMetadata } from './machineReconcile';
import type { Machine } from './storageTypes';

// Minimal Machine fixture — only the fields reconcile cares about matter.
function machine(over: Partial<Machine>): Machine {
    return {
        id: 'm1',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
        ...over,
    } as Machine;
}

const META = { host: 'faraz-vip', displayName: 'faraz vip' } as Machine['metadata'];

describe('reconcileMachineMetadata', () => {
    it('keeps the last-known metadata when an update arrives with null metadata', () => {
        // fetchMachines returns metadata:null on failed/pending decryption.
        const incoming = machine({ id: 'm1', metadata: null, metadataVersion: 3, active: false });
        const prev = machine({ id: 'm1', metadata: META, metadataVersion: 2 });

        const out = reconcileMachineMetadata(incoming, prev);

        expect(out.metadata).toEqual(META);         // name preserved, not nulled
        expect(out.metadataVersion).toBe(2);         // kept with the preserved metadata
        expect(out.active).toBe(false);              // other live fields from the incoming update still apply
    });

    it('applies a real (decrypted) metadata update as-is', () => {
        const incoming = machine({ id: 'm1', metadata: META, metadataVersion: 5 });
        const prev = machine({ id: 'm1', metadata: { host: 'old' } as Machine['metadata'], metadataVersion: 4 });

        const out = reconcileMachineMetadata(incoming, prev);

        expect(out).toBe(incoming);                  // unchanged — newer metadata wins
        expect(out.metadata).toEqual(META);
        expect(out.metadataVersion).toBe(5);
    });

    it('does not invent metadata for a brand-new machine (no prior, null incoming)', () => {
        const incoming = machine({ id: 'mNew', metadata: null });
        expect(reconcileMachineMetadata(incoming, undefined).metadata).toBeNull();
    });

    it('leaves null incoming alone when the prior also had no metadata', () => {
        const incoming = machine({ id: 'm1', metadata: null });
        const prev = machine({ id: 'm1', metadata: null });
        expect(reconcileMachineMetadata(incoming, prev).metadata).toBeNull();
    });
});
