/**
 * v2SpawnAndWait / waitForLocalSession against a scripted relay and a virtual
 * clock (every dependency injected through SpawnDeps):
 *   #417 a lost createSession response is retried under the SAME creation
 *        intent, so the relay replays instead of queueing a second session;
 *   #416 a refresh that never settles cannot outlive the deadline;
 *   #415 the deadline pauses while the directory prompt is open and an
 *        accepted retry gets a fresh startup budget.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import _sodium from 'libsodium-wrappers';
import { createHmac } from 'node:crypto';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) }));
// spawn.ts seals the spec (#107): the native libsodium module and the
// hmac primitive get their node stand-ins, as in spawnSpec.spec.ts.
vi.mock('@/encryption/libsodium.lib', async () => { await _sodium.ready; return { default: _sodium }; });
vi.mock('@/encryption/hmac_sha512', () => ({
    hmac_sha512: async (key: Uint8Array, data: Uint8Array) =>
        new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest()),
}));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(async () => true) } }));
vi.mock('@/text', () => ({ t: (k: string, a?: Record<string, string>) => a ? `${k}:${JSON.stringify(a)}` : k }));
vi.mock('@/sync/sync', () => ({ sync: { refreshSessions: vi.fn(async () => { }) } }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: {} }) } }));
vi.mock('@/sync/v2/api', () => {
    class V2ApiError extends Error {
        constructor(public status: number, public code: string, public body: unknown) { super(`v2 ${status}: ${code}`); }
    }
    return { v2: {}, V2ApiError };
});

import { V2ApiError } from '@/sync/v2/api';
import {
    SpawnAbandonedError, SpawnCreationUncertainError, discardUncertainCreation, isRetryableCreateError,
    resetUncertainCreationsForTests, spawnSealKeyFor, uncertainCreationFor, v2SpawnAndWait, waitForLocalSession, type SpawnDeps,
} from './spawn';
import { deriveSpawnSpecKey, openSpawnSpec } from './spawnSpec';

type Sessions = Record<string, { metadata?: { joy__sessionId?: string; v2?: { sessionId?: string; localSessionId?: string; keyEnvelope?: string } } }>;

/** A virtual clock: sleeps advance time instantly, nothing real waits. */
function harness(over: Partial<SpawnDeps> & { sessions?: () => Sessions } = {}) {
    let now = 1_000_000;
    const calls = { create: [] as Array<{ intent: string | undefined; wire?: string }>, retry: 0, refresh: 0, deleted: 0, state: 0 };
    const api: SpawnDeps['api'] = {
        createSession: vi.fn(async (_m: string, _s: unknown, opts?: { creationIntentId?: string; spawnSpecWire?: string }) => {
            calls.create.push({ intent: opts?.creationIntentId, wire: opts?.spawnSpecWire });
            return { sessionId: 'v2-1' };
        }) as unknown as SpawnDeps['api']['createSession'],
        sessionState: vi.fn(async () => { calls.state++; return null as never; }),
        retrySpawn: vi.fn(async () => { calls.retry++; return {}; }),
        deleteSession: vi.fn(async () => { calls.deleted++; return {}; }),
    };
    const deps: SpawnDeps = {
        api,
        refreshSessions: async () => { calls.refresh++; },
        getSessions: () => (over.sessions?.() ?? {}) as never,
        confirm: async () => true,
        now: () => now,
        sleep: async (ms) => { now += ms; },
        sealKeyFor: async () => null,
        ...over,
    };
    return { deps, calls, api, clock: { get: () => now, add: (ms: number) => { now += ms; } } };
}

const bound = (v2id: string): Sessions => ({
    app1: { metadata: { v2: { sessionId: v2id, localSessionId: 'local-1', keyEnvelope: 'env' } } },
});

