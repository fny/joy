/**
 * Credentials — JWT token + relay server URL.
 *
 * Resolution order (first hit wins):
 *   1. `JOY_CREDS` env (path to a joy-native credentials JSON)
 *   2. `${JOY_HOME}/credentials.json` (joy-native, written by future `joy pair`)
 *   3. `~/.happy/access.key` + `~/.happy/settings.json` (existing happy CLI)
 *      — transparent fallback so an already-paired happy installation
 *        works with joy without re-pairing.
 *
 * The serverUrl precedence within each source:
 *   HAPPY_SERVER_URL env > the source's stored serverUrl > 'https://api.cluster-fluster.com'.
 *
 * `sessionSecret` does NOT live here. Per-session keys are looked up per
 * session by id (see `loadHappySessionKey`) and passed to the daemon's
 * SessionManager at `session.start` time.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../util/log';
import { joyHome } from '../util/paths';
import { b64decode } from './encryption';

const log = logger('credentials');

export interface Credentials {
    token: string;
    serverUrl: string;
    /** Diagnostic: where this came from. */
    source: 'JOY_CREDS' | 'joy-credentials.json' | 'happy/access.key';
    /**
     * Encryption material. For `dataKey` pairings the server holds an opaque
     * blob and only this client (which has `publicKey`/`secretKey`) can ever
     * derive the per-session content key. For `legacy` pairings the secret is
     * shared symmetric. Both shapes coexist in `~/.happy/access.key`.
     */
    encryption:
        | { type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array }
        | { type: 'legacy'; secret: Uint8Array };
}

const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

function defaultServerUrl(stored?: string): string {
    return process.env.HAPPY_SERVER_URL ?? stored ?? DEFAULT_SERVER_URL;
}

interface JoyCredsFile {
    token?: string;
    serverUrl?: string;
    encryption?:
        | { type: 'dataKey'; publicKey: string; machineKey?: string }
        | { type: 'legacy'; secret: string };
}

function tryReadJoyCreds(path: string): Credentials | null {
    if (!existsSync(path)) return null;
    try {
        const obj = JSON.parse(readFileSync(path, 'utf8')) as JoyCredsFile;
        if (!obj.token) return null;
        const encryption = parseEncryption(obj.encryption);
        if (!encryption) {
            log.warn('joy credentials missing/invalid encryption', { path });
            return null;
        }
        return {
            token: obj.token,
            serverUrl: defaultServerUrl(obj.serverUrl),
            source: path === (process.env.JOY_CREDS ?? '') ? 'JOY_CREDS' : 'joy-credentials.json',
            encryption,
        };
    } catch (e) {
        log.warn('joy credentials unreadable', { path, e: String(e) });
        return null;
    }
}

function parseEncryption(e: JoyCredsFile['encryption']): Credentials['encryption'] | null {
    if (!e) return null;
    if (e.type === 'dataKey') {
        if (!e.publicKey) return null;
        return {
            type: 'dataKey',
            publicKey: b64decode(e.publicKey),
            machineKey: e.machineKey ? b64decode(e.machineKey) : new Uint8Array(),
        };
    }
    if (e.type === 'legacy') {
        if (!e.secret) return null;
        return { type: 'legacy', secret: b64decode(e.secret) };
    }
    return null;
}

interface HappyAccessKeyFile {
    token?: string;
    encryption?: {
        publicKey?: string;
        machineKey?: string;
        secret?: string;
    };
}

function tryReadHappyCreds(): Credentials | null {
    const home = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const accessKeyPath = join(home, 'access.key');
    if (!existsSync(accessKeyPath)) return null;
    try {
        const ak = JSON.parse(readFileSync(accessKeyPath, 'utf8')) as HappyAccessKeyFile;
        if (!ak.token) return null;
        let stored: string | undefined;
        try {
            const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { serverUrl?: string };
            stored = s.serverUrl;
        } catch { /* optional */ }
        let encryption: Credentials['encryption'] | null = null;
        if (ak.encryption?.publicKey) {
            encryption = {
                type: 'dataKey',
                publicKey: b64decode(ak.encryption.publicKey),
                machineKey: ak.encryption.machineKey ? b64decode(ak.encryption.machineKey) : new Uint8Array(),
            };
        } else if (ak.encryption?.secret) {
            encryption = { type: 'legacy', secret: b64decode(ak.encryption.secret) };
        }
        if (!encryption) {
            log.warn('~/.happy/access.key has no usable encryption material');
            return null;
        }
        return { token: ak.token, serverUrl: defaultServerUrl(stored), source: 'happy/access.key', encryption };
    } catch (e) {
        log.warn('~/.happy access.key unreadable', { e: String(e) });
        return null;
    }
}

export function loadCredentials(): Credentials {
    const env = process.env.JOY_CREDS;
    if (env) {
        const c = tryReadJoyCreds(env);
        if (c) { log.info('credentials loaded', { source: c.source, serverUrl: c.serverUrl }); return c; }
    }
    const joyPath = join(joyHome(), 'credentials.json');
    const joy = tryReadJoyCreds(joyPath);
    if (joy) { log.info('credentials loaded', { source: joy.source, serverUrl: joy.serverUrl }); return joy; }

    const happy = tryReadHappyCreds();
    if (happy) { log.info('credentials loaded', { source: happy.source, serverUrl: happy.serverUrl }); return happy; }

    throw new Error(
        `joy-daemon: no credentials found. Tried JOY_CREDS, ${joyPath}, and ~/.happy/access.key. ` +
        `Pair with the legacy 'happy connect' flow or write a joy-native credentials.json ({"token":"...","serverUrl":"..."}).`,
    );
}

// ── Per-session encryption keys ─────────────────────────────────────────────

export interface SessionKeyInfo {
    sessionKeyB64: string;
    variant: 'legacy' | 'dataKey';
    source: 'happy/sessions.json';
}

/**
 * Look up a per-session encryption key from `~/.happy/sessions.json` (legacy
 * format) by sessionId. Returns null if the file or entry is missing.
 *
 * This is purely a convenience for joy clients — when starting a session
 * that was originally paired by the legacy CLI, the per-session key is
 * already on disk; we can fall back to it instead of forcing the cli user
 * to paste it. The daemon does NOT read this on its own — joy-cli reads it
 * to populate the `session.start` control call.
 */
export function loadHappySessionKey(sessionId: string): SessionKeyInfo | null {
    const home = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const path = join(home, 'sessions.json');
    if (!existsSync(path)) return null;
    try {
        const f = JSON.parse(readFileSync(path, 'utf8')) as {
            sessions?: Record<string, { encryptionKey?: string; encryptionVariant?: 'legacy' | 'dataKey' }>;
        };
        const s = f.sessions?.[sessionId];
        if (!s?.encryptionKey || !s?.encryptionVariant) return null;
        return { sessionKeyB64: s.encryptionKey, variant: s.encryptionVariant, source: 'happy/sessions.json' };
    } catch {
        return null;
    }
}
