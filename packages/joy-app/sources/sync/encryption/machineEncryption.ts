import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { MachineMetadata, MachineMetadataSchema } from '../storageTypes';
import { EncryptionCache } from './encryptionCache';
import { Decryptor, Encryptor } from './encryptor';

export class MachineEncryption {
    private machineId: string;
    private encryptor: Encryptor & Decryptor;
    private cache: EncryptionCache;
    // Set when Encryption drops this instance: a decryption still in flight
    // must not write into the cache its REPLACEMENT (same machine id, new
    // key) now owns (#351).
    private retired = false;

    constructor(
        machineId: string,
        encryptor: Encryptor & Decryptor,
        cache: EncryptionCache
    ) {
        this.machineId = machineId;
        this.encryptor = encryptor;
        this.cache = cache;
    }

    /** Stop writing to the shared cache; reads still work. */
    retire(): void {
        this.retired = true;
    }

    /**
     * Encrypt machine metadata
     */
    async encryptMetadata(metadata: MachineMetadata): Promise<string> {
        const encrypted = await this.encryptor.encrypt([metadata]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt machine metadata with caching
     */
    async decryptMetadata(version: number, encrypted: string): Promise<MachineMetadata | null> {
        // Check cache first
        const cached = this.cache.getCachedMachineMetadata(this.machineId, version);
        if (cached) {
            return cached;
        }

        // Decrypt if not cached
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            if (!decrypted[0]) {
                return null;
            }

            const parsed = MachineMetadataSchema.safeParse(decrypted[0]);
            if (!parsed.success) {
                console.error('Failed to parse machine metadata:', parsed.error);
                return null;
            }

            // Cache the result
            if (!this.retired) {
                this.cache.setCachedMachineMetadata(this.machineId, version, parsed.data);
            }
            return parsed.data;
        } catch (error) {
            console.error('Failed to decrypt machine metadata:', error);
            return null;
        }
    }

    /**
     * Encrypt daemon state
     */
    async encryptDaemonState(state: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([state]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt daemon state with caching
     */
    async decryptDaemonState(version: number, encrypted: string | null | undefined): Promise<any | null> {
        if (!encrypted) {
            return null;
        }

        // Check cache first
        const cached = this.cache.getCachedDaemonState(this.machineId, version);
        if (cached !== undefined) {
            return cached;
        }

        // Only an OPENED state is cached. A null here means the open failed
        // (or the decryptor was mid-recovery); caching it — as both the
        // success and the catch path used to — made a transient failure
        // permanent for that version until eviction (#353). Left uncached,
        // the next poll simply retries.
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            const result = decrypted[0] ?? null;
            if (result !== null && !this.retired) {
                this.cache.setCachedDaemonState(this.machineId, version, result);
            }
            return result;
        } catch (error) {
            console.error('Failed to decrypt daemon state:', error);
            return null;
        }
    }

    /**
     * Encrypt raw data using machine-specific encryption
     */
    async encryptRaw(data: any): Promise<string> {
        const encrypted = await this.encryptor.encrypt([data]);
        return encodeBase64(encrypted[0], 'base64');
    }

    /**
     * Decrypt raw data using machine-specific encryption
     */
    async decryptRaw(encrypted: string): Promise<any | null> {
        try {
            const encryptedData = decodeBase64(encrypted, 'base64');
            const decrypted = await this.encryptor.decrypt([encryptedData]);
            return decrypted[0] || null;
        } catch (error) {
            console.error('Failed to decrypt raw data:', error);
            return null;
        }
    }
}
