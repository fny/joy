import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogUploader, drainResponse, sendLogUpload } from './logUploader';

type Pending = { body: string; signal: AbortSignal; resolve: () => void; reject: (e: unknown) => void };

function hangingSend() {
    const calls: Pending[] = [];
    const send = (body: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
        calls.push({ body, signal, resolve, reject });
        signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    return { calls, send };
}

// Drain the promise chains (then/finally) behind a settled send.
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('log uploader (#426)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('bounds concurrency and the pending queue, dropping the oldest when full', () => {
        const { calls, send } = hangingSend();
        const up = createLogUploader({ send, maxConcurrent: 2, maxPending: 3, timeoutMs: 1000 });
        for (let i = 0; i < 10; i++) up.enqueue(`line ${i}`);
        expect(calls.length).toBe(2);                   // only two requests in flight
        expect(up.inFlight).toBe(2);
        expect(up.pending).toBe(3);                     // queue capped
        expect(up.dropped).toBe(5);
        // the newest lines survive
        expect(calls.map((c) => c.body)).toEqual(['line 0', 'line 1']);
    });

    it('aborts a request that exceeds the timeout and moves on to the next body', async () => {
        const { calls, send } = hangingSend();
        const up = createLogUploader({ send, maxConcurrent: 1, timeoutMs: 1000 });
        up.enqueue('a');
        up.enqueue('b');
        expect(calls.length).toBe(1);
        vi.advanceTimersByTime(1001);
        expect(calls[0].signal.aborted).toBe(true);
        await flush();
        await flush();
        expect(calls.length).toBe(2);
        expect(calls[1].body).toBe('b');
        expect(up.inFlight).toBe(1);
    });

    it('cancelAll drops the queue and aborts everything in flight', () => {
        const { calls, send } = hangingSend();
        const up = createLogUploader({ send, maxConcurrent: 2, maxPending: 10, timeoutMs: 1000 });
        for (let i = 0; i < 5; i++) up.enqueue(`line ${i}`);
        up.cancelAll();
        expect(up.pending).toBe(0);
        expect(calls.every((c) => c.signal.aborted)).toBe(true);
    });

    it('a completed request frees a slot for the next queued body', async () => {
        const { calls, send } = hangingSend();
        const up = createLogUploader({ send, maxConcurrent: 1, timeoutMs: 1000 });
        up.enqueue('a');
        up.enqueue('b');
        calls[0].resolve();
        await flush();
        await flush();
        expect(calls.length).toBe(2);
        expect(up.pending).toBe(0);
    });

    it('a synchronously throwing send does not wedge the queue', async () => {
        let n = 0;
        const send = vi.fn(() => { if (n++ === 0) throw new Error('boom'); return Promise.resolve(); });
        const up = createLogUploader({ send, maxConcurrent: 1, timeoutMs: 1000 });
        up.enqueue('a');
        up.enqueue('b');
        await flush();
        await flush();
        expect(send).toHaveBeenCalledTimes(2);
        expect(up.inFlight).toBe(0);
    });
});

describe('response bodies are settled before a slot is released (#426 residual)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    // A fetch whose HEADERS arrive at once but whose body never ends, and
    // that ignores the abort signal (React Native's polyfill does for the
    // body read).
    const neverEndingBodyFetch = (() => Promise.resolve({
        ok: true,
        text: () => new Promise<string>(() => {}),
    })) as unknown as typeof fetch;

    it('a header-complete response with a never-ending body keeps its slot until the deadline aborts it', async () => {
        const send = (body: string, signal: AbortSignal) => sendLogUpload(neverEndingBodyFetch, 'http://logs', body, signal);
        const up = createLogUploader({ send, maxConcurrent: 1, timeoutMs: 1000 });
        up.enqueue('a');
        up.enqueue('b');
        await flush();
        // Before: fetch resolved at headers, inFlight dropped to 0 and 'b'
        // went out while 'a' streamed forever.
        expect(up.inFlight).toBe(1);
        expect(up.pending).toBe(1);
        vi.advanceTimersByTime(1001);
        await flush();
        await flush();
        expect(up.pending).toBe(0);
        expect(up.inFlight).toBe(1); // 'b' took the slot only after 'a' was cut
    });

    it('drainResponse cancels a cancellable body, drains an uncancellable one, and is cut by abort', async () => {
        const cancel = vi.fn(async () => {});
        await drainResponse({ body: { cancel }, text: vi.fn() }, new AbortController().signal);
        expect(cancel).toHaveBeenCalledTimes(1);

        const text = vi.fn(async () => 'ok');
        await drainResponse({ body: null, text }, new AbortController().signal);
        expect(text).toHaveBeenCalledTimes(1);

        const controller = new AbortController();
        let settled = false;
        const p = drainResponse({ text: () => new Promise(() => {}) }, controller.signal).then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
        controller.abort();
        await p;
        expect(settled).toBe(true);
    });
});
