// The ONE client-side spawn path. Every "start a session" surface (new-session
// screen, fork, the joy-sessions list) goes through here: v2.createSession puts
// a durable spawn command on the relay queue, the daemon's nucleus lane claims
// it and launches the agent, then binds the resulting card. We poll for that
// bound card so callers get back a navigable session id.
//
// There is deliberately NO v1 RPC fallback. A spawn that fails must surface as
// a failure — a silent reroute would hide exactly the breakage we need to see.
import { randomUUID } from 'expo-crypto';
import { Modal } from '@/modal';
import { t } from '@/text';
import { sync } from '@/sync/sync';
import { storage } from '@/sync/storage';
import { v2, V2ApiError } from '@/sync/v2/api';

export type V2SpawnSpec = Parameters<typeof v2.createSession>[1];

/** Spawn timeout. Covers claude CLI startup + first transcript entry on a cold
 *  machine; short enough that a misconfigured daemon surfaces instead of
 *  spinning forever. */
const SPAWN_DEADLINE_MS = 120_000;
/** A git-URL spawn clones first; the daemon allows the clone 220 s, so the
 *  wait must outlast it or a valid clone is abandoned mid-way (#151). */
const CLONE_EXTRA_MS = 220_000;
const POLL_MS = 2000;
/** How long a createSession POST may keep failing transiently before the
 *  spawn is reported as not started. Each retry replays the SAME creation
 *  intent, so the relay answers with the session it already accepted (#417). */
const CREATE_RETRY_BUDGET_MS = 30_000;
const CREATE_RETRY_BASE_MS = 1000;
/** Upper bound on any single awaited network/refresh step inside the wait
 *  loop. sync.refreshSessions awaits InvalidateSync, whose backoff retries a
 *  down relay without limit — awaited bare it would never let the loop come
 *  back to check its deadline (#416). */
const STEP_CAP_MS = 10_000;

type SessionLink = { sessionId?: string; localSessionId?: string; keyEnvelope?: string };
type SessionLike = { metadata?: { joy__sessionId?: string; v2?: SessionLink } | null };

/** Everything v2SpawnAndWait / waitForLocalSession touch outside pure logic,
 *  overridable for tests (a virtual clock, a scripted relay). Production
 *  callers never pass this. */
export interface SpawnDeps {
    api: Pick<typeof v2, 'createSession' | 'sessionState' | 'retrySpawn' | 'deleteSession'>;
    refreshSessions: () => Promise<unknown>;
    getSessions: () => Record<string, SessionLike>;
    confirm: (title: string, message: string, options: { cancelText: string; confirmText: string }) => Promise<boolean>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    /** Allocates the creation intent (see #417). A caller that wants to
     *  re-drive ONE user action (e.g. a "Retry" button on the failure it just
     *  showed) can pin the id here so the relay replays instead of spawning
     *  a second session; a new user action must get a new id. */
    creationIntentId?: string;
}

const defaultDeps = (): SpawnDeps => ({
    api: v2,
    refreshSessions: () => sync.refreshSessions(),
    getSessions: () => storage.getState().sessions as unknown as Record<string, SessionLike>,
    confirm: (title, message, options) => Modal.confirm(title, message, options),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>(r => setTimeout(r, ms)),
});

/** Await `p` for at most `ms`; a slower (or rejecting) promise yields null
 *  and keeps running on its own — the caller re-checks its deadline instead
 *  of being held hostage by a retry loop it does not own (#416). */
async function bounded<T>(deps: SpawnDeps, p: Promise<T>, ms: number): Promise<T | null> {
    const guarded = p.then(v => v, () => null);
    return Promise.race([guarded, deps.sleep(Math.max(0, ms)).then(() => null)]);
}

/** A createSession failure worth replaying under the same intent: the request
 *  may well have been accepted (lost response, relay restart, gateway 5xx).
 *  4xx answers are definitive — the relay saw the request and refused it. */
export function isRetryableCreateError(e: unknown): boolean {
    if (e instanceof V2ApiError) return e.status === 502 || e.status === 503 || e.status === 504;
    return true; // network-level: TypeError from fetch, aborts, DNS
}

/**
 * Queue a v2 spawn and wait for the daemon to bind the session.
 *
 * Handles the one recoverable failure inline: a missing directory fails the
 * spawn (create-if-missing is OFF by default), and we offer to create it and
 * retry — the durable-queue analog of v1's "Create directory?" prompt.
 *
 * Returns the session id, or null if the user declined the directory
 * prompt (already cleaned up — the caller should just bail quietly).
 * Throws on a spawn that never binds.
 */
