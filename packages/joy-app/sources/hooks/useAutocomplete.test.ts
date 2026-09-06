import { describe, it, expect } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';
import { useAutocomplete, type AutocompleteResult } from './useAutocomplete';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Resolver = (text: string) => Promise<AutocompleteResult[]>;

function namedResolver(name: string, calls: string[]): Resolver {
    return async (text) => { calls.push(`${name}:${text}`); return [{ text: `${name}-${text}` }]; };
}

async function mount(query: string | null, resolver: Resolver) {
    let latest: AutocompleteResult[] = [];
    let setProps: (p: { query: string | null; resolver: Resolver }) => void = () => {};
    function Host() {
        const [p, set] = React.useState({ query, resolver });
        setProps = set;
        latest = useAutocomplete(p.query, p.resolver);
        return null;
    }
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Host)); });
    return {
        results: () => latest,
        set: (p: { query: string | null; resolver: Resolver }) => act(async () => { setProps(p); }),
        unmount: () => act(async () => { root.unmount(); }),
    };
}

describe('useAutocomplete resolver changes (#308)', () => {
    it('re-runs the current query on the NEW resolver and drops the old cache', async () => {
        const calls: string[] = [];
        const a = namedResolver('A', calls);
        const b = namedResolver('B', calls);
        const h = await mount('one', a);
        expect(h.results()).toEqual([{ text: 'A-one' }]);

        await h.set({ query: 'one', resolver: b });
        expect(h.results()).toEqual([{ text: 'B-one' }]);

        await h.set({ query: 'two', resolver: b });
        expect(h.results()).toEqual([{ text: 'B-two' }]);
        expect(calls).toEqual(['A:one', 'B:one', 'B:two']);
        await h.unmount();
    });

    it('does not publish a lookup that was in flight on the old resolver', async () => {
        const calls: string[] = [];
        let releaseA: (() => void) | null = null;
        const slowA: Resolver = (text) => new Promise((resolve) => {
            calls.push(`A:${text}`);
            releaseA = () => resolve([{ text: `A-${text}` }]);
        });
        const b = namedResolver('B', calls);
        const h = await mount('one', slowA);
        expect(h.results()).toEqual([]);

        // The worker runs one lookup at a time: B's lookup is queued behind
        // A's. Nothing is published until A settles...
        await h.set({ query: 'one', resolver: b });
        expect(h.results()).toEqual([]);
        // ...and when it does, A's answer is discarded and B's is published.
        await act(async () => { releaseA!(); });
        expect(h.results()).toEqual([{ text: 'B-one' }]);
        expect(calls).toEqual(['A:one', 'B:one']);
        await h.unmount();
    });

    it('a same-identity resolver re-render keeps the cache', async () => {
        const calls: string[] = [];
        const a = namedResolver('A', calls);
        const h = await mount('one', a);
        await h.set({ query: 'two', resolver: a });
        await h.set({ query: 'one', resolver: a });
        expect(calls).toEqual(['A:one', 'A:two']);
        await h.unmount();
    });
});
