import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/log', () => ({ log: { log: vi.fn(), error: vi.fn() } }));

import { runAlertButton, type AlertButtonHost } from './alertButtonPress';

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
