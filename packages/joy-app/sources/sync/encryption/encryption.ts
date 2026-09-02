import { deriveKey } from "@/encryption/deriveKey";
import { AES256Encryption, BoxEncryption, SecretBoxEncryption, Encryptor, Decryptor } from "./encryptor";
import { encodeHex } from "@/encryption/hex";
import { EncryptionCache } from "./encryptionCache";
import { SessionEncryption } from "./sessionEncryption";
import { MachineEncryption } from "./machineEncryption";
import { encodeBase64, decodeBase64 } from "@/encryption/base64";
import sodium from '@/encryption/libsodium.lib';
import { decryptBox, encryptBox } from "@/encryption/libsodium";
import { randomUUID } from 'expo-crypto';
import { setDerivedRelayPerimeterKey } from '@/sync/serverConfig';

export class Encryption {

    static async create(masterSecret: Uint8Array) {

        // The 'Happy …' HKDF labels below are WIRE CONSTANTS: the daemon
        // derives the same keys from the same labels, and every existing
        // account's data is sealed under them. Renaming would silently
        // orphan every session — leave them exactly as they are.

        // Derive content data key to open session and machine records
        const contentDataKey = await deriveKey(masterSecret, 'Happy EnCoder', ['content']);

        // Derive content data key keypair
        const contentKeyPair = sodium.crypto_box_seed_keypair(contentDataKey);

        // Derive anonymous ID
        const anonID = encodeHex((await deriveKey(masterSecret, 'Happy Coder', ['analytics', 'id']))).slice(0, 16).toLowerCase();

        // Derive master blob key for legacy sessions (those with no per-session dataKey)
        const masterBlobKey = await deriveKey(masterSecret, 'Happy Blobs', ['master']);

        // Relay perimeter key (joy-relay gate): derived from the SAME account
        // secret every device already holds, so nothing new is distributed —
        // the daemon derives the identical value at `joy auth` pairing, and
        // the relay box stores only this derived hex, never the secret.
        setDerivedRelayPerimeterKey(encodeHex(await deriveKey(masterSecret, 'Joy Relay', ['perimeter'])).toLowerCase());

        // Create encryption
        return new Encryption(anonID, masterSecret, contentKeyPair, masterBlobKey);
    }

    private readonly legacyEncryption: SecretBoxEncryption;
    private readonly contentKeyPair: sodium.KeyPair;
    private readonly masterBlobKey: Uint8Array;
    readonly anonID: string;
    readonly contentDataKey: Uint8Array;

    // Session and machine encryption management
    private sessionEncryptions = new Map<string, SessionEncryption>();
    private machineEncryptions = new Map<string, MachineEncryption>();
    private sessionBlobKeys = new Map<string, Uint8Array>();
    private cache: EncryptionCache;

    private constructor(anonID: string, masterSecret: Uint8Array, contentKeyPair: sodium.KeyPair, masterBlobKey: Uint8Array) {
        this.anonID = anonID;
        this.contentKeyPair = contentKeyPair;
        this.legacyEncryption = new SecretBoxEncryption(masterSecret);
        this.masterBlobKey = masterBlobKey;
        this.cache = new EncryptionCache();
        this.contentDataKey = contentKeyPair.publicKey;
    }

    /**
     * Open a v2 session-key envelope: "v2sk1:" + b64(epk32 ‖ nonce24 ‖
     * box(sessionKey → contentKeyPair.publicKey, ephemeral)). The daemon's
     * nucleus lane seals these at bind (nucleusLane.sealSessionKey). Returns
     * the 32-byte symmetric content key, or null for plaintext/legacy
     * envelopes and anything malformed.
     */
    openV2SessionKey(envelope: string): Uint8Array | null {
        if (!envelope.startsWith('v2sk1:')) return null;
        try {
            const raw = sodium.from_base64(envelope.slice(6), sodium.base64_variants.ORIGINAL);
            const epk = raw.slice(0, 32);
            const nonce = raw.slice(32, 32 + 24);
            const ct = raw.slice(32 + 24);
            const key = sodium.crypto_box_open_easy(ct, nonce, epk, this.contentKeyPair.privateKey);
            return key.length === 32 ? key : null;
        } catch {
            return null;
        }
    }

    //
    // Core encryption opening
    //

