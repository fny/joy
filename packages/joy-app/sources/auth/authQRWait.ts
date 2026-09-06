import axios from 'axios';
import { decodeBase64, encodeBase64 } from '../encryption/base64';
import { getServerUrl, relayAccessKeyHeaders } from '@/sync/serverConfig';
import { QRAuthKeyPair } from './authQRStart';
import { decryptBox } from '@/encryption/libsodium';
import { pairingHandshakeOf, pairingProof, type PairingHandshake } from '@/encryption/pairingProof';
import { getJoyClientId } from '@/sync/clientId';

import { t } from '@/text';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

/**
 * How a QR wait ended. The library reports; the SCREEN alerts — exactly once.
 * `failed` carries the line to show: the relay's own explanation for a
 * consumed request (#607), or "the code expired" (#610). The caller must not
 * follow it with a generic "Authentication failed" — that was the double
 * alert users saw. `cancelled` means the screen itself gave up (blur, back):
 * nothing to say.
 */
export type AuthQRWaitResult =
    | { kind: 'authorized'; credentials: AuthCredentials }
    | { kind: 'cancelled' }
    | { kind: 'failed'; message: string };

const POLL_INTERVAL_MS = 1000;
/** After a failed poll wait a little longer: an unreachable relay should not
 *  be hammered once a second, but the QR must stay usable (#89). */
