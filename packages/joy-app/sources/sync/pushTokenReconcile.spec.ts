import { describe, expect, it, vi } from 'vitest';
import {
    flushPendingUnregister,
    hasPendingCleanup,
    needsDisabledCleanup,
    reconcileRegistration,
    serialized,
    unregisterDevice,
    type PushTokenApi,
    type PushTokenStore,
} from './pushTokenReconcile';

function memoryStore(registered: string | null = null, pending: string[] = []): PushTokenStore & { registered: string | null; pending: string[] } {
    const s = {
        registered,
        pending,
        loadRegistered: () => s.registered,
        saveRegistered: (t: string) => { s.registered = t; },
        clearRegistered: () => { s.registered = null; },
        loadPendingUnregister: () => [...s.pending],
        savePendingUnregister: (t: string[]) => { s.pending = [...t]; },
    };
    return s;
}

function relay(failing: Set<string> = new Set()): PushTokenApi & { tokens: Set<string> } {
    const tokens = new Set<string>();
    return {
        tokens,
        register: async (t) => { tokens.add(t); },
        unregister: async (t) => {
            if (failing.has(t)) throw new Error(`cannot delete ${t}`);
            tokens.delete(t);
        },
    };
}

describe('reconcileRegistration (#385)', () => {
    it('registers the new token and retires the previous one', async () => {
        const api = relay();
        api.tokens.add('A');
        const store = memoryStore('A');
        const r = await reconcileRegistration(api, store, 'B');
        expect(r.pending).toEqual([]);
        expect([...api.tokens]).toEqual(['B']);
        expect(store.registered).toBe('B');
        expect(store.pending).toEqual([]);
    });

    it('persists the old token as pending before saving the new one, so an interrupted replacement is resumed', async () => {
        // Relay refuses the delete (simulates the app dying before A is gone).
        const api = relay(new Set(['A']));
        api.tokens.add('A');
        const store = memoryStore('A');
        const r = await reconcileRegistration(api, store, 'B');
        expect(r.pending).toEqual(['A']);
        expect(store.registered).toBe('B');
        expect(store.pending).toEqual(['A']);
        expect(hasPendingCleanup(store)).toBe(true);

        // Next sync: previous === current === B, yet A is still cleaned up.
        const api2 = relay();
        api2.tokens.add('A');
        api2.tokens.add('B');
        const r2 = await reconcileRegistration(api2, store, 'B');
        expect(r2.pending).toEqual([]);
        expect([...api2.tokens]).toEqual(['B']);
        expect(store.pending).toEqual([]);
    });

    it('a register(B) the relay accepted, then a bookkeeping failure, is still cleaned up after rotating to C (#385 residual)', async () => {
        // Reviewer: intent used to be persisted only AFTER register(B)
        // returned; B was then registered with an empty cleanup list and
        // rotation to C left it on the relay for good.
        const api = relay();
        api.tokens.add('A');
        const store = memoryStore('A');
        const save = store.saveRegistered;
        store.saveRegistered = () => { throw new Error('disk full'); };
        await expect(reconcileRegistration(api, store, 'B')).rejects.toThrow('disk full');
        expect([...api.tokens].sort()).toEqual(['A', 'B']);
        expect(store.registered).toBe('A');
        expect(hasPendingCleanup(store)).toBe(true);

        // "Restart": bookkeeping works again, the device now holds C.
        store.saveRegistered = save;
        const r = await reconcileRegistration(api, store, 'C');
        expect(r.pending).toEqual([]);
        expect([...api.tokens]).toEqual(['C']);
        expect(store.registered).toBe('C');
        expect(store.pending).toEqual([]);
    });

    it('a register request that never succeeded does not retire the token that is still current', async () => {
        const api = relay();
        api.tokens.add('A');
        api.register = async () => { throw new Error('offline'); };
        const store = memoryStore('A');
        await expect(reconcileRegistration(api, store, 'B')).rejects.toThrow('offline');
        expect(store.registered).toBe('A');
        // A is current, so a cleanup pass leaves it alone and forgets B (never registered).
        const api2 = relay();
        api2.tokens.add('A');
        expect(await flushPendingUnregister(api2, store)).toEqual([]);
        expect([...api2.tokens]).toEqual(['A']);
    });

    it('never queues the current token for deletion', async () => {
        const api = relay();
        const store = memoryStore('B', ['B', 'A']);
        await reconcileRegistration(api, store, 'B');
        expect(store.pending).toEqual([]);
        expect(api.tokens.has('B')).toBe(true);
    });

    it('flushPendingUnregister retries leftovers without touching the current token', async () => {
        const api = relay();
        api.tokens.add('A');
        api.tokens.add('B');
        const store = memoryStore('B', ['A', 'B']);
        const pending = await flushPendingUnregister(api, store);
        expect(pending).toEqual([]);
        expect([...api.tokens]).toEqual(['B']);
    });
});

