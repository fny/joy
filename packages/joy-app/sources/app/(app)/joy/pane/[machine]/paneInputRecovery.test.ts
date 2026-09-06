import { describe, it, expect } from 'vitest';
import { clearPendingScript, planTextSubmit, resizePending, restoreFailedInput, sendKeysOutcome } from './paneInputRecovery';

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
        expect(planTextSubmit('ls', null)).toEqual({ clearFirst: false, typeText: true });
    });
    it('skips typing when the same text is known to sit in the pane unsubmitted', () => {
        expect(planTextSubmit('ls', { text: 'ls', certain: true })).toEqual({ clearFirst: false, typeText: false });
    });
    it('clears the box before typing EDITED text (would otherwise append to the old text)', () => {
        expect(planTextSubmit('edited', { text: 'old text', certain: true })).toEqual({ clearFirst: true, typeText: true });
    });
    it('clears first after a timeout left the box state unknown, even for the same text', () => {
        expect(planTextSubmit('ls', { text: 'ls', certain: false })).toEqual({ clearFirst: true, typeText: true });
    });
});

describe('sendKeysOutcome (#155)', () => {
    it('HTTP 500 / {ok:false} without an error message is a failure, not a landed send', () => {
        expect(sendKeysOutcome({ status: 500, data: { ok: false } })).toEqual({ outcome: 'failed', message: 'HTTP 500' });
        expect(sendKeysOutcome({ status: 200, data: { ok: false } })).toEqual({ outcome: 'failed', message: 'HTTP 200' });
        expect(sendKeysOutcome({ status: 200, data: {} })).toEqual({ outcome: 'failed', message: 'HTTP 200' });
        expect(sendKeysOutcome({ status: 200, data: null })).toEqual({ outcome: 'failed', message: 'HTTP 200' });
    });
    it('requires a 2xx status AND ok:true', () => {
        expect(sendKeysOutcome({ status: 200, data: { ok: true } })).toEqual({ outcome: 'ok' });
        expect(sendKeysOutcome({ status: 503, data: { ok: true } })).toEqual({ outcome: 'failed', message: 'HTTP 503' });
    });
    it('surfaces the daemon error text when there is one', () => {
        expect(sendKeysOutcome({ status: 409, data: { ok: false, error: 'no such window' } })).toEqual({ outcome: 'failed', message: 'no such window' });
    });
});

describe('clearPendingScript (#155)', () => {
    it('sends C-u presses, two per line, at least two, capped', () => {
        expect(clearPendingScript('ls')).toBe('<C-u><C-u>');
        expect(clearPendingScript('a\nb\nc')).toBe('<C-u>'.repeat(6));
        expect(clearPendingScript(Array(20).fill('x').join('\n'))).toBe('<C-u>'.repeat(12));
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