const RETRY_INTERVAL_MS = 2000;
const CANCEL_CHECK_MS = 250;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Poll the relay until the phone answers this QR's pairing request.
 *
 * Resolves `authorized` with the credentials, `cancelled` when the caller's
 * `shouldCancel` ended the attempt, or `failed` (with the message to show)
 * when the relay said expired/consumed, the reply was undecryptable, or the
 * hard deadline passed. A single failed poll is NOT the end of the attempt (#89):
 * the request is still valid on the relay and the other device may be about
 * to approve it, so the loop logs, waits, and asks again until the deadline.
 *
 * `shouldCancel` is honoured at every step, including AFTER the awaited
 * request (#191): a cancelled attempt whose in-flight poll comes back
 * `authorized` must not hand out credentials, or the screen that cancelled
 * it (e.g. the one that pushed manual restore, #158) gets logged in behind
 * the user's back. The outstanding request is aborted as soon as the
 * cancellation is observed.
 */
export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthQRWaitResult> {
    let dots = 0;
    const cancelledResult: AuthQRWaitResult = { kind: 'cancelled' };
    const serverUrl = getServerUrl();
    const cancelled = () => !!shouldCancel && shouldCancel();
    // Hard stop. The relay forgets an answered request after ten minutes and
    // a repeat poll of a forgotten key CREATES a new pending request, so a
    // screen that slept across the approval would otherwise poll forever
    // for a QR the user already approved (#127). Twenty minutes covers any
    // real approval; after that the user re-scans a fresh code.
    const deadline = Date.now() + 20 * 60 * 1000;
    // Proof of possession (#127): every credential-less reply carries the
    // handshake (`challenge`, `relayPublicKey`) the NEXT poll proves over,
    // so the bearer is minted only to the holder of our private key, never
    // to whoever saw the QR. A relay from before the proof hands out no
    // handshake and gets the legacy proof-less poll.
    let handshake: PairingHandshake | null = null;

    while (true) {
        if (cancelled()) {
            return cancelledResult;
        }
        if (Date.now() > deadline) {
            console.log('\n\nPairing request expired. Please start again.');
            return { kind: 'failed', message: t('errors.pairingCodeExpired') };
        }

        let failed = false;
        try {
            const proof = handshake ? await pairingProof(keypair, handshake) : undefined;
            const response = await pollOnce(serverUrl, keypair, proof, deadline, cancelled);

            // The attempt may have been cancelled while the request was in
            // flight; its answer belongs to nobody now (#191).
            if (cancelled()) {
                return cancelledResult;
            }

            // The relay spends a challenge it has seen a valid proof over and
            // hands out a fresh one, so the proof is always computed over
            // the handshake of the LATEST reply.
            handshake = pairingHandshakeOf(response) ?? handshake;
            if (response.state === 'proof_required') {
                // Approved, and the relay wants the proof before it hands
                // out the bearer: the next poll carries it. An observer of
                // the QR lands here too — and stays here.
                console.log('Pairing approved; the next poll proves possession of the key.');
            }

            // The relay hands the answer out once (#70). 'consumed' means
            // someone else collected it — or our own earlier poll did and the
            // reply was lost — and 'expired' that it aged out: neither can
            // succeed by polling on, so stop and let the user re-scan.
            if (response.state === 'consumed' || response.state === 'expired') {
                // A consumed poll carries a `message` that says what happened
                // and what to do (#607); an expired one just needs a fresh
                // code (#610). Hand the specific line to the screen — it is
                // the ONLY alert the user should see for this outcome.
                const message = response.state === 'consumed' && typeof response.message === 'string' && response.message
                    ? response.message
                    : t('errors.pairingCodeExpired');
                console.log(`\n\nPairing request ${response.state}: ${message}`
                    + (response.consumedAt ? ` (consumedAt=${new Date(response.consumedAt).toISOString()})` : ''));
                return { kind: 'failed', message };
            }
            if (response.state === 'authorized') {
                const token = response.token as string;
                const encryptedResponse = decodeBase64(response.response as string);

                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    console.log('\n\n✓ Authentication successful\n');
                    return { kind: 'authorized', credentials: { secret: decrypted, token } };
                } else {
                    console.log('\n\nFailed to decrypt response. Please try again.');
                    return { kind: 'failed', message: t('errors.authenticationFailed') };
                }
            }
        } catch (error) {
            if (cancelled()) {
                return cancelledResult;
            }
            // Transient: network blip, 5xx, timeout. The QR stays valid on
            // the relay, so keep polling instead of failing the flow (#89).
            // The handshake survives such a failure: a delivering poll whose
            // reply was lost is re-collected with the SAME proof (the relay
            // keeps a proven pickup retryable), so the retry must prove
            // again rather than go proof-less and be told `consumed`.
            // A 401 invalid_proof is different — a proof over a challenge
            // the relay has since spent. Its reply carries no handshake, so
            // drop ours: the next poll goes proof-less, is handed the current
            // handshake, and the one after proves over it instead of
            // repeating the stale proof until the deadline.
            failed = true;
            const failure = pollFailureOf(error);
            if (failure.status === 401) {
                handshake = null;
            }
            // Never the error object itself: an AxiosError carries the
            // request body in `config.data`, and that body is a valid proof
            // that would land in the copyable in-app log (dev/logs.tsx).
            console.log('Failed to check authentication status; retrying.', failure);
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        await sleep(failed ? RETRY_INTERVAL_MS : POLL_INTERVAL_MS);
    }
}

interface PollResponse {
    state?: string;
    token?: string;
    response?: string;
    /** Relay-provided explanation for a `consumed` request (#607). */
    message?: string;
    consumedAt?: number;
    /** The proof-of-possession handshake (#127); absent on `expired`, on
     *  error bodies and from a relay that predates the proof. */
    challenge?: string;
    relayPublicKey?: string;
}

/** What a failed poll is allowed to log: the transport code, the HTTP status,
 *  the relay's `error` word and the message — never the request or the
 *  response body. Duck-typed rather than `axios.isAxiosError` so a plain
 *  Error (or a test double) summarises the same way. */
function pollFailureOf(error: unknown): { code?: string; status?: number; error?: string; message: string } {
    const e = (error && typeof error === 'object' ? error : {}) as {
        code?: unknown;
        message?: unknown;
        response?: { status?: unknown; data?: { error?: unknown } | null } | null;
    };
    const status = e.response?.status;
    const relayError = e.response?.data?.error;
    return {
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        ...(typeof status === 'number' ? { status } : {}),
        ...(typeof relayError === 'string' ? { error: relayError } : {}),
        message: typeof e.message === 'string' ? e.message : String(error),
    };
}

/** One status request, aborted the moment `cancelled()` turns true.
 *  `proof` rides along when we hold a handshake to prove over (#127). */
async function pollOnce(serverUrl: string, keypair: QRAuthKeyPair, proof: string | undefined, deadline: number, cancelled: () => boolean): Promise<PollResponse> {
    const controller = new AbortController();
    const watchdog = setInterval(() => {
        if (cancelled()) controller.abort();
    }, CANCEL_CHECK_MS);
    try {
        const response = await axios.post(`${serverUrl}/joy/v2/auth/account/request`, {
            publicKey: encodeBase64(keypair.publicKey),
            ...(proof ? { proof } : {}),
        }, {
            headers: {
                'X-Joy-Client': getJoyClientId(),
                // axios bypasses the fetch interceptor (#186)
                ...relayAccessKeyHeaders(serverUrl),
            },
            signal: controller.signal,
            // Bounded so the deadline above is checked even when the relay
            // accepts the request and never answers (Astra, 09cd8b87).
            timeout: Math.max(1_000, Math.min(15_000, deadline - Date.now())),
        });
        return (response.data ?? {}) as PollResponse;
    } finally {
        clearInterval(watchdog);
    }
}
