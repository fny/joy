/**
 * Live smoke against the real relay server, using existing happy creds
 * at ~/.happy (access.key + sessions.json). Gated by JOY_LIVE_TEST=1 so it
 * does not run in normal CI.
 *
 * READ-ONLY: pulls a few messages from one existing session and attempts
 * to decrypt one. Does not append, does not start an agent. The user's
 * production data is not modified.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RelayClient } from './relayClient';
import { decrypt, b64decode } from './encryption';
import { rawContentB64 } from './relayClient';
import { loadCredentials } from './credentials';

const HOME = homedir();
const HAPPY_DIR = process.env.HAPPY_HOME_DIR ?? join(HOME, '.happy');
const accessKeyPath = join(HAPPY_DIR, 'access.key');
const sessionsPath = join(HAPPY_DIR, 'sessions.json');
const settingsPath = join(HAPPY_DIR, 'settings.json');

const LIVE = process.env.JOY_LIVE_TEST === '1';
const havePrereqs = existsSync(accessKeyPath) && existsSync(sessionsPath);

// settingsPath retained for legibility (kept for backward-compat); the
// real source-of-truth is loadCredentials() with its happy/access.key
// fallback path.
void settingsPath;

interface SessionsFile {
    sessions: Record<string, { encryptionKey: string; encryptionVariant: 'legacy' | 'dataKey'; seq?: number }>;
}

function pickSession(): { id: string; key: Uint8Array; variant: 'legacy' | 'dataKey' } | null {
    try {
        const f = JSON.parse(readFileSync(sessionsPath, 'utf8')) as SessionsFile;
        for (const [id, s] of Object.entries(f.sessions)) {
            if (s.encryptionKey && s.encryptionVariant) {
                return { id, key: b64decode(s.encryptionKey), variant: s.encryptionVariant };
            }
        }
    } catch { /* ok */ }
    return null;
}

function toBytes(v: unknown): Uint8Array | null {
    if (typeof v === 'string') return b64decode(v);
    if (v instanceof Uint8Array) return v;
    if (Array.isArray(v)) return new Uint8Array(v as number[]);
    if (typeof v === 'object' && v !== null) {
        const o = v as { type?: string; data?: number[] };
        if (Array.isArray(o.data)) return new Uint8Array(o.data);
    }
    return null;
}

function describeKind(v: unknown): string {
    if (typeof v === 'string') return `string(len=${v.length})`;
    if (v instanceof Uint8Array) return `Uint8Array(len=${v.byteLength})`;
    if (Array.isArray(v)) return `Array(len=${v.length})`;
    if (typeof v === 'object' && v !== null) {
        const keys = Object.keys(v as object).slice(0, 6).join(',');
        return `object(keys=${keys})`;
    }
    return typeof v;
}

describe.runIf(LIVE && havePrereqs)('relay live smoke', () => {
    it('readSince pulls messages and we can decrypt at least one', async () => {
        const creds = loadCredentials();
        // eslint-disable-next-line no-console
        console.log(`[live] creds source=${creds.source}`);
        const sess = pickSession();
        expect(sess).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const s = sess!;
        // eslint-disable-next-line no-console
        console.log(`[live] relay=${creds.serverUrl} session=${s.id} variant=${s.variant}`);

        const relay = new RelayClient(creds);
        const page = await relay.readSince(s.id, 0, 5);
        // eslint-disable-next-line no-console
        console.log(`[live] received ${page.messages.length} message(s), hasMore=${page.hasMore}`);
        expect(Array.isArray(page.messages)).toBe(true);
        // The server returned without error — the relay HTTP path is interoperable.
        let decryptedCount = 0;
        for (const m of page.messages) {
            expect(typeof m.seq).toBe('number');
            const b64 = rawContentB64(m.content);
            if (!b64) continue;
            const blob = b64decode(b64);
            const plain = decrypt(s.variant, s.key, blob);
            if (plain !== null) decryptedCount += 1;
            // eslint-disable-next-line no-console
            if (m.seq === page.messages[0].seq) {
                console.log(`[live] first seq=${m.seq} decrypted=${plain !== null} preview=${JSON.stringify(plain).slice(0, 200)}`);
            }
        }
        // eslint-disable-next-line no-console
        console.log(`[live] decrypted ${decryptedCount}/${page.messages.length} messages`);
        // We MUST be able to decrypt at least one if any messages came back —
        // that proves the encryption interop is correct end-to-end.
        if (page.messages.length > 0) expect(decryptedCount).toBeGreaterThan(0);
        relay.close();
    }, 20_000);
});
