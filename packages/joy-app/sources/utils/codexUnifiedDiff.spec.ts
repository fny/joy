import { describe, expect, it } from 'vitest';
import { materializeUnifiedDiffPatch, parseUnifiedDiff } from './codexUnifiedDiff';

describe('parseUnifiedDiff', () => {
    it('parses unified diff hunk fragments without file headers', () => {
        const parsed = parseUnifiedDiff(
            [
                '@@ -10,2 +10,4 @@',
                ' ',
                '+<p align="center"><em>Still won\'t make your tests pass by the power of positive thinking.</em></p>',
                '+',
                ' <div align="center">',
            ].join('\n'),
        );

        expect(parsed.fileName).toBeUndefined();
        expect(parsed.oldText).toBe('\n<div align="center">');
        expect(parsed.newText).toBe([
            '',
            '<p align="center"><em>Still won\'t make your tests pass by the power of positive thinking.</em></p>',
            '',
            '<div align="center">',
        ].join('\n'));
    });

    it('extracts filenames from full unified diffs', () => {
        const parsed = parseUnifiedDiff(
            [
                'diff --git a/README.md b/README.md',
                'index 1111111..2222222 100644',
                '--- a/README.md',
                '+++ b/README.md',
                '@@ -1 +1 @@',
                '-old line',
                '+new line',
            ].join('\n'),
        );

        expect(parsed.fileName).toBe('README.md');
        expect(parsed.oldText).toBe('old line');
        expect(parsed.newText).toBe('new line');
    });

    it('adds file headers to Codex hunk-only patch fragments', () => {
        expect(materializeUnifiedDiffPatch(
            [
                '@@ -1 +1 @@',
                '-old line',
                '+new line',
            ].join('\n'),
            'README.md',
            'update',
        )).toBe([
            '--- a/README.md',
            '+++ b/README.md',
            '@@ -1 +1 @@',
            '-old line',
            '+new line',
        ].join('\n'));
    });

    it('keeps full unified diffs unchanged', () => {
        const patch = [
            '--- a/README.md',
            '+++ b/README.md',
            '@@ -1 +1 @@',
            '-old line',
            '+new line',
        ].join('\n');

        expect(materializeUnifiedDiffPatch(patch, 'README.md', 'update')).toBe(patch);
    });
});

import { countUnifiedDiffChanges } from './codexUnifiedDiff';

describe('parseUnifiedDiff — final newline (#423)', () => {
    it('"hello" → "hello\\n" survives as a real edit', () => {
        const parsed = parseUnifiedDiff([
            '--- a/note.txt', '+++ b/note.txt', '@@ -1 +1 @@',
            '-hello', '\\ No newline at end of file', '+hello', '',
        ].join('\n'));
        expect(parsed.oldText).toBe('hello');
        expect(parsed.newText).toBe('hello\n');
    });

    it('and the reverse', () => {
        const parsed = parseUnifiedDiff([
            '--- a/note.txt', '+++ b/note.txt', '@@ -1 +1 @@',
            '-hello', '+hello', '\\ No newline at end of file', '',
        ].join('\n'));
        expect(parsed.oldText).toBe('hello\n');
        expect(parsed.newText).toBe('hello');
    });

    it('a "\\n"-terminated patch no longer grows an empty trailing line on both sides', () => {
        const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n');
        expect(parsed).toEqual({ oldText: 'a', newText: 'b', fileName: undefined });
    });

    it('a marker on a context line means neither side has a final newline', () => {
        const parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n-a\n+b\n c\n\\ No newline at end of file\n');
        expect(parsed.oldText).toBe('a\nc');
        expect(parsed.newText).toBe('b\nc');
    });
});

describe('parseUnifiedDiff — deleted files (#424)', () => {
    it('names the deleted file, not /dev/null', () => {
        const parsed = parseUnifiedDiff('--- a/note.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n');
        expect(parsed).toEqual({ oldText: 'gone', newText: '', fileName: 'note.txt' });
    });

    it('an added file is named from the new side', () => {
        expect(parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n').fileName).toBe('new.txt');
    });
});

describe('parseUnifiedDiff — content starting with -- or ++ (#108)', () => {
    const patch = [
        '--- a/f.sql', '+++ b/f.sql', '@@ -1,2 +1,2 @@',
        '--- old comment', '+++ new comment', ' SELECT 1',
    ].join('\n');

    it('keeps removed "-- …" and added "++ …" lines as content, and the real filename', () => {
        expect(parseUnifiedDiff(patch)).toEqual({
            oldText: '-- old comment\nSELECT 1',
            newText: '++ new comment\nSELECT 1',
            fileName: 'f.sql',
        });
    });

    it('a second file\'s a/ b/ headers still start a new file without diff --git lines', () => {
        const parsed = parseUnifiedDiff('--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-c\n+d\n');
        expect(parsed.fileName).toBe('two.ts');
        expect(parsed.oldText).toBe('a\nc');
        expect(parsed.newText).toBe('b\nd');
    });
});

describe('countUnifiedDiffChanges (#274)', () => {
    it('counts a --before → ++after replacement as +1 −1', () => {
        expect(countUnifiedDiffChanges('--- a/x\n+++ b/x\n@@ -1 +1 @@\n---before\n+++after\n')).toEqual({ added: 1, removed: 1 });
    });

    it('ignores headers and hunk markers, counts hunk-only fragments', () => {
        expect(countUnifiedDiffChanges('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1,3 +1,2 @@\n a\n-b\n-c\n+d\n')).toEqual({ added: 1, removed: 2 });
        expect(countUnifiedDiffChanges('@@ -1 +1,2 @@\n a\n+b\n')).toEqual({ added: 1, removed: 0 });
    });
});