describe('v2SpawnAndWait', () => {
    beforeEach(() => resetUncertainCreationsForTests());

    it('returns the bound card id once the refresh shows it', async () => {
        let refreshed = 0;
        const h = harness({
            refreshSessions: async () => { refreshed++; },
            sessions: () => refreshed >= 2 ? bound('v2-1') : {},
        });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(h.calls.create).toHaveLength(1);
    });

    it('#417: a lost acceptance response is retried under the SAME creation intent', async () => {
        const h = harness({ sessions: () => bound('v2-1') });
        let n = 0;
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (_m: string, _s: unknown, opts?: { creationIntentId?: string }) => {
            h.calls.create.push({ intent: opts?.creationIntentId });
            if (n++ < 2) throw new TypeError('Network request failed');
            return { sessionId: 'v2-1' };
        });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(h.calls.create).toHaveLength(3);
        const intents = new Set(h.calls.create.map(c => c.intent));
        expect(intents.size).toBe(1);
        expect([...intents][0]).toBeTruthy();
    });

    it('#417: a caller-pinned intent is what reaches the relay', async () => {
        const h = harness({ sessions: () => bound('v2-1'), creationIntentId: 'intent-abc' });
        await v2SpawnAndWait('m', { cwd: '/x' }, h.deps);
        expect(h.calls.create).toMatchObject([{ intent: 'intent-abc' }]);
    });

    it('#417: a definitive relay refusal is not retried', async () => {
        const h = harness();
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            h.calls.create.push({ intent: 'x' });
            throw new V2ApiError(429, 'too_many_sessions', null);
        });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toMatchObject({ code: 'too_many_sessions' });
        expect(h.calls.create).toHaveLength(1);
    });

    it('#417: transient failures stop after the create budget and surface the error', async () => {
        const h = harness();
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            h.calls.create.push({ intent: 'x' });
            throw new V2ApiError(503, 'relay_busy', null);
        });
        const t0 = h.clock.get();
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toMatchObject({ code: 'relay_busy' });
        expect(h.calls.create.length).toBeGreaterThan(1);
        expect(h.clock.get() - t0).toBeLessThanOrEqual(30_000);
    });

    it('#417 residual: the user retrying the SAME action after the create budget replays ONE intent', async () => {
        // Every attempt for 31 s "was accepted but the response was lost";
        // then the relay recovers and the user presses the same button again.
        const accepted = new Set<string>();
        let recovered = false;
        const h = harness({ sessions: () => bound('v2-1') });
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (_m: string, _s: unknown, opts?: { creationIntentId?: string }) => {
            accepted.add(opts!.creationIntentId!);
            if (!recovered) { h.clock.add(31_000); throw new Error('accepted; lost response'); }
            return { sessionId: 'v2-1' };
        });
        const failure = await v2SpawnAndWait('m', { cwd: '/x' }, h.deps).catch(e => e);
        expect(failure).toBeInstanceOf(SpawnCreationUncertainError);
        expect(accepted.has(failure.creationIntentId)).toBe(true);
        // The identity outlives the failed invocation, addressed by the action.
        expect(uncertainCreationFor('m', { cwd: '/x' }, h.clock.get())?.creationIntentId).toBe(failure.creationIntentId);
        recovered = true;
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(accepted.size).toBe(1);
        // Resolved by the accepted answer: nothing left to replay.
        expect(uncertainCreationFor('m', { cwd: '/x' }, h.clock.get())).toBeNull();
    });

    it('#417: the UI can pin the id from the error, and a distinct action gets its own', async () => {
        const seen: string[] = [];
        let fail = true;
        const h = harness({ sessions: () => bound('v2-1') });
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (_m: string, _s: unknown, opts?: { creationIntentId?: string }) => {
            seen.push(opts!.creationIntentId!);
            if (fail) { h.clock.add(31_000); throw new TypeError('Network request failed'); }
            return { sessionId: 'v2-1' };
        });
        const failure = (await v2SpawnAndWait('m', { cwd: '/x' }, h.deps).catch(e => e)) as SpawnCreationUncertainError;
        fail = false;
        // Explicit retry of the shown failure.
        await v2SpawnAndWait('m', { cwd: '/x' }, { ...h.deps, creationIntentId: failure.creationIntentId });
        expect(new Set(seen).size).toBe(1);
        // A different spec is a different action: a new id.
        await v2SpawnAndWait('m', { cwd: '/y' }, h.deps);
        expect(new Set(seen).size).toBe(2);
    });

    it('#417: discarding the uncertain creation makes the next spawn a new one', async () => {
        const seen: string[] = [];
        let fail = true;
        const h = harness({ sessions: () => bound('v2-1') });
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (_m: string, _s: unknown, opts?: { creationIntentId?: string }) => {
            seen.push(opts!.creationIntentId!);
            if (fail) { h.clock.add(31_000); throw new TypeError('Network request failed'); }
            return { sessionId: 'v2-1' };
        });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toBeInstanceOf(SpawnCreationUncertainError);
        fail = false;
        discardUncertainCreation('m', { cwd: '/x' });
        await v2SpawnAndWait('m', { cwd: '/x' }, h.deps);
        expect(new Set(seen).size).toBe(2);
    });

    it('#417: a definitive refusal resolves the creation — nothing is replayed later', async () => {
        const h = harness({ sessions: () => bound('v2-1') });
        (h.api.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new V2ApiError(429, 'too_many_sessions', null); });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toMatchObject({ code: 'too_many_sessions' });
        expect(uncertainCreationFor('m', { cwd: '/x' }, h.clock.get())).toBeNull();
    });

    it('#416: a createSession POST that never answers is bounded and ends as an uncertain creation', async () => {
        const h = harness();
        h.api.createSession = (() => new Promise(() => { })) as never;
        const t0 = h.clock.get();
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toBeInstanceOf(SpawnCreationUncertainError);
        expect(h.clock.get() - t0).toBeLessThanOrEqual(30_000 + 10_000);
    });

    it('#416 residual: a cleanup DELETE that never settles cannot strand the waiter; the error says so', async () => {
        const h = harness({ refreshSessions: () => new Promise(() => { }) });
        let deleting = false;
        h.api.deleteSession = (() => { deleting = true; return new Promise(() => { }); }) as never;
        const t0 = h.clock.get();
        const failure = await v2SpawnAndWait('m', { cwd: '/x' }, h.deps).catch(e => e);
        expect(deleting).toBe(true);
        expect(failure).toBeInstanceOf(SpawnAbandonedError);
        expect(failure.cleanup).toBe('uncertain');
        expect(failure.v2SessionId).toBe('v2-1');
        expect(failure.message).toMatch(/spawnDidNotStart/);
        expect(h.clock.get() - t0).toBeLessThan(120_000 + 30_000);
    });

    it('#416: an acknowledged cleanup is reported as done', async () => {
        const h = harness({ refreshSessions: async () => { } });
        const failure = await v2SpawnAndWait('m', { cwd: '/x' }, h.deps).catch(e => e);
        expect(failure).toBeInstanceOf(SpawnAbandonedError);
        expect(failure.cleanup).toBe('done');
        expect(h.calls.deleted).toBe(1);
    });

    it('#416: a retrySpawn that hangs is bounded and re-sent on the next poll without asking again', async () => {
        let confirms = 0;
        let retries = 0;
        let landed = false;
        const h = harness({
            confirm: async () => { confirms++; return true; },
            refreshSessions: async () => { },
            sessions: () => (landed ? bound('v2-1') : {}),
        });
        h.api.sessionState = vi.fn(async () => (landed ? null : { spawnFailure: 'dir_missing:/x' }) as never);
        h.api.retrySpawn = (() => {
            retries++;
            if (retries === 1) return new Promise(() => { }); // never answers
            landed = true;
            return Promise.resolve({});
        }) as never;
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(confirms).toBe(1);
        expect(retries).toBe(2);
    });

    it('#416: a refresh that never settles cannot hold the waiter past the deadline', async () => {
        const h = harness({ refreshSessions: () => new Promise(() => { }) });
        const t0 = h.clock.get();
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toThrow(/spawnDidNotStart/);
        // Deadline honoured within one poll+step of 120 s, and the accepted
        // spawn was cancelled so no orphan agent starts. (The virtual clock
        // also charges the create attempt's and the cleanup's 10 s race caps
        // up front, since a virtual sleep advances time even when the network
        // promise wins the race — #416.)
        expect(h.clock.get() - t0).toBeLessThan(120_000 + 35_000);
        expect(h.calls.deleted).toBe(1);
    });

    it('#416: a sessionState call that hangs is bounded the same way', async () => {
        const h = harness({ refreshSessions: async () => { } });
        h.api.sessionState = () => new Promise(() => { });
        const t0 = h.clock.get();
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toThrow(/spawnDidNotStart/);
        expect(h.clock.get() - t0).toBeLessThan(120_000 + 25_000);
    });

    it('#415: a directory prompt left open past the deadline still polls the accepted retry', async () => {
        let retried = false;
        let refreshesAfterRetry = 0;
        const h = harness({
            confirm: async () => { h.clock.add(3 * 60_000); return true; }, // user thinks for 3 minutes
            refreshSessions: async () => { if (retried) refreshesAfterRetry++; },
            sessions: () => refreshesAfterRetry >= 3 ? bound('v2-1') : {},
        });
        h.api.sessionState = vi.fn(async () => (retried ? null : { spawnFailure: 'dir_missing:/x' }) as never);
        h.api.retrySpawn = vi.fn(async () => { retried = true; return {}; });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(h.api.retrySpawn).toHaveBeenCalledWith('v2-1', true);
        expect(refreshesAfterRetry).toBeGreaterThanOrEqual(3);
        expect(h.calls.deleted).toBe(0);
    });

    it('#415: an accepted retry gets a fresh startup budget, not the remainder', async () => {
        // 110 s elapse before dir_missing is seen; the retry must still be
        // allowed ~120 s of its own rather than the 10 s left over.
        let retried = false;
        let retryAt = 0;
        let bindAt = 0;
        const h = harness({
            refreshSessions: async () => { },
            sessions: () => (retried && h.clock.get() >= bindAt ? bound('v2-1') : {}),
        });
        const start = h.clock.get();
        h.api.sessionState = vi.fn(async () => {
            if (retried) return null as never;
            return (h.clock.get() - start >= 110_000 ? { spawnFailure: 'dir_missing:/x' } : null) as never;
        });
        h.api.retrySpawn = vi.fn(async () => { retried = true; retryAt = h.clock.get(); bindAt = retryAt + 90_000; return {}; });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(h.clock.get() - retryAt).toBeGreaterThanOrEqual(90_000);
    });

    it('declining the directory prompt deletes the session and returns null', async () => {
        const h = harness({ confirm: async () => false });
        h.api.sessionState = vi.fn(async () => ({ spawnFailure: 'dir_missing:/x' }) as never);
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBeNull();
        expect(h.calls.deleted).toBe(1);
        expect(h.calls.retry).toBe(0);
    });

    it('a non-directory spawn failure is final', async () => {
        const h = harness();
        h.api.sessionState = vi.fn(async () => ({ spawnFailure: 'clone_failed:boom' }) as never);
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toThrow(/spawnFailed/);
        expect(h.calls.deleted).toBe(1);
    });
});

