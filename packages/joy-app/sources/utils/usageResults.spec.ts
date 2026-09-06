import { describe, expect, it } from 'vitest';
import { splitUsageResults } from './usageResults';

type Rep = { ok?: boolean; error?: string; cost?: number };

describe('splitUsageResults (#182)', () => {
    it('keeps every failed machine with a reason instead of dropping it', () => {
        const split = splitUsageResults<Rep, null>(['A', 'B', 'C'], [
            { status: 'fulfilled', value: { id: 'A', rep: { ok: true, cost: 10 }, sess: null } },
            { status: 'rejected', reason: new Error('joy-tmux did not respond') },
            { status: 'fulfilled', value: { id: 'C', rep: { ok: false, error: 'no ccusage' }, sess: null } },
        ]);
        expect(split.good.map((g) => g.id)).toEqual(['A']);
        expect(split.failed).toEqual([
            { id: 'B', reason: 'joy-tmux did not respond' },
            { id: 'C', reason: 'no ccusage' },
        ]);
    });

    it('reports nothing failed when every machine answered', () => {
        const split = splitUsageResults<Rep, null>(['A'], [
            { status: 'fulfilled', value: { id: 'A', rep: { ok: true }, sess: null } },
        ]);
        expect(split.failed).toEqual([]);
        expect(split.good).toHaveLength(1);
    });

    it('falls back to a generic reason for a bare ok:false', () => {
        const split = splitUsageResults<Rep, null>(['A'], [
            { status: 'fulfilled', value: { id: 'A', rep: { ok: false }, sess: null } },
        ]);
        expect(split.failed).toEqual([{ id: 'A', reason: 'usage query failed' }]);
    });
});
