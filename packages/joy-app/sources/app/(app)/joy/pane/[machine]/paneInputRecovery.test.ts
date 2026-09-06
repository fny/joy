import { describe, it, expect } from 'vitest';
import { planTextSubmit, resizePending, restoreFailedInput } from './paneInputRecovery';

describe('restoreFailedInput (#155)', () => {
    it('puts the submitted text back into an empty box', () => {
        expect(restoreFailedInput('', 'git status')).toBe('git status');
        expect(restoreFailedInput('   ', 'git status')).toBe('git status');
    });
    it('never overwrites newer edits', () => {
        expect(restoreFailedInput('something new', 'git status')).toBe('something new');
    });
});

describe('planTextSubmit (#155)', () => {
    it('types the text on a fresh submit', () => {
        expect(planTextSubmit('ls', null)).toEqual({ typeText: true });
    });
    it('skips typing when the same text already sits in the pane unsubmitted', () => {
        expect(planTextSubmit('ls', 'ls')).toEqual({ typeText: false });
    });
    it('types again when the text was edited since', () => {
        expect(planTextSubmit('ls -la', 'ls')).toEqual({ typeText: true });
    });
});

describe('resizePending (#156)', () => {
    it('is pending until the daemon has acknowledged any size', () => {
        expect(resizePending({ cols: 80, rows: 24 }, null)).toBe(true);
    });
    it('is settled once the acknowledged size matches the measurement', () => {
        expect(resizePending({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    });
    it('is pending again when the measurement changed', () => {
        expect(resizePending({ cols: 100, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    });
    it('is not pending before anything was measured', () => {
        expect(resizePending(null, null)).toBe(false);
    });
});
