import { describe, it, expect, vi } from 'vitest';

// In-memory stand-in for the relay-scoped MMKV instance; the module under
// test only needs getString/set/delete for the temp-text helpers.
const store = new Map<string, string>();
vi.mock('./serverConfig', () => ({
    relayScopedMMKV: () => ({
        getString: (k: string) => store.get(k),
        set: (k: string, v: string) => { store.set(k, String(v)); },
        delete: (k: string) => { store.delete(k); },
        getAllKeys: () => Array.from(store.keys()),
        contains: (k: string) => store.has(k),
        clearAll: () => store.clear(),
    }),
    getServerUrl: () => 'https://relay',
}));

import { retrieveTempText, storeTempText } from './persistence';

describe('temp text storage (#383)', () => {
    it('round-trips an empty string and deletes the entry', () => {
        const id = storeTempText('');
        expect(store.size).toBe(1);
        expect(retrieveTempText(id)).toBe('');
        expect(store.size).toBe(0);
        expect(retrieveTempText(id)).toBeNull();
    });

    it('round-trips non-empty text exactly once', () => {
        const id = storeTempText('  hello\n');
        expect(retrieveTempText(id)).toBe('  hello\n');
        expect(retrieveTempText(id)).toBeNull();
    });
});
