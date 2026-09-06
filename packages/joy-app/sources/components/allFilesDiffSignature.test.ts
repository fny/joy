import { describe, expect, it } from 'vitest';
import { diffSignature, rowsByPath } from './allFilesDiffSignature';

describe('diffSignature (#199)', () => {
    const untracked = { status: 'untracked', isStaged: false, lines: 'unavailable' as const };

    it('changes with the repository revision even when status and counts are identical', () => {
        expect(diffSignature([untracked], 1)).not.toBe(diffSignature([untracked], 2));
        const tracked = { status: 'modified', isStaged: false, lines: { added: 1, removed: 1 } };
        expect(diffSignature([tracked], 3)).not.toBe(diffSignature([tracked], 4));
    });

    it('is stable for the same rows and revision, whatever their order', () => {
        const a = { status: 'modified', isStaged: true, lines: { added: 2, removed: 0 } };
        const b = { status: 'modified', isStaged: false, lines: { added: 1, removed: 3 } };
        expect(diffSignature([a, b], 1)).toBe(diffSignature([b, a], 1));
    });

    it('sees a change to the unstaged portion of a partially-staged file', () => {
        const staged = { status: 'modified', isStaged: true, lines: { added: 2, removed: 0 } };
        const before = { status: 'modified', isStaged: false, lines: { added: 1, removed: 3 } };
        const after = { status: 'modified', isStaged: false, lines: { added: 5, removed: 3 } };
        expect(diffSignature([staged, before], 1)).not.toBe(diffSignature([staged, after], 1));
    });
});

describe('rowsByPath', () => {
    it('groups staged and unstaged rows under one identity path', () => {
        const rows = [
            { fullPath: 'a.ts', isStaged: true },
            { fullPath: 'b.ts', isStaged: false },
            { fullPath: 'a.ts', isStaged: false },
        ];
        const map = rowsByPath(rows);
        expect(map.get('a.ts')).toEqual([rows[0], rows[2]]);
        expect(map.get('b.ts')).toEqual([rows[1]]);
    });
});
