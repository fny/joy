import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/log', () => ({ log: { log: vi.fn(), error: vi.fn() } }));

import { createAlertButtonGate, runAlertButton, type AlertButtonHost } from './alertButtonPress';

function host(live = true) {
    const calls: string[] = [];
    const h: AlertButtonHost = {
        isLive: () => live,
        pending: () => { calls.push('pending'); },
        close: () => { calls.push('close'); },
        fail: (m) => { calls.push(`fail:${m}`); },
    };
    return { h, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runAlertButton (#331)', () => {
    it('a button without a handler just closes', () => {
        const { h, calls } = host();
        runAlertButton(undefined, h);
        expect(calls).toEqual(['close']);
    });

    it('a sync handler closes on return and shows a throw inline without closing', () => {
        const ok = host();
        runAlertButton(() => {}, ok.h);
        expect(ok.calls).toEqual(['close']);
        const bad = host();
        runAlertButton(() => { throw new Error('nope'); }, bad.h);
        expect(bad.calls).toEqual(['fail:nope']);
    });

    it('an async handler keeps the dialog open while pending and closes on success', async () => {
        const { h, calls } = host();
        runAlertButton(async () => {}, h);
        expect(calls).toEqual(['pending']);
        await flush();
        expect(calls).toEqual(['pending', 'close']);
    });

    it('a rejected async handler is shown inline with the retry controls back — the dialog does not close', async () => {
        const { h, calls } = host();
        runAlertButton(async () => { throw new Error('network offline'); }, h);
        await flush();
        expect(calls).toEqual(['pending', 'fail:network offline']);
    });

    it('a rejection after unmount is swallowed (nothing can display it) and never escapes', async () => {
        const { h, calls } = host(false);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            runAlertButton(async () => { throw new Error('late'); }, h);
            await flush();
            await flush();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
        expect(calls).toEqual(['pending']);
        expect(unhandled).not.toHaveBeenCalled();
    });
});

describe('createAlertButtonGate (#331 residual)', () => {
    it('two activations before React commits launch the async action once', async () => {
        // Reviewer: invoking the current press handler twice before the
        // `pending` state lands started the operation twice.
        const gate = createAlertButtonGate();
        const action = vi.fn(async () => {});
        const { h, calls } = host();
        expect(gate.press(action, h)).toBe(true);
        expect(gate.press(action, h)).toBe(false);
        expect(action).toHaveBeenCalledTimes(1);
        expect(gate.isBusy()).toBe(true);
        await flush();
        expect(calls).toEqual(['pending', 'close']);
        expect(gate.isBusy()).toBe(false);
    });

    it('a failed action releases the gate so the user can retry', async () => {
        const gate = createAlertButtonGate();
        const { h, calls } = host();
        gate.press(async () => { throw new Error('offline'); }, h);
        await flush();
        expect(calls).toEqual(['pending', 'fail:offline']);
        expect(gate.isBusy()).toBe(false);
        expect(gate.press(async () => {}, h)).toBe(true);
    });

    it('sync handlers release the gate immediately (return or throw)', () => {
        const gate = createAlertButtonGate();
        const { h } = host();
        gate.press(() => {}, h);
        expect(gate.isBusy()).toBe(false);
        gate.press(() => { throw new Error('nope'); }, h);
        expect(gate.isBusy()).toBe(false);
        gate.press(undefined, h);
        expect(gate.isBusy()).toBe(false);
    });
});
