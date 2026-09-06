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
import { loadUncertainCreations, saveUncertainCreations } from '@/sync/persistence';
import { v2, V2ApiError } from '@/sync/v2/api';
import { deriveSpawnSpecKey, encodeSpawnSpec } from '@/sync/v2/spawnSpec';

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
 *  back to check its deadline (#416). createSession and retrySpawn attempts
 *  are capped the same way: a POST that never answers is a lost response,
 *  which the intent replay (#417) already handles. */
const STEP_CAP_MS = 10_000;
/** Upper bound on the cancel DELETE after a spawn is abandoned. It runs at
 *  the moment the relay is most likely unreachable — unbounded, it stranded
 *  the waiter forever AFTER its deadline had already fired (#416). */
const CLEANUP_CAP_MS = STEP_CAP_MS;
/** How many UNCERTAIN creations (see SpawnCreationUncertainError) are
 *  retained at once — a bound on count only, never on age: acceptance does
 *  not become known by waiting, so an unresolved identity lives until the
 *  relay answers under it (#417). The relay dedupes by (account, actor,
 *  creationIntentId) plus the full request hash, so a replay can only ever
 *  return the session this exact action asked for. */
const UNCERTAIN_CREATIONS_CAP = 32;

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
    /** The key the spawn spec is sealed under for this machine, or null for
     *  the plain-JSON form (#107) — spawnSealKeyFor in production. */
    sealKeyFor: (machineId: string) => Promise<Uint8Array | null>;
    /** Pins the creation intent (see #417). A caller re-driving ONE user
     *  action — the "Retry" of a SpawnCreationUncertainError it just showed
     *  (v2SpawnInteractive) — passes that error's `creationIntentId` here so
     *  the relay replays instead of spawning a second session; a new user
     *  action must not. */
    creationIntentId?: string;
}

const defaultDeps = (): SpawnDeps => ({
    api: v2,
    refreshSessions: () => sync.refreshSessions(),
    getSessions: () => storage.getState().sessions as unknown as Record<string, SessionLike>,
    confirm: (title, message, options) => Modal.confirm(title, message, options),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>(r => setTimeout(r, ms)),
    sealKeyFor: (machineId) => spawnSealKeyFor(machineId),
});

/** What spawnSealKeyFor reads; overridable for tests. */
export interface SpawnSealKeyLookup {
    /** The machine's synced record (its sealed metadata, opened). */
    machine: (machineId: string) => { metadata?: { capabilities?: { spawnSpecSealed?: boolean } } | null } | undefined;
    /** The per-machine key the app unwrapped from `dataEncryptionKey`, or null. */
    machineKey: (machineId: string) => Uint8Array | null;
}

const defaultSealKeyLookup: SpawnSealKeyLookup = {
    machine: (machineId) => storage.getState().machines[machineId],
    machineKey: (machineId) => sync.machineOnlyCtx(machineId)?.machineKey ?? null,
};

/**
 * The seal key for a spawn to `machineId`, or null for the plain form (#107).
 * Sealed ONLY when the daemon advertises `capabilities.spawnSpecSealed` in
 * its machine metadata AND the app holds that machine's key. Every daemon
 * parses the plain form, so the gate can only ever cost confidentiality,
 * never a spawn: a sealed spec to a daemon that predates the capability is
 * "no usable spawnSpec — skipped" there and the create hangs to its
 * deadline; one it cannot open is reported `bad_spawn_spec` (never launched).
 */
export async function spawnSealKeyFor(machineId: string, lookup: SpawnSealKeyLookup = defaultSealKeyLookup): Promise<Uint8Array | null> {
    if (lookup.machine(machineId)?.metadata?.capabilities?.spawnSpecSealed !== true) return null;
    const machineKey = lookup.machineKey(machineId);
    if (!machineKey) return null;
    return deriveSpawnSpecKey(machineKey, machineId);
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown } | null;

/** Await `p` for at most `ms`. null when it did not settle in time — it keeps
 *  running on its own and the caller re-checks its deadline instead of being
 *  held hostage by a retry loop it does not own (#416). A rejection is
 *  reported as such, so the caller can tell "refused" from "no answer". */
async function settleWithin<T>(deps: SpawnDeps, p: Promise<T>, ms: number): Promise<Settled<T>> {
    const tracked: Promise<Settled<T>> = p.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    return Promise.race([tracked, deps.sleep(Math.max(0, ms)).then(() => null)]);
}

/** settleWithin for steps whose failure and timeout are handled alike. */
async function bounded<T>(deps: SpawnDeps, p: Promise<T>, ms: number): Promise<T | null> {
    const r = await settleWithin(deps, p, ms);
    return r?.ok ? r.value : null;
}

/** A createSession failure worth replaying under the same intent: the request
 *  may well have been accepted (lost response, relay restart, gateway 5xx).
 *  4xx answers are definitive — the relay saw the request and refused it. */
export function isRetryableCreateError(e: unknown): boolean {
    if (e instanceof V2ApiError) return e.status === 502 || e.status === 503 || e.status === 504;
    return true; // network-level: TypeError from fetch, aborts, DNS
}

/** Whether the cancel of an abandoned spawn was acknowledged by the relay.
 *  'uncertain' means the relay may still hold a spawn nobody is waiting for
 *  — reported separately from the spawn failure itself (#416). */
export type SpawnCleanup = 'done' | 'uncertain';

/**
 * The relay may or may not hold an accepted creation (#417): every attempt
 * inside the create budget failed in a way that could still have been
 * accepted — a lost response, a gateway 5xx, a POST that never answered.
 * The identity is retained (uncertainCreationFor) so a retry of the SAME
 * action replays it instead of queueing a second session; a caller that
 * shows this failure with a Retry passes `creationIntentId` back through
 * SpawnDeps. `status`/`code` mirror the last relay answer, if there was one.
 */
export class SpawnCreationUncertainError extends Error {
    readonly creationIntentId: string;
    readonly machineId: string;
    readonly cause: unknown;
    readonly status?: number;
    readonly code?: string;

    constructor(creationIntentId: string, machineId: string, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'SpawnCreationUncertainError';
        this.creationIntentId = creationIntentId;
        this.machineId = machineId;
        this.cause = cause;
        if (cause instanceof V2ApiError) {
            this.status = cause.status;
            this.code = cause.code;
        }
    }
}

/** An accepted spawn that failed or never bound and was abandoned. The
 *  message is the user-facing reason; `cleanup` says whether the cancel
 *  DELETE was acknowledged (#416). */
export class SpawnAbandonedError extends Error {
    constructor(message: string, readonly v2SessionId: string, readonly cleanup: SpawnCleanup) {
        super(message);
        this.name = 'SpawnAbandonedError';
    }
}

/** The retained identity of a creation whose acceptance is unresolved.
 *  Persisted as-is (sync/persistence loadUncertainCreations). */
export interface UncertainCreation {
    creationIntentId: string;
    machineId: string;
    /** When the create budget FIRST ran out for this intent (deps.now()) —
     *  informational; nothing expires on it. */
    since: number;
    /** The spec exactly as it went on the wire. A replay of this intent must
     *  re-send these bytes: the relay's idempotency hash covers them, and a
     *  sealed spec carries a random nonce (#107, #417). */
    spawnSpecWire?: string;
}

// Keyed by the action's fingerprint (machine + spec): the relay's own
// idempotency hash covers the whole request, so only the IDENTICAL action
// may replay an intent. PERSISTED (relay-scoped MMKV, sync/persistence) and
// loaded on first use: a module-only map was discarded by an app restart,
// and a ten-minute age limit let the very same unresolved action accept a
// second intent afterwards — both left two sessions where the user asked
// for one (#417). An entry is removed only when its acceptance is resolved
// (an answer under the intent, accepted or refused) or the caller discards
// it (discardUncertainCreation); UNCERTAIN_CREATIONS_CAP bounds the count.
let uncertainCreations: Map<string, UncertainCreation> | null = null;

function registry(): Map<string, UncertainCreation> {
    if (!uncertainCreations) uncertainCreations = new Map(Object.entries(loadUncertainCreations()));
    return uncertainCreations;
}

function persistRegistry(): void {
    saveUncertainCreations(Object.fromEntries(registry()));
}

function retainUncertainCreation(fingerprint: string, entry: UncertainCreation): void {
    const r = registry();
    r.delete(fingerprint);
    r.set(fingerprint, entry);
    // Insertion order is age: drop the oldest beyond the cap.
    while (r.size > UNCERTAIN_CREATIONS_CAP) {
        const oldest = r.keys().next().value;
        if (oldest === undefined) break;
        r.delete(oldest);
    }
    persistRegistry();
}

function resolveUncertainCreation(fingerprint: string): void {
    if (registry().delete(fingerprint)) persistRegistry();
}

function stableJson(v: unknown): string {
    if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
    }
    return JSON.stringify(v) ?? 'null';
}

