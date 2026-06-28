import type { Machine } from './storageTypes';

/**
 * Reconcile an incoming machine update against the machine we already hold.
 *
 * `fetchMachines` emits `metadata: null` whenever a machine's key/metadata
 * decryption fails or hasn't landed yet (see sync.ts). Applying that as-is would
 * wipe an already-decrypted name and revert the sidebar to the raw machine id
 * until a later fetch succeeds (the "machine name shows its id / takes a long
 * time to come up" bug). When the incoming update has no metadata but we already
 * hold decrypted metadata for that machine, keep the last-known metadata (and its
 * version). A later update that carries real decrypted metadata applies normally.
 */
export function reconcileMachineMetadata(incoming: Machine, prev: Machine | undefined): Machine {
    if (!incoming.metadata && prev?.metadata) {
        return { ...incoming, metadata: prev.metadata, metadataVersion: prev.metadataVersion };
    }
    return incoming;
}
