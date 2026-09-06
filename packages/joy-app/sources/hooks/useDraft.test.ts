import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A tiny stand-in for the session store: drafts live in `sessions[id].draft`
// and updateSessionDraft writes them (null clears), exactly what useDraft
// reads and writes.
const store: { sessions: Record<string, { draft: string | null }> } = { sessions: {} };
const updateSessionDraft = vi.fn((sessionId: string, draft: string | null) => {
    store.sessions[sessionId] = { draft };
});
vi.mock('@/sync/storage', () => ({ storage: { getState: () => ({ sessions: store.sessions, updateSessionDraft }) } }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));

import { useDraft } from './useDraft';

/** Host that mirrors ChatComposer but with an INLINE onChange (a fresh
 *  identity every render) — the shape that triggered #315. */
function makeHost(sessionId: string) {
    const calls: string[] = [];
    let setValue: (v: string) => void = () => {};
    let value = '';
    function Host() {
        const [v, set] = React.useState('');
        value = v;
        setValue = set;
        useDraft(sessionId, v, (next) => { calls.push(next); set(next); });
        return null;
    }
    return { Host, calls, getValue: () => value, setValue: (v: string) => setValue(v) };
}

describe('useDraft (#315)', () => {
    beforeEach(() => {
        store.sessions = {};
        updateSessionDraft.mockClear();
    });

    it('restores a saved draft once on mount', async () => {
        store.sessions.s1 = { draft: 'saved text' };
        const h = makeHost('s1');
        let root!: ReturnType<typeof create>;
        await act(async () => { root = create(React.createElement(h.Host)); });
        expect(h.calls).toEqual(['saved text']);
        expect(h.getValue()).toBe('saved text');
        await act(async () => { root.unmount(); });
    });

    it('does not resurrect the draft when the user clears the input and onChange is recreated', async () => {
        store.sessions.s1 = { draft: 'saved text' };
        const h = makeHost('s1');
        let root!: ReturnType<typeof create>;
        await act(async () => { root = create(React.createElement(h.Host)); });
        expect(h.getValue()).toBe('saved text');

        // Delete everything: value '' re-renders the host with a NEW inline
        // onChange while storage still holds the old draft.
        await act(async () => { h.setValue(''); });

        expect(h.getValue()).toBe('');
        expect(h.calls).toEqual(['saved text']); // no second restore
        // The empty transition saved immediately, clearing storage.
        expect(updateSessionDraft).toHaveBeenLastCalledWith('s1', '');
        expect(store.sessions.s1.draft).toBe('');
        await act(async () => { root.unmount(); });
    });

    it('still re-loads when the session changes', async () => {
        store.sessions.a = { draft: 'draft a' };
        store.sessions.b = { draft: 'draft b' };
        const calls: string[] = [];
        let setSession: (s: string) => void = () => {};
        function Host() {
            const [sid, setSid] = React.useState('a');
            const [v, set] = React.useState('');
            setSession = (s) => { set(''); setSid(s); };
            useDraft(sid, v, (next) => { calls.push(next); set(next); });
            return null;
        }
        let root!: ReturnType<typeof create>;
        await act(async () => { root = create(React.createElement(Host)); });
        await act(async () => { setSession('b'); });
        expect(calls).toEqual(['draft a', 'draft b']);
        await act(async () => { root.unmount(); });
    });
});