/** Identity of one spawn ACTION: same machine and the same spec. */
export function creationFingerprint(machineId: string, spec: V2SpawnSpec): string {
    return machineId + '\n' + stableJson(spec ?? null);
}

/**
 * The unresolved creation of exactly this action, if any (#417). The UI
 * passes its `creationIntentId` as SpawnDeps.creationIntentId when the user
 * retries the failure it was shown (v2SpawnInteractive); v2SpawnAndWait
 * also reuses it on its own for an identical spawn, however long ago and
 * across app restarts. It resolves when a create under it is answered
 * (accepted or refused); choosing a DISTINCT creation of the same action is
 * discardUncertainCreation.
 */
export function uncertainCreationFor(machineId: string, spec: V2SpawnSpec): UncertainCreation | null {
    return registry().get(creationFingerprint(machineId, spec)) ?? null;
}

/** Forget the unresolved creation of this action: the next spawn of it is a
 *  new creation with a new identity. */
export function discardUncertainCreation(machineId: string, spec: V2SpawnSpec): void {
    resolveUncertainCreation(creationFingerprint(machineId, spec));
}

/** Test seam: a fresh registry between cases (memory and persisted). */
export function resetUncertainCreationsForTests(): void {
    uncertainCreations = new Map();
    persistRegistry();
}