    async openEncryption(dataEncryptionKey: Uint8Array | null): Promise<Encryptor & Decryptor> {
        if (!dataEncryptionKey) {
            return this.legacyEncryption;
        }
        return new AES256Encryption(dataEncryptionKey);
    }

    //
    // Session operations
    //

    /**
     * Initialize sessions with their encryption keys
     * This should be called once when sessions are loaded
     */
    async initializeSessions(sessions: Map<string, Uint8Array | null>): Promise<void> {
        for (const [sessionId, dataKey] of sessions) {
            // Skip if already initialized
            if (this.sessionEncryptions.has(sessionId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache session encryption
            const sessionEnc = new SessionEncryption(
                sessionId,
                encryptor,
                this.cache
            );
            this.sessionEncryptions.set(sessionId, sessionEnc);

            // Derive blob key for this session.
            // Legacy sessions (null dataKey) use the master blob key.
            // Newer sessions derive a subkey from their own dataKey so blobs
            // are cryptographically isolated from message encryption.
            const blobKey = dataKey
                ? await deriveKey(dataKey, 'Happy Blobs', ['session'])
                : this.masterBlobKey;
            this.sessionBlobKeys.set(sessionId, blobKey);
        }
    }

    /**
     * Get session encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getSessionEncryption(sessionId: string): SessionEncryption | null {
        return this.sessionEncryptions.get(sessionId) || null;
    }

    /**
     * Remove session encryption from memory when session is deleted
     */
    removeSessionEncryption(sessionId: string): void {
        this.sessionEncryptions.delete(sessionId);
        this.sessionBlobKeys.delete(sessionId);
        // Also clear any cached data for this session
        this.cache.clearSessionCache(sessionId);
    }

    /**
     * Get the 32-byte NaCl secretbox key for encrypting binary blobs
     * (image attachments) in a session. Distinct from the message encryption
     * key to maintain cryptographic separation.
     * Returns null if the session has not been initialized.
     */
    getSessionBlobKey(sessionId: string): Uint8Array | null {
        return this.sessionBlobKeys.get(sessionId) ?? null;
    }

    //
    // Machine operations
    //

    /**
     * Initialize machines with their encryption keys
     * This should be called once when machines are loaded
     */
    async initializeMachines(machines: Map<string, Uint8Array | null>): Promise<void> {
        for (const [machineId, dataKey] of machines) {
            // Skip if already initialized
            if (this.machineEncryptions.has(machineId)) {
                continue;
            }

            // Create appropriate encryptor based on data key
            const encryptor = await this.openEncryption(dataKey);

            // Create and cache machine encryption
            const machineEnc = new MachineEncryption(
                machineId,
                encryptor,
                this.cache
            );
            this.machineEncryptions.set(machineId, machineEnc);
        }
    }

    /**
     * Get machine encryption if it has been initialized
     * Returns null if not initialized (should never happen in normal flow)
     */
    getMachineEncryption(machineId: string): MachineEncryption | null {
        return this.machineEncryptions.get(machineId) || null;
    }

    /**
     * Remove machine encryption from memory when the machine is deleted
     */
    removeMachineEncryption(machineId: string): void {
        this.machineEncryptions.delete(machineId);
    }

    //
    // Legacy methods for machine metadata (temporary until machines are migrated)
    //

    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.legacyEncryption.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.legacyEncryption.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            return null;
        }
    }

    //
    // Data Encryption Key decryption
    //

    async decryptEncryptionKey(encrypted: string) {
        const encryptedKey = decodeBase64(encrypted, 'base64');
        if (encryptedKey[0] !== 0) {
            return null;
        }

        const decrypted = decryptBox(encryptedKey.slice(1), this.contentKeyPair.privateKey);
        if (!decrypted) {
            return null;
        }
        return decrypted;
    }

    async encryptEncryptionKey(key: Uint8Array): Promise<Uint8Array> {
        // Use public key for encryption (encrypt TO ourselves)
        const encrypted = encryptBox(key, this.contentKeyPair.publicKey);
        const result = new Uint8Array(encrypted.length + 1);
        result[0] = 0; // Version byte
        result.set(encrypted, 1);
        return result;
    }

    generateId(): string {
        return randomUUID();
    }
}