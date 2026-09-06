import { describe, it, expect } from 'vitest';
import { keyFromHash, resolvePendingTerminalKey, clearPendingTerminalKey, PENDING_TERMINAL_KEY_STORAGE_KEY } from './pendingTerminalKey';

function memoryStorage() {
    const m = new Map<string, string>();
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => { m.set(k, v); },
        removeItem: (k: string) => { m.delete(k); },
        size: () => m.size,
    };
}

describe('pending terminal key (#183)', () => {
    it('reads the key from the fragment and parks it for the tab', () => {
        const storage = memoryStorage();
        expect(resolvePendingTerminalKey('#key=abc123', storage)).toBe('abc123');
        expect(storage.getItem(PENDING_TERMINAL_KEY_STORAGE_KEY)).toBe('abc123');
    });

    it('survives a reload: with the fragment already scrubbed, the parked key is restored', () => {
        const storage = memoryStorage();
        resolvePendingTerminalKey('#key=abc123', storage);
        expect(resolvePendingTerminalKey('', storage)).toBe('abc123');
    });

    it('a new link replaces the parked key', () => {
        const storage = memoryStorage();
        resolvePendingTerminalKey('#key=old', storage);
        expect(resolvePendingTerminalKey('#key=new', storage)).toBe('new');
        expect(resolvePendingTerminalKey('', storage)).toBe('new');
    });

    it('is forgotten once the request is accepted or rejected', () => {
        const storage = memoryStorage();
        resolvePendingTerminalKey('#key=abc123', storage);
        clearPendingTerminalKey(storage);
        expect(resolvePendingTerminalKey('', storage)).toBeNull();
        expect(storage.size()).toBe(0);
    });

    it('ignores fragments that are not a key and tolerates missing storage', () => {
        expect(keyFromHash('#other=1')).toBeNull();
        expect(keyFromHash('#key=')).toBeNull();
        expect(resolvePendingTerminalKey('#key=abc', null)).toBe('abc');
        expect(resolvePendingTerminalKey('', undefined)).toBeNull();
        expect(() => clearPendingTerminalKey(null)).not.toThrow();
    });

    it('tolerates a storage that throws (privacy mode)', () => {
        const throwing = {
            getItem: () => { throw new Error('denied'); },
            setItem: () => { throw new Error('denied'); },
            removeItem: () => { throw new Error('denied'); },
        };
        expect(resolvePendingTerminalKey('#key=abc', throwing)).toBe('abc');
        expect(resolvePendingTerminalKey('', throwing)).toBeNull();
        expect(() => clearPendingTerminalKey(throwing)).not.toThrow();
    });
});
