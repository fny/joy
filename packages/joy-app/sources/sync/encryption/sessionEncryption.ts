import { decodeBase64, encodeBase64 } from '@/encryption/base64';

import { ApiMessage } from '../apiTypes';
import { DecryptedMessage, Metadata, MetadataSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';

export class SessionEncryption {
    private sessionId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;

    constructor(
        sessionId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.sessionId = sessionId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /**
     * Batch-first API for decrypting messages
     */
    async decryptMessages(messages: ApiMessage[]): Promise<(DecryptedMessage | null)[]> {
        // Check cache for all messages first
        const results: (DecryptedMessage | null)[] = new Array(messages.length);
        const toDecrypt: { index: number; message: ApiMessage; ciphertext: string }[] = [];

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
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: (message as { __v2Plain?: unknown }).__v2Plain as never,
                    createdAt: message.createdAt,
                };
                this.cache.setCachedMessage(message.id, results[i]!);
            } else if (message.content?.t === 'encrypted') {
                toDecrypt.push({ index: i, message, ciphertext: message.content.c });
            } else {
                // Not encrypted or invalid
                results[i] = {
                    id: message.id,
                    seq: message.seq,
                    localId: message.localId ?? null,
                    content: null,
                    createdAt: message.createdAt,
                };
                this.cache.setCachedMessage(message.id, results[i]!);
            }
        }

        // Batch decrypt uncached messages
        if (toDecrypt.length > 0) {
            const encrypted = toDecrypt.map(item =>
                decodeBase64(item.ciphertext, 'base64')
            );
            
            const decrypted = await this.encryptor.decrypt(encrypted);

            for (let i = 0; i < toDecrypt.length; i++) {
                const decryptedData = decrypted[i];
                const { message, index } = toDecrypt[i];

                if (decryptedData) {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: decryptedData,
                        createdAt: message.createdAt,
                    };
                    this.cache.setCachedMessage(message.id, result);
                    results[index] = result;
                } else {
                    const result: DecryptedMessage = {
                        id: message.id,
                        seq: message.seq,
                        localId: message.localId ?? null,
                        content: null,
                        createdAt: message.createdAt,
                    };
                    this.cache.setCachedMessage(message.id, result);
                    results[index] = result;
                }
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

        // Decrypt if not cached
        const encryptedData = decodeBase64(encrypted, 'base64');
        const decrypted = await this.encryptor.decrypt([encryptedData]);
        if (!decrypted[0]) {
            return null;
        }
        const parsed = MetadataSchema.safeParse(decrypted[0]);
        if (!parsed.success) {
            return null;
        }

        // Cache the result
        this.cache.setCachedMetadata(this.sessionId, version, parsed.data);
        return parsed.data;
    }

}