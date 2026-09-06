import { describe, it, expect } from 'vitest';
import {
    clearPendingScript, pendingAfterScript, performSendKeys, planTextSubmit, resizePending, restoreFailedInput,
    sendKeysOutcome, submitTextOperation, transportFailureOutcome, type SendOutcome, type TypedPending,
} from './paneInputRecovery';

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
    it('HTTP 500 / {ok:false} without an error message is not a landed send — and not a definite failure either', () => {
        // The daemon reports a failed tmux segment AFTER earlier segments
        // landed, and a 5xx says nothing about what executed: unknown.
        expect(sendKeysOutcome({ status: 500, data: { ok: false } })).toEqual({ outcome: 'unknown', message: 'HTTP 500' });
        expect(sendKeysOutcome({ status: 200, data: { ok: false } })).toEqual({ outcome: 'unknown', message: 'HTTP 200' });
        expect(sendKeysOutcome({ status: 200, data: {} })).toEqual({ outcome: 'unknown', message: 'HTTP 200' });
        expect(sendKeysOutcome({ status: 200, data: null })).toEqual({ outcome: 'unknown', message: 'HTTP 200' });
    });
    it('requires a 2xx status AND ok:true', () => {
        expect(sendKeysOutcome({ status: 200, data: { ok: true } })).toEqual({ outcome: 'ok' });
        expect(sendKeysOutcome({ status: 503, data: { ok: true } })).toEqual({ outcome: 'unknown', message: 'HTTP 503' });
    });
    it('a 4xx is the daemon refusing before execution: definite, with its error text', () => {
        expect(sendKeysOutcome({ status: 409, data: { ok: false, error: 'no such window' } })).toEqual({ outcome: 'failed', message: 'no such window' });
        expect(sendKeysOutcome({ status: 400, data: { error: 'empty' } })).toEqual({ outcome: 'failed', message: 'empty' });
        expect(sendKeysOutcome({ status: 404, data: { error: 'session_not_found' } })).toEqual({ outcome: 'failed', message: 'session_not_found' });
    });
});

describe('transportFailureOutcome (#155 residual)', () => {
    const tunnelError = (status: number) => Object.assign(new Error(`tunnel: ${status}`), { name: 'TunnelError', status });
    it('a rejected promise after dispatch is unknown: the keys may have landed', () => {
        expect(transportFailureOutcome(new TypeError('Network request failed'))).toEqual({ outcome: 'unknown', message: 'Network request failed' });
        expect(transportFailureOutcome(tunnelError(502))).toEqual({ outcome: 'unknown', message: 'tunnel: 502' });
        expect(transportFailureOutcome(tunnelError(503))).toEqual({ outcome: 'unknown', message: 'tunnel: 503' });
        expect(transportFailureOutcome('boom')).toEqual({ outcome: 'unknown', message: 'boom' });
    });
    it('only a 4xx relay refusal — never forwarded to the daemon — is a definite failure', () => {
        expect(transportFailureOutcome(tunnelError(401))).toEqual({ outcome: 'failed', message: 'tunnel: 401' });
        expect(transportFailureOutcome(tunnelError(413))).toEqual({ outcome: 'failed', message: 'tunnel: 413' });
    });
});

describe('performSendKeys (#155 residual)', () => {
    it('classifies an acknowledged answer, a rejection, a sync throw and a timeout', async () => {
        expect(await performSendKeys(async () => ({ status: 200, data: { ok: true } }), 1000)).toEqual({ outcome: 'ok' });
        expect(await performSendKeys(async () => { throw new TypeError('lost'); }, 1000)).toEqual({ outcome: 'unknown', message: 'lost' });
        // A request that never left is definite.
        expect(await performSendKeys(() => { throw new Error('bad script'); }, 1000)).toEqual({ outcome: 'failed', message: 'bad script' });
        expect(await performSendKeys(() => new Promise(() => { }), 5)).toMatchObject({ outcome: 'unknown', timedOut: true });
    });
});

describe('pendingAfterScript (#155)', () => {
    it('an acknowledged script clears the assumption; an unknown one keeps it uncertain; a refusal changes nothing', () => {
        expect(pendingAfterScript('ok', { text: 'ls', certain: true })).toBeNull();
        expect(pendingAfterScript('unknown', { text: 'ls', certain: true })).toEqual({ text: 'ls', certain: false });
        expect(pendingAfterScript('unknown', null)).toBeNull();
        expect(pendingAfterScript('failed', { text: 'ls', certain: true })).toEqual({ text: 'ls', certain: true });
    });
});

describe('submitTextOperation (#155 residual): the reviewer\'s boundary', () => {
    /** A daemon whose keys land, then whose response is lost on the way back. */
    function lossyDaemon() {
        const state = { pane: '', submitted: [] as string[], failNextLiteral: true };
        const machineSendKeys = async (script: string, literal: boolean) => {
            if (literal) {
                state.pane += script;
                if (state.failNextLiteral) { state.failNextLiteral = false; throw new TypeError('response lost after keys landed'); }
            } else if (script === '<Enter>') {
                state.submitted.push(state.pane);
                state.pane = '';
            } else if (script.startsWith('<C-u>')) {
                state.pane = '';
            }
            return { status: 200, data: { ok: true } };
        };
        const send = async (script: string, literal: boolean): Promise<SendOutcome> =>
            (await performSendKeys(() => machineSendKeys(script, literal), 1000)).outcome;
        return { state, send };
    }

    it('first sendKeysRaw lands then the promise rejects: typedPending is retained and the retry does not type hellohello', async () => {
        const { state, send } = lossyDaemon();
        let pending: TypedPending = null;
        const first = await submitTextOperation('hello', pending, send);
        expect(first.submitted).toBe(false);
        expect(state.pane).toBe('hello'); // the keys DID land
        expect(first.pending).toEqual({ text: 'hello', certain: false });
        pending = first.pending;
        // The user presses Send again with the same text.
        const second = await submitTextOperation('hello', pending, send);
        expect(second.submitted).toBe(true);
        expect(second.pending).toBeNull();
        expect(state.submitted).toEqual(['hello']);
    });

    it('an edited retry after the uncertain step clears first, an exact acknowledged retry sends only the Enter', async () => {
        const { state, send } = lossyDaemon();
        const first = await submitTextOperation('hello', null, send);
        const edited = await submitTextOperation('hello world', first.pending, send);
        expect(edited.submitted).toBe(true);
        expect(state.submitted).toEqual(['hello world']);

        // Text acknowledged, Enter refused by the daemon (definite): the
        // text is known to sit in the box, so the retry is the Enter alone.
        let enterRefused = true;
        const typedOnly: string[] = [];
        const sendEnterFails = async (script: string, literal: boolean): Promise<SendOutcome> => {
            if (literal) typedOnly.push(script);
            if (script === '<Enter>' && enterRefused) { enterRefused = false; return 'failed'; }
            return 'ok';
        };
        const r1 = await submitTextOperation('ls', null, sendEnterFails);
        expect(r1).toEqual({ submitted: false, pending: { text: 'ls', certain: true } });
        const r2 = await submitTextOperation('ls', r1.pending, sendEnterFails);
        expect(r2).toEqual({ submitted: true, pending: null });
        expect(typedOnly).toEqual(['ls']);
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