describe('waitForLocalSession', () => {
    it('#416: honours its timeout even when refresh never settles', async () => {
        const h = harness({ refreshSessions: () => new Promise(() => { }) });
        const t0 = h.clock.get();
        await expect(waitForLocalSession('local-9', 20_000, h.deps)).resolves.toBeNull();
        expect(h.clock.get() - t0).toBeLessThan(20_000 + 12_000);
    });

    it('finds the card by the daemon-local id', async () => {
        const h = harness({
            sessions: () => ({ appZ: { metadata: { joy__sessionId: 'local-9', v2: { keyEnvelope: 'e' } } } }),
        });
        await expect(waitForLocalSession('local-9', 20_000, h.deps)).resolves.toBe('appZ');
    });
});

describe('isRetryableCreateError', () => {
    it('replays network errors and gateway 5xx, not 4xx refusals', () => {
        expect(isRetryableCreateError(new TypeError('Network request failed'))).toBe(true);
        expect(isRetryableCreateError(new V2ApiError(503, 'relay_busy', null))).toBe(true);
        expect(isRetryableCreateError(new V2ApiError(502, 'http_502', null))).toBe(true);
        expect(isRetryableCreateError(new V2ApiError(409, 'idempotency_mismatch', null))).toBe(false);
        expect(isRetryableCreateError(new V2ApiError(401, 'not_logged_in', null))).toBe(false);
        expect(isRetryableCreateError(new V2ApiError(500, 'internal', null))).toBe(false);
    });
});

