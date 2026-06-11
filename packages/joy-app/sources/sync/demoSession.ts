import type { Session } from './storageTypes';

// The id used by the dev message-rendering demos. A local, non-synced session
// with no encryption — sync operations must skip it (no real backend).
export const DEMO_SESSION_ID = 'demo-messages-session';

export const isDemoSession = (id?: string | null): boolean => id === DEMO_SESSION_ID;

// A minimal valid Session record so useSession()/the session routes treat the
// demo as a loaded session while previewing fixtures.
export function demoSessionStub(): Session {
    return {
        id: DEMO_SESSION_ID,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
    };
}
