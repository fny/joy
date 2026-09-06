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

/** How many times one push-token call is tried before it gives up. */
export const PUSH_API_MAX_ATTEMPTS = 4;

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

function headers(credentials: AuthCredentials): Record<string, string> {
    return {
        'Authorization': `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Joy-Client': getJoyClientId(),
    };
}

export async function registerPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await pushBackoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens`, {
            method: 'POST',
            headers: headers(credentials),
            body: JSON.stringify({ token })
        });

        if (!response.ok) {
            throw new PushApiError(`Failed to register push token: ${response.status}`, response.status);
        }

        const data = await response.json();
        if (!data.success) {
            throw new Error('Failed to register push token');
        }
    });
}

export async function fetchPushTokens(credentials: AuthCredentials): Promise<PushToken[]> {
    const API_ENDPOINT = getServerUrl();
    return pushBackoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens`, {
            method: 'GET',
            headers: headers(credentials),
        });

        if (!response.ok) {
            throw new PushApiError(`Failed to fetch push tokens: ${response.status}`, response.status);
        }

        const data = await response.json();
        return PushTokenListResponseSchema.parse(data).tokens;
    });
}

export async function unregisterPushToken(credentials: AuthCredentials, token: string): Promise<void> {
    const API_ENDPOINT = getServerUrl();
    await pushBackoff(async () => {
        const response = await fetch(`${API_ENDPOINT}/joy/v2/push-tokens/${encodeURIComponent(token)}`, {
            method: 'DELETE',
            headers: headers(credentials),
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
    });
}
