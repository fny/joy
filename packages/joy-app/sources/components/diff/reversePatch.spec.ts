import { describe, expect, it } from 'vitest';
import { parseHunks, reconstructOldText } from './reversePatch';

/** A patch the way git writes one, header and all. */
const patch = (body: string) => `diff --git a/f.ts b/f.ts\nindex 111..222 100644\n--- a/f.ts\n+++ b/f.ts\n${body}`;

describe('parseHunks', () => {
    it('reads the counts, and treats an omitted count as 1', () => {
        const hunks = parseHunks(patch('@@ -3 +3 @@\n-was\n+is\n'));
        expect(hunks).toHaveLength(1);
        expect(hunks[0]).toMatchObject({ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 });
    });

    it('stops a hunk at the next file in a multi-file patch', () => {
        const hunks = parseHunks(
            '--- a/one\n+++ b/one\n@@ -1,1 +1,1 @@\n-a\n+b\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1,1 +1,1 @@\n-c\n+d\n',
        );
        expect(hunks).toHaveLength(2);
        expect(hunks[0].lines).toEqual(['-a', '+b']);
        expect(hunks[1].lines).toEqual(['-c', '+d']);
    });
});

describe('reconstructOldText', () => {
    it('rebuilds the file a one-line change was made to', () => {
        const now = 'one\ntwo changed\nthree\n';
        const p = patch('@@ -1,3 +1,3 @@\n one\n-two\n+two changed\n three\n');
        expect(reconstructOldText(now, p)).toBe('one\ntwo\nthree\n');
    });

    it('keeps every line outside the hunks — the point of the whole-file view', () => {
        const now = ['a', 'b', 'c', 'd', 'CHANGED', 'f', 'g', 'h'].join('\n');
        const p = patch('@@ -4,3 +4,3 @@\n d\n-e\n+CHANGED\n f\n');
        expect(reconstructOldText(now, p)).toBe(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n'));
    });

    it('handles a pure addition', () => {
        const now = 'a\nnew line\nb\n';
        const p = patch('@@ -1,2 +1,3 @@\n a\n+new line\n b\n');
        expect(reconstructOldText(now, p)).toBe('a\nb\n');
    });

    it('handles a pure deletion, where the new side occupies no lines', () => {
        const now = 'a\nc\n';
        const p = patch('@@ -1,3 +1,2 @@\n a\n-b\n c\n');
        expect(reconstructOldText(now, p)).toBe('a\nb\nc\n');
    });

    it('restores a file emptied by the change (newCount 0)', () => {
        const p = patch('@@ -1,2 +0,0 @@\n-a\n-b\n');
        expect(reconstructOldText('', p)).toBe('a\nb\n');
    });

    it('applies several hunks in order', () => {
        const now = ['1', 'TWO', '3', '4', '5', 'SIX', '7'].join('\n');
        const p = patch('@@ -2 +2 @@\n-2\n+TWO\n@@ -6 +6 @@\n-6\n+SIX\n');
        expect(reconstructOldText(now, p)).toBe(['1', '2', '3', '4', '5', '6', '7'].join('\n'));
    });

    // The marker records which SIDE lost its final newline; ignoring it
    // rebuilt a file one empty line off from the original.
    it('a marker on the new side leaves the old side ending in a newline', () => {
        const now = 'a\nb';
        const p = patch('@@ -1,2 +1,2 @@\n a\n-old\n+b\n\\ No newline at end of file\n');
        expect(reconstructOldText(now, p)).toBe('a\nold\n');
    });

    it('a marker on the old side drops its final newline', () => {
        const now = 'a\nb\n';
        const p = patch('@@ -1,2 +1,2 @@\n a\n-old\n\\ No newline at end of file\n+b\n');
        expect(reconstructOldText(now, p)).toBe('a\nold');
    });

    it('a marker on a context line means neither side had one', () => {
        const now = 'a\nlast';
        const p = patch('@@ -1,2 +1,2 @@\n-A\n+a\n last\n\\ No newline at end of file\n');
        expect(reconstructOldText(now, p)).toBe('A\nlast');
    });

    it('treats a bare empty line in the body as context', () => {
        const now = 'a\n\nCHANGED\n';
        const p = patch('@@ -1,3 +1,3 @@\n a\n\n-b\n+CHANGED\n');
        expect(reconstructOldText(now, p)).toBe('a\n\nb\n');
    });

    it('refuses when the file has moved on since the patch was taken', () => {
        // The patch says line 2 is "two changed"; the file says otherwise.
        const p = patch('@@ -1,3 +1,3 @@\n one\n-two\n+two changed\n three\n');
        expect(reconstructOldText('one\nsomething else\nthree\n', p)).toBeNull();
    });

    it('refuses a hunk that starts before the previous one ended', () => {
        const p = patch('@@ -5,1 +5,1 @@\n-x\n+a\n@@ -1,1 +1,1 @@\n-y\n+b\n');
        expect(reconstructOldText('a\nb\nc\nd\na\n', p)).toBeNull();
    });

    it('refuses a hunk that starts past the end of the file', () => {
        const p = patch('@@ -99,1 +99,1 @@\n-x\n+y\n');
        expect(reconstructOldText('a\n', p)).toBeNull();
    });

    it('has nothing to say about a patch with no hunks', () => {
        expect(reconstructOldText('a\n', 'diff --git a/f b/f\nBinary files differ\n')).toBeNull();
    });
});
