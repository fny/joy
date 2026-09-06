import axios from 'axios';
import { encodeBase64 } from "../encryption/base64";
import { getServerUrl, relayAccessKeyHeaders } from "@/sync/serverConfig";
import { getJoyClientId } from '@/sync/clientId';
import { t } from '@/text';

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
}

/** The link's public key has no pairing request on this relay: the link
 *  expired, was already consumed, or was minted against another relay.
 *  Nothing was approved — callers must not report success (#187). */
export class AuthRequestNotFoundError extends Error {
    constructor() {
        super('No pending terminal pairing request for this link');
        this.name = 'AuthRequestNotFoundError';
    }
}

/** The relay refused the approval because the request aged out (410
 *  request_expired, #610): the QR the user scanned is stale, not broken.
 *  The message is the user-facing line; the caller shows it INSTEAD of its
 *  generic failure alert, never in addition to it. */
export class PairingCodeExpiredError extends Error {
    constructor() {
        super(t('errors.pairingCodeExpired'));
        this.name = 'PairingCodeExpiredError';
    }
}

/** 410 request_expired from the relay, without depending on axios' own
 *  type guard (which a mocked axios does not provide). */
function isRequestExpired(e: unknown): boolean {
    const response = (e as { response?: { status?: number; data?: { error?: unknown } } } | null)?.response;
    return response?.status === 410 && response.data?.error === 'request_expired';
}

/** Answer a terminal's pairing request with the sealed content data key
 *  (the only answer shape the daemon has ever accepted from joy).
 *  Resolves only when the terminal has (or already had) its credentials;
 *  rejects with AuthRequestNotFoundError when there is nothing to approve. */
export async function authApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const API_ENDPOINT = getServerUrl();
    const publicKeyBase64 = encodeBase64(publicKey);
    // axios bypasses the global fetch interceptor, so the gate key must be
    // attached here for the relay to accept these calls at all (#186).
    const relayHeaders = relayAccessKeyHeaders(API_ENDPOINT);

    // First, check the auth request status
    const statusResponse = await axios.get<AuthRequestStatus>(
        `${API_ENDPOINT}/joy/v2/auth/request/status`,
        {
            params: {
                publicKey: publicKeyBase64
            },
            headers: {
                'X-Joy-Client': getJoyClientId(),
                ...relayHeaders,
            }
        }
    );

    const { status } = statusResponse.data;

    if (status === 'not_found') {
        // Used to `return` here as if approved, and the caller then showed
        // "Terminal connected successfully" for an expired or foreign link
        // while no terminal ever received credentials (#187).
        throw new AuthRequestNotFoundError();
    }

    if (status === 'authorized') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized');
        return;
    }

    // Handle pending status
    if (status === 'pending') {
        try {
            await axios.post(`${API_ENDPOINT}/joy/v2/auth/response`, {
                publicKey: publicKeyBase64,
                response: encodeBase64(answer)
            }, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Joy-Client': getJoyClientId(),
                    ...relayHeaders,
                }
            });
        } catch (e) {
            if (isRequestExpired(e)) throw new PairingCodeExpiredError();
            throw e;
        }
        return;
    }

    throw new Error(`Unexpected pairing request status: ${String(status)}`);
}
