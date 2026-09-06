import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { attempt, attemptAsync } from '@/utils/isolateBad';

import { ApiMessage } from '../apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;
    // Set when Encryption drops this instance: a decryption still in flight
    // must not write into the cache its REPLACEMENT (new key) now owns (#351).
    private retired = false;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /** Stop writing to the shared cache; reads still work. */
    retire(): void {
        this.retired = true;
    }

    private row(message: ApiMessage, content: DecryptedMessage['content']): DecryptedMessage {
        return {
            id: message.id,
            seq: message.seq,
            localId: message.localId ?? null,
            content,
            createdAt: message.createdAt,
        };
    }

    // Only VERIFIED plaintext is cached. A content:null row (failed open,
    // malformed ciphertext, unknown shape) used to be cached too and then won
    // over every later attempt — after the session key was repaired, or when
    // the same row arrived pre-unsealed — so the message stayed unreadable
    // until eviction (#356). Uncached failures cost one retry per page load.
    private remember(message: ApiMessage, decrypted: DecryptedMessage): void {
        if (this.retired || !decrypted.content) return;
        this.cache.setCachedMessage(message.id, decrypted);
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: ApiMessage[]): Promise<(DecryptedMessage | null)[]> {
        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: ApiMessage; bytes: Uint8Array }[] = [];

        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];
            if (!message) {
                results[i] = null;
                continue;
            }

            // Check cache first
            const cached = this.cache.getCachedMessage(message.id);
            if (cached) {
                results[i] = cached;
            } else if ((message as { __v2Plain?: unknown }).__v2Plain) {
                // v2 read path: the row arrives ALREADY decrypted (unsealed by
                // sources/sync/v2/reads.ts with the session's v2 content key),
                // so pass the plaintext straight through to normalization.
                const plain = this.row(message, (message as { __v2Plain?: unknown }).__v2Plain as never);
                results[i] = plain;
                this.remember(message, plain);
            } else if (message.content?.t === 'encrypted') {
                // Each ciphertext is decoded inside its OWN error boundary: one
                // row with c='%%%' used to throw out of decodeBase64 before the
                // batch reached the decryptor, withholding every valid message
                // on the page — and the retry repeated it (#355).
                const ciphertext = message.content.c;
                const bytes = attempt(
                    () => decodeBase64(ciphertext, 'base64'),
                    (error) => console.warn(`[sessionEncryption] message ${message.id} has malformed ciphertext, skipped:`, error),
                );
                if (bytes) {
                    toDecrypt.push({ index: i, message, bytes });
                } else {
                    results[i] = this.row(message, null);
                }
            } else {
                // Not encrypted or invalid
                results[i] = this.row(message, null);
            }
        }

        // Batch decrypt uncached messages
        if (toDecrypt.length > 0) {
            const decrypted = await attemptAsync(
                () => this.encryptor.decrypt(toDecrypt.map(item => item.bytes)),
                (error) => console.warn('[sessionEncryption] batch decrypt failed:', error),
            ) ?? [];

            for (let i = 0; i < toDecrypt.length; i++) {
                const { message, index } = toDecrypt[i];
                const result = this.row(message, decrypted[i] ?? null);
                this.remember(message, result);
                results[index] = result;
            }
        }

        return results;
    }

    /**
     * Encrypt metadata using session-specific encryption
     */
    async encryptMetadata(metadata: Metadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([metadata]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt metadata using session-specific encryption
     */
    async decryptMetadata(version: number, encrypted: string): Promise<Metadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMetadata(this.sessionId, version);
        if (cached) {
            return cached;
        }

        // Malformed base64 or a throwing decryptor is a failed open (null),
        // never an exception that takes the whole session refresh down (#355).
        const decrypted = await attemptAsync(async () => {
            const encryptedData = decodeBase64(encrypted, 'base64');
            return this.encryptor.decrypt([encryptedData]);
        }, (error) => console.warn(`[sessionEncryption] metadata v${version} failed to open:`, error));
        if (!decrypted || !decrypted[0]) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return null;
        }

        // Cache the result
        if (!this.retired) {
            this.cache.setCachedMetadata(this.sessionId, version, parsed.data);
        }
        return parsed.data;
    }

}
