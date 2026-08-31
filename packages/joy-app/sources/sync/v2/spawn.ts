// The ONE client-side spawn path. Every "start a session" surface (new-session
// screen, fork, the joy-sessions list) goes through here: v2.createSession puts
// a durable spawn command on the relay queue, the daemon's nucleus lane claims
// it and launches the agent, then binds the resulting card. We poll for that
// bound card so callers get back a navigable happy session id.
//
// There is deliberately NO v1 RPC fallback. A spawn that fails must surface as
// a failure — a silent reroute would hide exactly the breakage we need to see.
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { v2 } from '@/sync/v2/api';

export type V2SpawnSpec = Parameters<typeof v2.createSession>[1];

/** Spawn timeout. Covers claude CLI startup + first transcript entry on a cold
 *  machine; short enough that a misconfigured daemon surfaces instead of
 *  spinning forever. */
const SPAWN_DEADLINE_MS = 120_000;
const POLL_MS = 2000;

/**
 * Queue a v2 spawn and wait for the daemon to bind the session.
 *
 * Handles the one recoverable failure inline: a missing directory fails the
 * spawn (create-if-missing is OFF by default), and we offer to create it and
 * retry — the durable-queue analog of v1's "Create directory?" prompt.
 *
 * Returns the happy session id, or null if the user declined the directory
 * prompt (already cleaned up — the caller should just bail quietly).
 * Throws on a spawn that never binds.
 */
export async function v2SpawnAndWait(machineId: string, spec: V2SpawnSpec): Promise<string | null> {
    const created = await v2.createSession(machineId, spec);
    const v2id: string = created.sessionId;
    const deadline = Date.now() + SPAWN_DEADLINE_MS;
    let promptedForDir = false;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));

        // Poll v2 state so a pre-bind spawn FAILURE is caught, not waited out.
        const st = await v2.sessionState(v2id).catch(() => null);
        if (st?.spawnFailure && st.spawnFailure.startsWith('dir_missing:') && !promptedForDir) {
            promptedForDir = true;
            const missing = st.spawnFailure.slice('dir_missing:'.length);
            const approved = await Modal.confirm(
                'Create directory?',
                `The directory '${missing}' does not exist on the machine. Create it?`,
                { cancelText: t('common.cancel'), confirmText: t('common.create') },
            );
            if (!approved) {
                await v2.deleteSession(v2id).catch(() => { });
                return null;
            }
            await v2.retrySpawn(v2id, true);
            promptedForDir = false; // allow a fresh prompt if it fails again for another reason
            continue;
        }

        await sync.refreshSessions();
        const all = storage.getState().sessions;
        for (const [sid, s] of Object.entries(all)) {
            if ((s as { metadata?: { v2?: { sessionId?: string } } }).metadata?.v2?.sessionId === v2id) return sid;
        }
    }
    throw new Error('v2 spawn accepted but the session did not start within 2 minutes. Check the daemon lane on that machine.');
}
