import { describe, it, expect, vi } from 'vitest';
import { MachineEncryption } from './machineEncryption';
import { EncryptionCache } from './encryptionCache';
import type { Decryptor, Encryptor } from './encryptor';

// Decryptor that fails its first N opens, then returns the given state.
function flaky(state: unknown, failFirst: number): Encryptor & Decryptor & { calls: number } {
    return {
        calls: 0,
        async encrypt(data: unknown[]) { return data.map(() => new Uint8Array([1])); },
        async decrypt(data: Uint8Array[]) {
            this.calls++;
            return data.map(() => (this.calls <= failFirst ? null : state));
        },
    };
}

const CIPHERTEXT = Buffer.from('anything').toString('base64');

describe('MachineEncryption — failed opens stay retryable, retired instances stay out of the cache', () => {
    it('a failed daemon-state decryption is retried on the next call instead of being cached (#353)', async () => {
        const enc = flaky({ running: true }, 1);
        const me = new MachineEncryption('mach', enc, new EncryptionCache());
        expect(await me.decryptDaemonState(7, CIPHERTEXT)).toBeNull();
        expect(await me.decryptDaemonState(7, CIPHERTEXT)).toEqual({ running: true }); // second attempt happened
        expect(enc.calls).toBe(2);
        expect(await me.decryptDaemonState(7, CIPHERTEXT)).toEqual({ running: true });
        expect(enc.calls).toBe(2); // the success IS cached
    });

    it('a throwing decryptor is not cached either', async () => {
        let boom = true;
        const enc: Encryptor & Decryptor = {
            async encrypt(d: unknown[]) { return d.map(() => new Uint8Array()); },
            async decrypt(d: Uint8Array[]) { if (boom) throw new Error('nope'); return d.map(() => ({ ok: 1 })); },
        };
        const me = new MachineEncryption('mach', enc, new EncryptionCache());
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await me.decryptDaemonState(1, CIPHERTEXT)).toBeNull();
        boom = false;
        expect(await me.decryptDaemonState(1, CIPHERTEXT)).toEqual({ ok: 1 });
        err.mockRestore();
    });

    it('a retired instance cannot repopulate the cache for its replacement (#351)', async () => {
        const cache = new EncryptionCache();
        const old = new MachineEncryption('mach', flaky({ host: 'old' }, 0), cache);
        old.retire();
        cache.clearMachineCache('mach');
        expect(await old.decryptDaemonState(1, CIPHERTEXT)).toEqual({ host: 'old' }); // still answers…
        expect(cache.getCachedDaemonState('mach', 1)).toBeUndefined();               // …but writes nothing

        const replacement = new MachineEncryption('mach', flaky({ host: 'new' }, 0), cache);
        expect(await replacement.decryptDaemonState(1, CIPHERTEXT)).toEqual({ host: 'new' });
        expect(cache.getCachedDaemonState('mach', 1)).toEqual({ host: 'new' });
    });

    it('decryptRaw preserves successfully opened falsy values (#354)', async () => {
        for (const value of [false, 0, '']) {
            const me = new MachineEncryption('mach', flaky(value, 0), new EncryptionCache());
            expect(await me.decryptRaw(CIPHERTEXT)).toBe(value);
        }
        // …while a failed open is still null.
        const failing = new MachineEncryption('mach', flaky('never', 99), new EncryptionCache());
        expect(await failing.decryptRaw(CIPHERTEXT)).toBeNull();
    });

    it('decryptDaemonState keeps a falsy opened state and caches it (#354)', async () => {
        const enc = flaky(false, 0);
        const cache = new EncryptionCache();
        const me = new MachineEncryption('mach', enc, cache);
        expect(await me.decryptDaemonState(3, CIPHERTEXT)).toBe(false);
        expect(cache.getCachedDaemonState('mach', 3)).toBe(false);
    });
});