/** Cancel an accepted spawn nobody is waiting for — without letting the
 *  cancel itself hang the caller (#416). A 404 means it is already gone. */
async function cancelSpawn(deps: SpawnDeps, v2id: string): Promise<SpawnCleanup> {
    const r = await settleWithin(deps, deps.api.deleteSession(v2id), CLEANUP_CAP_MS);
    if (r === null) return 'uncertain';
    if (r.ok) return 'done';
    return r.error instanceof V2ApiError && r.error.status === 404 ? 'done' : 'uncertain';
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
 * Throws SpawnCreationUncertainError when the relay never answered the
 * creation, and SpawnAbandonedError on a spawn that failed or never bound.
 */
export async function v2SpawnAndWait(machineId: string, spec: V2SpawnSpec, overrides: Partial<SpawnDeps> = {}): Promise<string | null> {
    const deps: SpawnDeps = { ...defaultDeps(), ...overrides };
    const startupBudget = SPAWN_DEADLINE_MS + (spec?.gitUrl ? CLONE_EXTRA_MS : 0);

    // The intent is allocated ONCE, before the first POST. The relay dedupes
    // createSession by (account, actor, creationIntentId) and replays the
    // accepted session for a repeat — a fresh uuid per attempt made every
    // retry after a lost acceptance queue ANOTHER session on the daemon
    // (#417). An unresolved creation of this very action is replayed too:
    // after the retry budget the id used to live only in the abandoned
    // invocation, so the user's own retry accepted a second intent.
    const fingerprint = creationFingerprint(machineId, spec);
    const uncertain = uncertainCreationFor(machineId, spec);
    const creationIntentId = deps.creationIntentId ?? uncertain?.creationIntentId ?? randomUUID();
    // The spec goes on the wire ONCE per creation intent (#107): sealed under
    // the machine's spawn-spec key when the daemon opens sealed specs (a
    // fresh random nonce each time it is sealed), else plain JSON. The relay
    // hashes the spawnSpec bytes into the intent's idempotency check, so
    // every retry of this intent — in this call, or a later replay of the
    // same unresolved creation — re-sends the identical envelope; re-sealing
    // would be answered 409 idempotency_mismatch instead of a replay.
    const spawnSpecWire = spec
        ? (uncertain?.creationIntentId === creationIntentId ? uncertain.spawnSpecWire : undefined)
            ?? encodeSpawnSpec(spec, await deps.sealKeyFor(machineId))
        : undefined;
    const createStarted = deps.now();
    let v2id: string;
    for (let attempt = 0; ; attempt++) {
        const remaining = CREATE_RETRY_BUDGET_MS - (deps.now() - createStarted);
        const r = await settleWithin(deps, deps.api.createSession(machineId, spec, { creationIntentId, spawnSpecWire }), Math.min(STEP_CAP_MS, remaining));
        if (r?.ok) {
            v2id = r.value.sessionId;
            resolveUncertainCreation(fingerprint); // acceptance resolved
            break;
        }
        const error = r ? r.error : new Error('createSession did not answer in time');
        if (!isRetryableCreateError(error)) {
            resolveUncertainCreation(fingerprint); // the relay refused it: nothing to replay
            throw error;
        }
        const elapsed = deps.now() - createStarted;
        if (elapsed >= CREATE_RETRY_BUDGET_MS) {
            retainUncertainCreation(fingerprint, { creationIntentId, machineId, since: uncertain?.since ?? deps.now(), spawnSpecWire });
            throw new SpawnCreationUncertainError(creationIntentId, machineId, error);
        }
        await deps.sleep(Math.min(CREATE_RETRY_BASE_MS * 2 ** attempt, CREATE_RETRY_BUDGET_MS - elapsed));
    }

    // Mutable: paused while the user has the directory prompt open, and
    // re-armed for a fresh startup budget once a retry is accepted (#415).
    let deadline = deps.now() + startupBudget;
    // The user approved creating the missing directory, but the relay has
    // not acknowledged the retry yet: re-send it instead of asking again.
    let dirApproved = false;

    while (deps.now() < deadline) {
        await deps.sleep(POLL_MS);

        // Poll v2 state so a pre-bind spawn FAILURE is caught, not waited out.
        const st = await bounded(deps, deps.api.sessionState(v2id), Math.min(STEP_CAP_MS, deadline - deps.now()));
        if (st?.spawnFailure && st.spawnFailure.startsWith('dir_missing:')) {
            if (!dirApproved) {
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
                    const cleanup = await cancelSpawn(deps, v2id);
                    if (cleanup !== 'done') console.warn(`[spawn] declined directory prompt, but cancelling ${v2id} was not acknowledged (#416)`);
                    return null;
                }
                dirApproved = true;
            }
            // Bounded (#416): a retry request that hangs must not pin the
            // waiter. If it did not land, the next poll still reads
            // dir_missing and re-sends it — the user already approved.
            const retry = await settleWithin(deps, deps.api.retrySpawn(v2id, true), Math.min(STEP_CAP_MS, Math.max(0, deadline - deps.now())));
            if (retry?.ok) {
                // The accepted retry is a new startup: give it the full budget,
                // and a fresh prompt if it fails again.
                deadline = deps.now() + startupBudget;
                dirApproved = false;
            } else if (retry && retry.error instanceof V2ApiError && retry.error.status >= 400 && retry.error.status < 500) {
                // Definitive refusal: the relay saw the retry and would not take it.
                const cleanup = await cancelSpawn(deps, v2id);
                throw new SpawnAbandonedError(t('errors.spawnFailed', { reason: st.spawnFailure }), v2id, cleanup);
            }
            continue;
        }
        // Any other spawn failure (clone_failed, agent missing, …) is final:
        // surfacing it now instead of after the 2-minute deadline (#151).
        if (st?.spawnFailure) {
            const cleanup = await cancelSpawn(deps, v2id);
            throw new SpawnAbandonedError(t('errors.spawnFailed', { reason: st.spawnFailure }), v2id, cleanup);
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
    // an agent nobody is waiting for (Astra on 40873bd6) — bounded, and its
    // outcome reported on the error rather than assumed (#416).
    const cleanup = await cancelSpawn(deps, v2id);
    throw new SpawnAbandonedError(t('errors.spawnDidNotStart'), v2id, cleanup);
}

/**
 * v2SpawnAndWait for a USER action (#417) — what every UI "start a session"
 * button calls. When the relay never answered the creation, the user is
 * asked whether to retry: a retry re-drives the SAME action under the
 * error's `creationIntentId`, so the relay replays the session it may
 * already hold instead of accepting a second one. Declining returns null
 * (nothing to navigate to, like a declined directory prompt); the unresolved
 * identity stays retained, so a later press of the same button, or the same
 * action after a restart, still replays it. Every other failure propagates.
 */
export async function v2SpawnInteractive(machineId: string, spec: V2SpawnSpec, overrides: Partial<SpawnDeps> = {}): Promise<string | null> {
    const deps: SpawnDeps = { ...defaultDeps(), ...overrides };
    let creationIntentId = deps.creationIntentId;
    for (;;) {
        try {
            return await v2SpawnAndWait(machineId, spec, { ...deps, creationIntentId });
        } catch (e) {
            if (!(e instanceof SpawnCreationUncertainError)) throw e;
            const retry = await deps.confirm(
                t('newSession.creationUncertainTitle'),
                t('newSession.creationUncertainMessage'),
                { cancelText: t('common.cancel'), confirmText: t('common.retry') },
            );
            if (!retry) return null;
            creationIntentId = e.creationIntentId;
        }
    }
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
