import { describe, expect, it } from 'vitest';
import { appendWithinLimit } from './attachmentLimit';

describe('appendWithinLimit (#320)', () => {
    it('appends everything while there is room', () => {
        expect(appendWithinLimit(['a'], ['b', 'c'], 5)).toEqual({ next: ['a', 'b', 'c'], dropped: [] });
    });

    it('reports the overflow instead of silently dropping it', () => {
        expect(appendWithinLimit(['a', 'b'], ['c', 'd', 'e'], 3)).toEqual({ next: ['a', 'b', 'c'], dropped: ['d', 'e'] });
    });

    it('drops the whole batch when the set is already full', () => {
        expect(appendWithinLimit(['a', 'b', 'c'], ['d'], 3)).toEqual({ next: ['a', 'b', 'c'], dropped: ['d'] });
        expect(appendWithinLimit(['a', 'b', 'c', 'd'], ['e'], 3)).toEqual({ next: ['a', 'b', 'c', 'd'], dropped: ['e'] });
    });
});
