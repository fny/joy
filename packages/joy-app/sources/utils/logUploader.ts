/**
 * A bounded, abortable upload queue for remote console logs.
 *
 * Before (#426) every captured console line started its own `fetch` with no
 * deadline, no concurrency limit and no way to cancel: an accepting-but-never-
 * responding log server accumulated one pending request per line (6,000
 * uploads while the visible buffer capped at 5,000), and disabling console
 * output left them all pending.
 *
 * Now: at most `maxConcurrent` requests are in flight, at most `maxPending`
 * bodies wait (the OLDEST is dropped when full — the newest lines are the ones
 * a developer is looking for), every request is aborted after `timeoutMs`, and
 * `cancelAll()` drops the queue and aborts the in-flight requests.
 */
export interface LogUploaderOptions {
    send: (body: string, signal: AbortSignal) => Promise<unknown>;
    maxPending?: number;
    maxConcurrent?: number;
    timeoutMs?: number;
}

export interface LogUploader {
    enqueue(body: string): void;
    /** Drop every queued body and abort every in-flight request. */
    cancelAll(): void;
    readonly pending: number;
    readonly inFlight: number;
    /** Bodies discarded because the queue was full. */
    readonly dropped: number;
}

export const DEFAULT_LOG_UPLOAD_MAX_PENDING = 200;
export const DEFAULT_LOG_UPLOAD_MAX_CONCURRENT = 4;
export const DEFAULT_LOG_UPLOAD_TIMEOUT_MS = 10_000;

export function createLogUploader(options: LogUploaderOptions): LogUploader {
    const maxPending = options.maxPending ?? DEFAULT_LOG_UPLOAD_MAX_PENDING;
    const maxConcurrent = options.maxConcurrent ?? DEFAULT_LOG_UPLOAD_MAX_CONCURRENT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOG_UPLOAD_TIMEOUT_MS;
    const queue: string[] = [];
    const active = new Set<AbortController>();
    let dropped = 0;

    const pump = () => {
        while (active.size < maxConcurrent && queue.length > 0) {
            const body = queue.shift()!;
            const controller = new AbortController();
            active.add(controller);
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            let sent: Promise<unknown>;
            try {
                sent = Promise.resolve(options.send(body, controller.signal));
            } catch (e) {
                sent = Promise.reject(e);
            }
            sent.then(undefined, () => {}).finally(() => {
                clearTimeout(timer);
                active.delete(controller);
                pump();
            });
        }
    };

    return {
        enqueue(body) {
            if (queue.length >= maxPending) {
                queue.shift();
                dropped++;
            }
            queue.push(body);
            pump();
        },
        cancelAll() {
            queue.length = 0;
            for (const c of active) c.abort();
        },
        get pending() { return queue.length; },
        get inFlight() { return active.size; },
        get dropped() { return dropped; },
    };
}

/**
 * The shape of a fetch Response this module cares about; structural so a
 * test (or React Native's polyfill, which has no `body` stream) fits.
 */
export interface DrainableResponse {
    body?: { cancel?: () => Promise<unknown> } | null;
    text?: () => Promise<unknown>;
}

/**
 * Settle a response's BODY before the request counts as finished. `fetch`
 * resolves at headers, so a send that returned the fetch promise released
 * its slot (and cleared its abort timer) while the body was still streaming
 * — 250 header-complete never-ending bodies with inFlight=0 (#426). The
 * body is cancelled where the platform allows and drained otherwise, and
 * either way the wait is cut by the same `signal` the request runs under,
 * because a body read that ignores the signal must not outlive the deadline.
 */
export function drainResponse(response: DrainableResponse | null | undefined, signal: AbortSignal): Promise<void> {
    if (!response) return Promise.resolve();
    const settle = (async () => {
        const body = response.body;
        if (body && typeof body.cancel === 'function') {
            try {
                await body.cancel();
                return;
            } catch {
                // locked or already consumed: fall through to a drain
            }
        }
        if (typeof response.text === 'function') {
            await response.text();
        }
    })();
    if (signal.aborted) return Promise.resolve();
    const cut = new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return Promise.race([settle.then(() => undefined, () => undefined), cut]);
}

/**
 * One remote log upload: POST the body, then settle the response body under
 * the same signal. Injected `fetchImpl` keeps it testable.
 */
export function sendLogUpload(fetchImpl: typeof fetch, url: string, body: string, signal: AbortSignal): Promise<void> {
    return fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
    }).then((response) => drainResponse(response as unknown as DrainableResponse, signal));
}
