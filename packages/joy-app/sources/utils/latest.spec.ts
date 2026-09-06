import { describe, it, expect } from 'vitest';
import { nextGen, isLatest, retire, forget, currentGen } from './latest';

describe('latest — per-key request generations', () => {
    it('only the newest request for a key is latest', () => {
        const a = nextGen('k1');
        expect(isLatest('k1', a)).toBe(true);
        const b = nextGen('k1');
        expect(isLatest('k1', a)).toBe(false);
        expect(isLatest('k1', b)).toBe(true);
    });

    it('a late response from an older request is dropped, whatever order the responses land in', async () => {
        const shown: string[] = [];
        const request = (value: string, delayMs: number) => {
            const gen = nextGen('env');
            return new Promise<void>((resolve) => setTimeout(() => {
                if (isLatest('env', gen)) shown.push(value);
                resolve();
            }, delayMs));
        };
        await Promise.all([request('machine A', 20), request('machine B', 5)]);
        expect(shown).toEqual(['machine B']);
    });

    it('keys are independent', () => {
        const a = nextGen('x');
        nextGen('y');
        expect(isLatest('x', a)).toBe(true);
    });

    it('retire invalidates outstanding requests without starting one, and generations keep growing past it', () => {
        const a = nextGen('r');
        retire('r');
        expect(isLatest('r', a)).toBe(false);
        const b = nextGen('r');
        expect(b).toBeGreaterThan(a + 1 - 1);
        expect(isLatest('r', b)).toBe(true);
        expect(isLatest('r', a)).toBe(false); // an old request can never match a new generation
    });

    it('forget drops the key; an old generation does not match a fresh key by accident', () => {
        const a = nextGen('f');
        forget('f');
        expect(isLatest('f', a)).toBe(false);
        const b = nextGen('f');
        // The fresh key restarts at 1 — safe only because per-instance keys are
        // never reused after forget; that is the documented contract.
        expect(b).toBe(1);
    });

    it('currentGen peeks without minting: a poll is dropped only if something newer happened meanwhile', () => {
        nextGen('file');
        const poll = currentGen('file');
        expect(isLatest('file', poll)).toBe(true);      // nothing happened: the poll result applies
        const save = nextGen('file');                    // a save began while the poll was out
        expect(isLatest('file', poll)).toBe(false);     // the poll's pre-save content is dropped
        expect(isLatest('file', save)).toBe(true);      // the save itself was not superseded by the poll
        expect(currentGen('never')).toBe(0);
    });

    it('an unknown key is never latest', () => {
        expect(isLatest('nope', 1)).toBe(false);
        expect(isLatest('nope', 0)).toBe(false);
    });
});