describe('#107 spawn-spec sealing', () => {
    beforeEach(() => resetUncertainCreationsForTests());
    const machineKey = new Uint8Array(32).fill(7);

    it('spawnSealKeyFor: the spawn-spec key only when the daemon advertises spawnSpecSealed AND the machine key is known', async () => {
        const advertising = { metadata: { capabilities: { spawnSpecSealed: true } } };
        const key = await spawnSealKeyFor('m1', { machine: () => advertising, machineKey: () => machineKey });
        expect(key).toEqual(await deriveSpawnSpecKey(machineKey, 'm1'));
        // an older daemon (no capabilities block), one that says false, or no synced record → plain
        expect(await spawnSealKeyFor('m1', { machine: () => ({ metadata: { homeDir: '/h' } as never }), machineKey: () => machineKey })).toBeNull();
        expect(await spawnSealKeyFor('m1', { machine: () => ({ metadata: { capabilities: { spawnSpecSealed: false } } }), machineKey: () => machineKey })).toBeNull();
        expect(await spawnSealKeyFor('m1', { machine: () => undefined, machineKey: () => machineKey })).toBeNull();
        // capability advertised but the app holds no key for the machine → plain (the daemon accepts it)
        expect(await spawnSealKeyFor('m1', { machine: () => advertising, machineKey: () => null })).toBeNull();
    });

    it('sends the plain JSON form when there is no seal key', async () => {
        const h = harness({ sessions: () => bound('v2-1') });
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).resolves.toBe('app1');
        expect(h.calls.create[0].wire).toBe(JSON.stringify({ v: 1, t: 'spawn', cwd: '/x' }));
    });

    it('seals under the machine key and re-sends the IDENTICAL envelope on a lost-response retry (the relay hashes the spec into the intent)', async () => {
        const key = await deriveSpawnSpecKey(machineKey, 'm');
        const h = harness({ sessions: () => bound('v2-1'), sealKeyFor: async () => key });
        let first = true;
        h.api.createSession = vi.fn(async (_m: string, _s: unknown, opts?: { creationIntentId?: string; spawnSpecWire?: string }) => {
            h.calls.create.push({ intent: opts?.creationIntentId, wire: opts?.spawnSpecWire });
            if (first) { first = false; throw new V2ApiError(503, 'relay_restarting', null); }
            return { sessionId: 'v2-1' };
        }) as never;
        await expect(v2SpawnAndWait('m', { cwd: '/x', extraArgs: '--flag' }, h.deps)).resolves.toBe('app1');
        expect(h.calls.create).toHaveLength(2);
        const wire = h.calls.create[0].wire!;
        expect(wire.startsWith('v2e1:')).toBe(true);
        expect(wire).not.toContain('/x');
        expect(wire).not.toContain('--flag');
        expect(h.calls.create[1].wire).toBe(wire);
        expect(h.calls.create[1].intent).toBe(h.calls.create[0].intent);
        expect(openSpawnSpec(wire, key)).toEqual({ v: 1, t: 'spawn', cwd: '/x', extraArgs: '--flag' });
    });

    it('a replay of an UNCERTAIN creation re-sends the envelope that intent was created with, not a re-sealed one', async () => {
        const key = await deriveSpawnSpecKey(machineKey, 'm');
        const h = harness({ sessions: () => bound('v2-1'), sealKeyFor: async () => key });
        h.api.createSession = vi.fn(async () => { throw new V2ApiError(503, 'down', null); }) as never;
        const failure = await v2SpawnAndWait('m', { cwd: '/x' }, h.deps).catch(e => e);
        expect(failure).toBeInstanceOf(SpawnCreationUncertainError);
        const retained = uncertainCreationFor('m', { cwd: '/x' }, h.clock.get())!;
        expect(retained.spawnSpecWire?.startsWith('v2e1:')).toBe(true);
        // the user retries the same action: same intent, same bytes
        h.api.createSession = vi.fn(async (_m: string, _s: unknown, opts?: { creationIntentId?: string; spawnSpecWire?: string }) => {
            h.calls.create.push({ intent: opts?.creationIntentId, wire: opts?.spawnSpecWire });
            return { sessionId: 'v2-1' };
        }) as never;
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, { ...h.deps, creationIntentId: failure.creationIntentId })).resolves.toBe('app1');
        const last = h.calls.create[h.calls.create.length - 1];
        expect(last.intent).toBe(retained.creationIntentId);
        expect(last.wire).toBe(retained.spawnSpecWire);
        // a DIFFERENT action seals afresh under a new intent
        await v2SpawnAndWait('m', { cwd: '/y' }, h.deps);
        const other = h.calls.create[h.calls.create.length - 1];
        expect(other.intent).not.toBe(retained.creationIntentId);
        expect(other.wire).not.toBe(retained.spawnSpecWire);
        expect(openSpawnSpec(other.wire, key)).toEqual({ v: 1, t: 'spawn', cwd: '/y' });
    });
});