export async function v2SpawnAndWait(machineId: string, spec: V2SpawnSpec, overrides: Partial<SpawnDeps> = {}): Promise<string | null> {
    const deps: SpawnDeps = { ...defaultDeps(), ...overrides };
    const startupBudget = SPAWN_DEADLINE_MS + (spec?.gitUrl ? CLONE_EXTRA_MS : 0);

    // The intent is allocated ONCE, before the first POST. The relay dedupes
    // createSession by (account, actor, creationIntentId) and replays the
    // accepted session for a repeat — a fresh uuid per attempt made every
    // retry after a lost acceptance queue ANOTHER session on the daemon
    // (#417).
    const creationIntentId = deps.creationIntentId ?? randomUUID();
    const createStarted = deps.now();
    let v2id: string;
    for (let attempt = 0; ; attempt++) {
        try {
            const created = await deps.api.createSession(machineId, spec, { creationIntentId });
            v2id = created.sessionId;
            break;
        } catch (e) {
            const elapsed = deps.now() - createStarted;
            if (!isRetryableCreateError(e) || elapsed >= CREATE_RETRY_BUDGET_MS) throw e;
            await deps.sleep(Math.min(CREATE_RETRY_BASE_MS * 2 ** attempt, CREATE_RETRY_BUDGET_MS - elapsed));
        }
    }

    // Mutable: paused while the user has the directory prompt open, and
    // re-armed for a fresh startup budget once a retry is accepted (#415).
    let deadline = deps.now() + startupBudget;
    let promptedForDir = false;

    while (deps.now() < deadline) {
        await deps.sleep(POLL_MS);

        // Poll v2 state so a pre-bind spawn FAILURE is caught, not waited out.
        const st = await bounded(deps, deps.api.sessionState(v2id), Math.min(STEP_CAP_MS, deadline - deps.now()));
        if (st?.spawnFailure && st.spawnFailure.startsWith('dir_missing:') && !promptedForDir) {
            promptedForDir = true;
            const missing = st.spawnFailure.slice('dir_missing:'.length);
            // The clock does not run against the spawn while the user is
            // deciding: a prompt left open past the deadline used to let the
            // retry be ACCEPTED and then throw on the very next loop check,
            // so the app reported failure while the agent went on to start
            // (#415).
            const promptOpened = deps.now();
            const approved = await deps.confirm(
                t('newSession.createDirectoryTitle'),
                t('newSession.createDirectoryMessage', { path: missing }),
                { cancelText: t('common.cancel'), confirmText: t('common.create') },
            );
            deadline += deps.now() - promptOpened;
            if (!approved) {
                await deps.api.deleteSession(v2id).catch(() => { });
                return null;
            }
            await deps.api.retrySpawn(v2id, true);
            // The accepted retry is a new startup: give it the full budget.
            deadline = deps.now() + startupBudget;
            promptedForDir = false; // allow a fresh prompt if it fails again for another reason
            continue;
        }
        // Any other spawn failure (clone_failed, agent missing, …) is final:
        // surfacing it now instead of after the 2-minute deadline (#151).
        if (st?.spawnFailure && !st.spawnFailure.startsWith('dir_missing:')) {
            await deps.api.deleteSession(v2id).catch(() => { });
            throw new Error(t('errors.spawnFailed', { reason: st.spawnFailure }));
        }

        // Bounded: a relay that stays unreachable after accepting the spawn
        // must not pin this waiter to the background retry queue (#416).
        await bounded(deps, deps.refreshSessions(), Math.min(STEP_CAP_MS, deadline - deps.now()));
        for (const [sid, s] of Object.entries(deps.getSessions())) {
            const link = s.metadata?.v2;
            // BOUND, not merely created: the v2 row exists from the moment of
            // creation, but prompts are only accepted (and sealable) once the
            // daemon has bound it — localSessionId and the key envelope arrive
            // together in the bind. Matching earlier made the initial prompt
            // race the bind and bounce off 409 session_not_ready.
            if (link?.sessionId === v2id && link.localSessionId && link.keyEnvelope) return sid;
        }
    }
    // The relay still holds the accepted spawn: cancel it so it cannot start
    // an agent nobody is waiting for (Astra on 40873bd6).
    await deps.api.deleteSession(v2id).catch(() => { });
    throw new Error(t('errors.spawnDidNotStart'));
}


/**
 * Wait for the card of a session the DAEMON created (fork, teleport, restart)
 * to show up in sync, addressed by the daemon's local id — the card carries it
 * as joy__sessionId. Returns the app session id to navigate to, or null.
 */
export async function waitForLocalSession(localSessionId: string, timeoutMs = 60_000, overrides: Partial<SpawnDeps> = {}): Promise<string | null> {
    const deps: SpawnDeps = { ...defaultDeps(), ...overrides };
    const deadline = deps.now() + timeoutMs;
    while (deps.now() < deadline) {
        // Same bound as the spawn waiter: the advertised timeout is only real
        // if no single refresh can outlive it (#416).
        await bounded(deps, deps.refreshSessions(), Math.min(STEP_CAP_MS, deadline - deps.now()));
        for (const [sid, s] of Object.entries(deps.getSessions())) {
            const m = s.metadata;
            if ((m?.joy__sessionId === localSessionId || m?.v2?.localSessionId === localSessionId) && m?.v2?.keyEnvelope) return sid;
        }
        await deps.sleep(1500);
    }
    return null;
}
