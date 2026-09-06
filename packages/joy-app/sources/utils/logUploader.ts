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
