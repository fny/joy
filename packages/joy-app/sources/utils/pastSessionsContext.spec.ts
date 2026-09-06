import { describe, it, expect } from 'vitest';
import { pastSessionsContextKey } from './pastSessionsContext';
import { nextGen, isLatest } from './latest';

describe('pastSessionsContextKey (#153)', () => {
    it('changes when the machine, the directory or the harness changes', () => {
        const a = pastSessionsContextKey({ machineId: 'm1', cwd: '/home/u/a', agent: 'claude' });
        expect(pastSessionsContextKey({ machineId: 'm1', cwd: '/home/u/a', agent: 'claude' })).toBe(a);
        expect(pastSessionsContextKey({ machineId: 'm2', cwd: '/home/u/a', agent: 'claude' })).not.toBe(a);
        expect(pastSessionsContextKey({ machineId: 'm1', cwd: '/home/u/b', agent: 'claude' })).not.toBe(a);
        expect(pastSessionsContextKey({ machineId: 'm1', cwd: '/home/u/a', agent: 'opencode' })).not.toBe(a);
    });

    it('a response for the previous context is dropped once the context moved on', async () => {
        const shown: string[] = [];
        const load = (rows: string[], delay: number) => {
            const gen = nextGen('past');
            return new Promise<void>((r) => setTimeout(() => { if (isLatest('past', gen)) shown.push(...rows); r(); }, delay));
        };
        const slowA = load(['A-row'], 20);
        nextGen('past'); // the user changed the directory: retire A's request
        const fastB = load(['B-row'], 5);
        await Promise.all([slowA, fastB]);
        expect(shown).toEqual(['B-row']);
    });
});
