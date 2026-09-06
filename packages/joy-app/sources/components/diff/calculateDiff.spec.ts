import { describe, it, expect } from 'vitest';
import { calculateUnifiedDiff, DiffHunk, getPatchDiffStats } from './calculateDiff';

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);
const withReplaced = (lines: string[], ...at: number[]) =>
    lines.map((l, i) => (at.includes(i + 1) ? `${l} changed` : l));

// Every hunk must be a contiguous span of the old file: consecutive old line
// numbers (removed/context lines) without holes.
function oldLineNumbers(hunk: DiffHunk): number[] {
    return hunk.lines.filter(l => l.oldLineNumber !== undefined).map(l => l.oldLineNumber!);
}
function expectContiguous(hunk: DiffHunk) {
    const nums = oldLineNumbers(hunk);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1);
    expect(hunk.oldLines).toBe(nums.length);
    expect(hunk.oldStart).toBe(nums[0]);
}

describe('calculateUnifiedDiff hunks (#252)', () => {
    it('changes whose context windows are separated by a gap become two hunks, both complete', () => {
        const oldText = numbered(30).join('\n');
        const newText = withReplaced(numbered(30), 5, 14).join('\n');
        const { hunks } = calculateUnifiedDiff(oldText, newText, 3);
        expect(hunks).toHaveLength(2);
        hunks.forEach(expectContiguous);
        expect(oldLineNumbers(hunks[0])).toEqual([2, 3, 4, 5, 6, 7, 8]);
        expect(oldLineNumbers(hunks[1])).toEqual([11, 12, 13, 14, 15, 16, 17]);
    });

    it('windows that touch merge into one hunk with no interior lines missing', () => {
        const oldText = numbered(30).join('\n');
        const newText = withReplaced(numbered(30), 5, 12).join('\n');
        const { hunks } = calculateUnifiedDiff(oldText, newText, 3);
        expect(hunks).toHaveLength(1);
        expectContiguous(hunks[0]);
        expect(oldLineNumbers(hunks[0])).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });

    it('overlapping windows merge without duplicating lines', () => {
        const oldText = numbered(30).join('\n');
        const newText = withReplaced(numbered(30), 5, 8).join('\n');
        const { hunks } = calculateUnifiedDiff(oldText, newText, 3);
        expect(hunks).toHaveLength(1);
        expectContiguous(hunks[0]);
        expect(oldLineNumbers(hunks[0])).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    });

    it('a change at the very start or end clamps its context to the file', () => {
        const oldText = numbered(10).join('\n');
        const newText = withReplaced(numbered(10), 1, 10).join('\n');
        const { hunks } = calculateUnifiedDiff(oldText, newText, 3);
        expect(hunks).toHaveLength(2);
        expect(oldLineNumbers(hunks[0])).toEqual([1, 2, 3, 4]);
        expect(oldLineNumbers(hunks[1])).toEqual([7, 8, 9, 10]);
    });

    it('identical texts produce one context-only hunk and zero stats', () => {
        const text = numbered(3).join('\n');
        const result = calculateUnifiedDiff(text, text, 3);
        expect(result.stats).toEqual({ additions: 0, deletions: 0 });
        expect(result.hunks).toHaveLength(1);
        expect(result.hunks[0].lines.every(l => l.type === 'normal')).toBe(true);
    });
});

describe('getPatchDiffStats (#274)', () => {
    it('counts a removed "--before" / added "++after" pair by hunk state, not by prefix', () => {
        const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n---before\n+++after\n';
        expect(getPatchDiffStats(patch)).toEqual({ additions: 1, deletions: 1 });
    });

    it('still ignores file and hunk headers', () => {
        const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n';
        expect(getPatchDiffStats(patch)).toEqual({ additions: 1, deletions: 1 });
    });
});
