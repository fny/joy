import { describe, it, expect, vi, beforeEach } from 'vitest';

const alert = vi.fn();
const appLog = vi.fn();
vi.mock('@/modal', () => ({ Modal: { alert: (...a: unknown[]) => alert(...a) } }));
vi.mock('@/log', () => ({ log: { log: (...a: unknown[]) => appLog(...a) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { guarded, handle, alertError, logError, errorMessage, isThenable } from './guardAsync';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('guardAsync — no promise escapes a void callback', () => {
    beforeEach(() => { alert.mockReset(); appLog.mockReset(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it('a rejected async handler reaches the reporter instead of rejecting unhandled', async () => {
        const onError = vi.fn();
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            guarded(async () => { throw new Error('offline'); }, onError)();
            await flush();
            expect(onError).toHaveBeenCalledTimes(1);
            expect((onError.mock.calls[0][0] as Error).message).toBe('offline');
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('a synchronous throw is reported too, and the handler returns void', () => {
        const onError = vi.fn();
        const fn = guarded(() => { throw new Error('sync'); }, onError);
        expect(fn()).toBeUndefined();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('arguments pass through and a resolved result is silent', async () => {
        const seen: number[] = [];
        const onError = vi.fn();
        guarded(async (n: number) => { seen.push(n); }, onError)(7);
        await flush();
        expect(seen).toEqual([7]);
        expect(onError).not.toHaveBeenCalled();
    });

    it('a sync, non-promise function is called once and nothing is reported', () => {
        const onError = vi.fn();
        const fn = vi.fn(() => 42);
        guarded(fn, onError)();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
    });

    it('the default reporter writes to the app log', async () => {
        guarded(async () => { throw new Error('quiet'); })();
        await flush();
        expect(appLog).toHaveBeenCalledWith('[guarded] quiet');
        expect(alert).not.toHaveBeenCalled();
    });

    it('alertError shows the error text under the Error title, or the given message', async () => {
        guarded(async () => { throw new Error('relay 503'); }, alertError())();
        await flush();
        expect(alert).toHaveBeenCalledWith('common.error', 'relay 503');
        alert.mockReset();
        guarded(async () => { throw new Error('ENOENT'); }, alertError('common.openLinkFailed'))();
        await flush();
        expect(alert).toHaveBeenCalledWith('common.error', 'common.openLinkFailed');
    });

    it('a reporter that throws does not produce a second unhandled rejection', async () => {
        const unhandled = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        process.on('unhandledRejection', unhandled);
        try {
            guarded(async () => { throw new Error('a'); }, () => { throw new Error('reporter broke'); })();
            await flush();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('handle() attaches a rejection handler to an existing promise and ignores non-promises', async () => {
        const onError = vi.fn();
        handle(Promise.reject(new Error('late')), onError);
        handle(undefined, onError);
        handle(3, onError);
        await flush();
        expect(onError).toHaveBeenCalledTimes(1);
    });

    it('errorMessage / isThenable cover the shapes callers throw', () => {
        expect(errorMessage(new Error('x'))).toBe('x');
        expect(errorMessage('plain')).toBe('plain');
        expect(errorMessage({ message: 'obj' })).toBe('obj');
        expect(errorMessage({ code: 7 })).toBe('{"code":7}');
        expect(errorMessage(null)).toBe('null');
        expect(isThenable(Promise.resolve())).toBe(true);
        expect(isThenable({ then() { /* thenable */ } })).toBe(true);
        expect(isThenable({})).toBe(false);
        expect(isThenable(null)).toBe(false);
        expect(typeof logError).toBe('function');
    });
});
