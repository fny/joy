import { AuthCredentials } from '@/auth/tokenStorage';
import { createBackoff } from '@/utils/time';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import { getJoyClientId } from './clientId';

const PushTokenSchema = z.object({
    id: z.string(),
    token: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const PushTokenListResponseSchema = z.object({
    tokens: z.array(PushTokenSchema),
});

export type PushToken = z.infer<typeof PushTokenSchema>;

/** An HTTP failure from the relay; `status` decides whether retrying can help. */
export class PushApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'PushApiError';
    }
}

/** One attempt exceeded PUSH_API_TIMEOUT_MS (headers or body). Retryable. */
export class PushApiTimeoutError extends Error {
    constructor() {
        super(`Push token request timed out after ${PUSH_API_TIMEOUT_MS}ms`);
        this.name = 'PushApiTimeoutError';
    }
}

/** How many times one push-token call is tried before it gives up. */
export const PUSH_API_MAX_ATTEMPTS = 4;

/** Deadline for ONE attempt, covering the response headers AND the body
 *  read. An attempt count alone is not an I/O bound: a DELETE the relay
 *  accepted but never answered kept removePushToken pending forever (#9). */
export const PUSH_API_TIMEOUT_MS = 10_000;

/**
 * Every push-token call used to run under the global unbounded `backoff`, so
 * with no connectivity (or a relay answering 401/5xx) `unregisterPushToken`
 * never settled — logout hung on it forever and the account screen's delete
 * spinner never stopped (#9). Retries are now bounded and a definitive 4xx
 * (anything but 408/429) is not retried at all: the same request cannot
 * succeed on the next try.
 */
const pushBackoff = createBackoff({
    minDelay: 500,
    maxDelay: 4000,
    maxFailureCount: PUSH_API_MAX_ATTEMPTS,
    maxAttempts: PUSH_API_MAX_ATTEMPTS,
    shouldRetry: (e) => !(e instanceof PushApiError) || e.status === 408 || e.status === 429 || e.status >= 500,
    onError: (e) => { console.warn('[push] request failed:', e); },
});

/**
 * Run one attempt under a deadline. The signal is handed to fetch so the
 * request (and, in browsers, the body read) is actually cancelled; the race
 * guarantees the attempt settles even where the platform ignores the signal.
 */
async function withDeadline<T>(attempt: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_API_TIMEOUT_MS);
    const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new PushApiTimeoutError()), { once: true });
    });
    try {
        return await Promise.race([attempt(controller.signal), timedOut]);
    } finally {
        clearTimeout(timer);
        // Nothing may keep reading after the attempt is over.
        controller.abort();
    }
}

function headers(credentials: AuthCredentials): Record<string, string> {
    return {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Joy-Client': getJoyClientId(),
    };
}

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await pushBackoff(() => withDeadline(async (signal) => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens`, {
            method: 'POST',
            headers: headers(credentials),
            body: JSON.stringify({ token }),
            signal,
        });

        if (!response.ok) {
            throw new PushApiError(`Failed to register push token: ${response.status}`, response.status);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    }));
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    return pushBackoff(() => withDeadline(async (signal) => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens`, {
            method: 'GET',
            headers: headers(credentials),
            signal,
        });

        if (!response.ok) {
            throw new PushApiError(`Failed to fetch push tokens: ${response.status}`, response.status);
        }

        const data = await response.json();
        return PushTokenListResponseSchema.parse(data).tokens;
    }));
}

export async function unregisterPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await pushBackoff(() => withDeadline(async (signal) => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: headers(credentials),
            signal,
        });

        // A token the relay no longer knows is already unregistered — the
        // caller's goal (nothing to push to) is met, so this is not a failure.
        if (response.status === 404) {
            return;
        }

        if (!response.ok) {
            throw new PushApiError(`Failed to unregister push token: ${response.status}`, response.status);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to unregister push token');
        }
    }));
}
