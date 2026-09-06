import { describe, it, expect, vi } from 'vitest';
import { retire } from '@/utils/latest';
import { createSuggestionSync, reduceSuggestions, type Suggestion } from './useActiveSuggestions';

vi.mock('@/utils/time', () => ({
    backoff: async (fn: () => Promise<void>) => { await fn(); },
}));

const item = (key: string): Suggestion => ({ key, text: key, component: 'span' as unknown as Suggestion['component'] });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferredHandler() {
    const calls: string[] = [];
    const resolvers = new Map<string, (s: Suggestion[]) => void>();
    const handler = (query: string) => {
        calls.push(query);
        return new Promise<Suggestion[]>((resolve) => { resolvers.set(query, resolve); });
    };
    const resolve = (query: string, result: Suggestion[]) => { resolvers.get(query)!(result); };
    return { handler, calls, resolve };
}

let n = 0;
const key = () => `suggestions-test#${++n}`;

describe('useActiveSuggestions — the request worker (#249)', () => {
    it('a worker stopped by an effect cleanup ignores every later query; the replay must build a new one', async () => {
        const requestKey = key();
        const { handler, calls, resolve } = deferredHandler();
        const commit = vi.fn();

        // StrictMode: setup, cleanup, setup again on the same instance.
        const first = createSuggestionSync(requestKey, handler, commit);
        first.setValue('a');
        expect(calls).toEqual(['a']);
        first.stop();
        retire(requestKey);

        // The bug: the memoized worker was kept after being stopped.
        first.setValue('b');
        expect(calls).toEqual(['a']);

        // The fix: the replayed effect owns a fresh worker.
        const second = createSuggestionSync(requestKey, handler, commit);
        second.setValue('b');
        expect(calls).toEqual(['a', 'b']);

        resolve('a', [item('a')]);
        await flush();
        expect(commit).not.toHaveBeenCalled(); // the stopped worker's request was retired
        resolve('b', [item('b')]);
        await flush();
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith([item('b')]);
    });

    it('a query change supersedes a request still awaiting its handler, before the worker runs the new one', async () => {
        const requestKey = key();
        const { handler, calls, resolve } = deferredHandler();
        const commit = vi.fn();
        const sync = createSuggestionSync(requestKey, handler, commit);

        sync.setValue('a');
        // The query effect: retire, then hand the serialized worker the new value.
        retire(requestKey);
        sync.setValue('b');
        expect(calls).toEqual(['a']); // b waits for a — the worker is serialized

        resolve('a', [item('a')]);
        await flush();
        expect(commit).not.toHaveBeenCalled(); // a was superseded the moment b was typed
        expect(calls).toEqual(['a', 'b']);
        resolve('b', [item('b')]);
        await flush();
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith([item('b')]);
    });

    it('a null query runs nothing', async () => {
        const requestKey = key();
        const { handler, calls } = deferredHandler();
        const sync = createSuggestionSync(requestKey, handler, vi.fn());
        sync.setValue(null);
        await flush();
        expect(calls).toEqual([]);
    });
});

describe('reduceSuggestions', () => {
    const opts = { clampSelection: true, autoSelectFirst: true };

    it('auto-selects the first item when suggestions first appear', () => {
        expect(reduceSuggestions({ suggestions: [], selected: -1 }, [item('x'), item('y')], opts)).toEqual({ suggestions: [item('x'), item('y')], selected: 0 });
    });

    it('clamps an out-of-range selection and clears it when the list empties', () => {
        const prev = { suggestions: [item('x'), item('y'), item('z')], selected: 2 };
        expect(reduceSuggestions(prev, [item('x')], opts).selected).toBe(0);
        expect(reduceSuggestions(prev, [], opts).selected).toBe(-1);
    });

    it('without clamping, follows the selected key to its new index', () => {
        const prev = { suggestions: [item('x'), item('y')], selected: 1 };
        expect(reduceSuggestions(prev, [item('y'), item('x')], { clampSelection: false, autoSelectFirst: true }).selected).toBe(0);
    });
});
