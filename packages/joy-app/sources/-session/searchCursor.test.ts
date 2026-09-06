import { describe, it, expect } from 'vitest';
import { reconcileSearchCursor } from './searchCursor';

const m = (...ids: string[]) => ids.map((messageId) => ({ messageId }));

describe('reconcileSearchCursor (#122)', () => {
    it('clamps the cursor when the selected match disappears (3/3 → 2/2)', () => {
        const r = reconcileSearchCursor(m('a', 'b'), 'c', 2);
        expect(r).toEqual({ index: 1, messageId: 'b', scroll: true });
    });

    it('follows the selected message when matches shift under it', () => {
        // A new matching message arrived ahead of the selection.
        const r = reconcileSearchCursor(m('new', 'a', 'b', 'c'), 'b', 1);
        expect(r).toEqual({ index: 2, messageId: 'b', scroll: false });
    });

    it('selects the first hit when nothing is selected yet', () => {
        expect(reconcileSearchCursor(m('a', 'b'), null, 0)).toEqual({ index: 0, messageId: 'a', scroll: true });
    });

    it('resets to an empty cursor when there are no matches', () => {
        expect(reconcileSearchCursor([], 'a', 5)).toEqual({ index: 0, messageId: null, scroll: false });
    });

    it('never produces an out-of-range index', () => {
        expect(reconcileSearchCursor(m('a'), 'zzz', 40).index).toBe(0);
        expect(reconcileSearchCursor(m('a', 'b', 'c'), 'zzz', -3).index).toBe(0);
    });
});
