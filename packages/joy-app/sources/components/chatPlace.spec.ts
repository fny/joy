import { describe, expect, it } from 'vitest';
import { anchorAt, offsetForRowTop, reanchor, restoreTopFor, rowAt, rowTopFor, type PlaceList, type RowLayout } from './chatPlace';

/** A list of rows: key, message id, height; y is cumulative. */
function list(rows: Array<{ key: string; msg?: string; h: number; contains?: string[] }>): PlaceList {
    const ys: number[] = [];
    let y = 0;
    for (const r of rows) { ys.push(y); y += r.h; }
    return {
        count: rows.length,
        indexOfKey: (k) => rows.findIndex((r) => r.key === k),
        indexOfMessage: (m) => rows.findIndex((r) => r.msg === m || (r.contains ?? []).includes(m)),
        keyAt: (i) => rows[i]?.key,
        messageIdAt: (i) => rows[i]?.msg ?? null,
        layout: (i): RowLayout | undefined => (rows[i] ? { y: ys[i], height: rows[i].h } : undefined),
    };
}

describe('reanchor', () => {
    const before = list([{ key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 200 }, { key: 'c', msg: 'c', h: 300 }]);
    const anchor = anchorAt(2, before)!; // row c at y=300

    it('a row above growing (measured taller than its estimate) shifts by exactly the growth', () => {
        const after = list([{ key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 450 }, { key: 'c', msg: 'c', h: 300 }]);
        expect(reanchor(anchor, after)).toEqual({ anchor: { key: 'c', messageId: 'c', y: 550 }, delta: 250 });
    });

    it('an older page prepended above shifts by the page height', () => {
        const after = list([{ key: 'o1', h: 700 }, { key: 'o2', h: 500 }, { key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 200 }, { key: 'c', msg: 'c', h: 300 }]);
        expect(reanchor(anchor, after).delta).toBe(1200);
    });

    it('growth below the anchor (a streamed reply) does not shift', () => {
        const after = list([{ key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 200 }, { key: 'c', msg: 'c', h: 900 }, { key: 'd', h: 400 }]);
        expect(reanchor(anchor, after).delta).toBe(0);
    });

    it('a fold above (rows replaced by one work row) shifts up by what disappeared', () => {
        const after = list([{ key: 'work-a', h: 40, contains: ['a', 'b'] }, { key: 'c', msg: 'c', h: 300 }]);
        expect(reanchor(anchor, after).delta).toBe(40 - 300);
    });

    it('the anchor row itself regrouped is followed through its message', () => {
        const after = list([{ key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 200 }, { key: 'group-c', h: 500, contains: ['c', 'c2'] }]);
        expect(reanchor(anchor, after)).toEqual({ anchor: { key: 'group-c', messageId: 'c', y: 300 }, delta: 0 });
    });

    it('an anchor that is gone for good ends with no shift — never a jump to the bottom', () => {
        const after = list([{ key: 'a', msg: 'a', h: 100 }, { key: 'b', msg: 'b', h: 200 }]);
        expect(reanchor(anchor, after)).toEqual({ anchor: null, delta: 0 });
    });
});

describe('jump geometry', () => {
    it('rowTopFor matches FlashList scrollToIndex semantics', () => {
        expect(rowTopFor(0, 0, 800, 100)).toBe(0);               // top
        expect(rowTopFor(0, 120, 800, 100)).toBe(-120);          // restore: intra offset into the row
        expect(rowTopFor(0.3, 0, 800, 100)).toBeCloseTo(210);    // coarse search
        expect(rowTopFor(0, 50 - 0.3 * (800 - 20), 800, 20)).toBeCloseTo(0.3 * 780 - 50); // measured hit at y=50
    });

    it('offsetForRowTop includes the header and never goes negative', () => {
        expect(offsetForRowTop(100, 1000, 0)).toBe(1100);
        expect(offsetForRowTop(100, 1000, 200)).toBe(900);
        expect(offsetForRowTop(100, 0, 500)).toBe(0);
    });
});

describe('rowAt', () => {
    const l = list([{ key: 'a', h: 100 }, { key: 'b', h: 200 }, { key: 'c', h: 300 }]);
    it('finds the row containing the viewport top', () => {
        expect(rowAt(0, l)).toBe(0);
        expect(rowAt(99, l)).toBe(0);
        expect(rowAt(100, l)).toBe(1);
        expect(rowAt(450, l)).toBe(2);
        expect(rowAt(5000, l)).toBe(2);
    });
    it('above the first row (the header) is the first row', () => {
        expect(rowAt(-80, l)).toBe(0);
    });
});

describe('restoreTopFor', () => {
    it('brings an unmeasured row to the top first, then applies the offset into it', () => {
        const top = restoreTopFor(1500);
        expect(top(100, false)).toBe(0);
        expect(top(2000, true)).toBe(-1500);
    });
    it('clamps to a row that became shorter while away', () => {
        expect(restoreTopFor(1500)(400, true)).toBe(-399);
    });
    it('keeps a visible header gap (negative offset) as is', () => {
        expect(restoreTopFor(-60)(400, false)).toBe(60);
        expect(restoreTopFor(-60)(400, true)).toBe(60);
    });
});
