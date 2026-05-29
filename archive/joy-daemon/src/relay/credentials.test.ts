/**
 * Credentials resolution tests — joy-native first, .happy fallback second.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, loadHappySessionKey } from './credentials';

function mkSandbox(): { joyHome: string; happyHome: string } {
    const root = mkdtempSync(join(tmpdir(), 'joy-credtest-'));
    const joyHome = join(root, 'joy');
    const happyHome = join(root, 'happy');
    mkdirSync(joyHome, { recursive: true });
    mkdirSync(happyHome, { recursive: true });
    process.env.JOY_HOME = joyHome;
    process.env.HAPPY_HOME_DIR = happyHome;
    delete process.env.JOY_CREDS;
    delete process.env.HAPPY_SERVER_URL;
    return { joyHome, happyHome };
}

afterEach(() => {
    for (const k of ['JOY_HOME', 'HAPPY_HOME_DIR', 'JOY_CREDS', 'HAPPY_SERVER_URL'] as const) {
        if (process.env[k]?.includes('joy-credtest-')) {
            try { rmSync(process.env[k]!.split('/').slice(0, -1).join('/'), { recursive: true, force: true }); } catch { /* ok */ }
        }
        delete process.env[k];
    }
});

describe('loadCredentials', () => {
    it('throws when nothing is available', () => {
        mkSandbox();
        expect(() => loadCredentials()).toThrow(/no credentials found/);
    });

    it('falls back to ~/.happy/access.key when joy-native is absent', () => {
        const { happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
            token: 'happy-token',
            encryption: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', machineKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' },
        }));
        writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({ serverUrl: 'https://from.happy' }));
        const c = loadCredentials();
        expect(c.token).toBe('happy-token');
        expect(c.serverUrl).toBe('https://from.happy');
        expect(c.source).toBe('happy/access.key');
    });

    it('joy-native credentials.json overrides the .happy fallback', () => {
        const { joyHome, happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
            token: 'happy-token',
            encryption: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', machineKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' },
        }));
        writeFileSync(join(joyHome, 'credentials.json'), JSON.stringify({
            token: 'joy-token', serverUrl: 'https://from.joy',
            encryption: { type: 'dataKey', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        }));
        const c = loadCredentials();
        expect(c.token).toBe('joy-token');
        expect(c.serverUrl).toBe('https://from.joy');
        expect(c.source).toBe('joy-credentials.json');
    });

    it('JOY_CREDS env wins over JOY_HOME/credentials.json and .happy', () => {
        const { joyHome, happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
            token: 'happy-token',
            encryption: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', machineKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' },
        }));
        writeFileSync(join(joyHome, 'credentials.json'), JSON.stringify({
            token: 'joy-token',
            encryption: { type: 'dataKey', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        }));
        const explicit = join(joyHome, 'explicit.json');
        writeFileSync(explicit, JSON.stringify({
            token: 'env-token', serverUrl: 'https://explicit',
            encryption: { type: 'dataKey', publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
        }));
        process.env.JOY_CREDS = explicit;
        const c = loadCredentials();
        expect(c.token).toBe('env-token');
        expect(c.serverUrl).toBe('https://explicit');
        expect(c.source).toBe('JOY_CREDS');
    });

    it('HAPPY_SERVER_URL env overrides stored serverUrl from .happy', () => {
        const { happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
            token: 'happy-token',
            encryption: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', machineKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' },
        }));
        writeFileSync(join(happyHome, 'settings.json'), JSON.stringify({ serverUrl: 'https://from.happy' }));
        process.env.HAPPY_SERVER_URL = 'https://from.env';
        const c = loadCredentials();
        expect(c.serverUrl).toBe('https://from.env');
    });

    it('default serverUrl when neither env nor stored is set', () => {
        const { happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'access.key'), JSON.stringify({
            token: 'happy-token',
            encryption: { publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', machineKey: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=' },
        }));
        const c = loadCredentials();
        expect(c.serverUrl).toBe('https://api.cluster-fluster.com');
    });
});

describe('loadHappySessionKey', () => {
    it('returns null when sessions.json is missing', () => {
        mkSandbox();
        expect(loadHappySessionKey('does-not-exist')).toBeNull();
    });

    it('returns the key+variant for an existing entry', () => {
        const { happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'sessions.json'), JSON.stringify({
            sessions: { 's1': { encryptionKey: 'AAAA', encryptionVariant: 'dataKey' } },
        }));
        const k = loadHappySessionKey('s1');
        expect(k?.sessionKeyB64).toBe('AAAA');
        expect(k?.variant).toBe('dataKey');
        expect(k?.source).toBe('happy/sessions.json');
    });

    it('returns null for an entry without a key', () => {
        const { happyHome } = mkSandbox();
        writeFileSync(join(happyHome, 'sessions.json'), JSON.stringify({
            sessions: { 's1': { encryptionVariant: 'dataKey' } },
        }));
        expect(loadHappySessionKey('s1')).toBeNull();
    });
});