describe('unregisterDevice (#181)', () => {
    it('removes the saved token from the relay and forgets it locally', async () => {
        const api = relay();
        api.tokens.add('A');
        const store = memoryStore('A');
        const r = await unregisterDevice(api, store);
        expect(r).toEqual({ removed: true, pending: [] });
        expect(api.tokens.size).toBe(0);
        expect(store.registered).toBeNull();
    });

    it('keeps the token pending (and locally saved) when the relay cannot be reached', async () => {
        const api = relay(new Set(['A']));
        api.tokens.add('A');
        const store = memoryStore('A');
        const r = await unregisterDevice(api, store);
        expect(r.removed).toBe(false);
        expect(r.pending).toEqual(['A']);
        expect(store.registered).toBe('A');
        expect(hasPendingCleanup(store)).toBe(true);

        // Retry after connectivity returns.
        const api2 = relay();
        api2.tokens.add('A');
        const r2 = await unregisterDevice(api2, store);
        expect(r2.removed).toBe(true);
        expect(store.registered).toBeNull();
        expect(store.pending).toEqual([]);
    });

    it('needsDisabledCleanup: the OFF state has work while a token is saved or pending, none otherwise (#181)', async () => {
        expect(needsDisabledCleanup(memoryStore(null))).toBe(false);
        expect(needsDisabledCleanup(memoryStore('A'))).toBe(true);
        expect(needsDisabledCleanup(memoryStore(null, ['A']))).toBe(true);
        // Reviewer: the disabled startup path used to take no action; the
        // owner now removes the saved token when the setting is off.
        const api = relay();
        api.tokens.add('A');
        const store = memoryStore('A');
        if (needsDisabledCleanup(store)) await unregisterDevice(api, store);
        expect(api.tokens.size).toBe(0);
        expect(needsDisabledCleanup(store)).toBe(false);
    });

    it('is a no-op when nothing was ever registered', async () => {
        const api = relay();
        const store = memoryStore(null);
        const r = await unregisterDevice(api, store);
        expect(r).toEqual({ removed: true, pending: [] });
    });
});

describe('serialized (#386)', () => {
    it('runs overlapping syncs one after another, so an older sync cannot unregister a newer token', async () => {
        const api = relay();
        const store = memoryStore('A');
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const order: string[] = [];

        // First sync: slow token fetch that resolves to the OBSOLETE token B.
        const first = serialized(async () => {
            await firstGate;
            order.push('first');
            return reconcileRegistration(api, store, 'B');
        });
        // Second sync: fast, learns the current token C.
        const second = serialized(async () => {
            order.push('second');
            return reconcileRegistration(api, store, 'C');
        });

        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(['first', 'second']);
        // The last word is the newest sync's: C registered, B retired.
        expect(store.registered).toBe('C');
        expect([...api.tokens]).toEqual(['C']);
    });

    it('keeps going after a failed operation', async () => {
        await expect(serialized(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        const fn = vi.fn(async () => 'ok');
        await expect(serialized(fn)).resolves.toBe('ok');
    });
});
