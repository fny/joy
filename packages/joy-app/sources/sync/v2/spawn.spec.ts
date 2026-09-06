/**
 * v2SpawnAndWait / waitForLocalSession against a scripted relay and a virtual
 * clock (every dependency injected through SpawnDeps):
 *   #417 a lost createSession response is retried under the SAME creation
 *        intent, so the relay replays instead of queueing a second session;
 *   #416 a refresh that never settles cannot outlive the deadline;
 *   #415 the deadline pauses while the directory prompt is open and an
 *        accepted retry gets a fresh startup budget.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) }));
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
import { isRetryableCreateError, v2SpawnAndWait, waitForLocalSession, type SpawnDeps } from './spawn';

type Sessions = Record<string, { metadata?: { joy__sessionId?: string; v2?: { sessionId?: string; localSessionId?: string; keyEnvelope?: string } } }>;

/** A virtual clock: sleeps advance time instantly, nothing real waits. */
function harness(over: Partial<SpawnDeps> & { sessions?: () => Sessions } = {}) {
    let now = 1_000_000;
    const calls = { create: [] as Array<{ intent: string | undefined }>, retry: 0, refresh: 0, deleted: 0, state: 0 };
    const api: SpawnDeps['api'] = {
        createSession: vi.fn(async (_m: string, _s: unknown, opts?: { creationIntentId?: string }) => {
            calls.create.push({ intent: opts?.creationIntentId });
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
        ...over,
    };
    return { deps, calls, api, clock: { get: () => now, add: (ms: number) => { now += ms; } } };
}

const bound = (v2id: string): Sessions => ({
    app1: { metadata: { v2: { sessionId: v2id, localSessionId: 'local-1', keyEnvelope: 'env' } } },
});

describe('v2SpawnAndWait', () => {
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
        expect(h.calls.create).toEqual([{ intent: 'intent-abc' }]);
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

    it('#416: a refresh that never settles cannot hold the waiter past the deadline', async () => {
        const h = harness({ refreshSessions: () => new Promise(() => { }) });
        const t0 = h.clock.get();
        await expect(v2SpawnAndWait('m', { cwd: '/x' }, h.deps)).rejects.toThrow(/spawnDidNotStart/);
        // Deadline honoured within one poll+step of 120 s, and the accepted
        // spawn was cancelled so no orphan agent starts.
        expect(h.clock.get() - t0).toBeLessThan(120_000 + 15_000);
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
