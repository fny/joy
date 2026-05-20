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

const log = logger('credentials');

export interface Credentials {
    token: string;
    serverUrl: string;
    /** Diagnostic: where this came from. */
    source: 'JOY_CREDS' | 'joy-credentials.json' | 'happy/access.key';
}

const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

function defaultServerUrl(stored?: string): string {
    return process.env.HAPPY_SERVER_URL ?? stored ?? DEFAULT_SERVER_URL;
}

function tryReadJoyCreds(path: string): Credentials | null {
    if (!existsSync(path)) return null;
    try {
        const obj = JSON.parse(readFileSync(path, 'utf8')) as { token?: string; serverUrl?: string };
        if (!obj.token) return null;
        return {
            token: obj.token,
            serverUrl: defaultServerUrl(obj.serverUrl),
            source: path === (process.env.JOY_CREDS ?? '') ? 'JOY_CREDS' : 'joy-credentials.json',
        };
    } catch (e) {
        log.warn('joy credentials unreadable', { path, e: String(e) });
        return null;
    }
}

function tryReadHappyCreds(): Credentials | null {
    const home = process.env.HAPPY_HOME_DIR
        ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
        : join(homedir(), '.happy');
    const accessKeyPath = join(home, 'access.key');
    if (!existsSync(accessKeyPath)) return null;
    try {
        const ak = JSON.parse(readFileSync(accessKeyPath, 'utf8')) as { token?: string };
        if (!ak.token) return null;
        let stored: string | undefined;
        try {
            const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { serverUrl?: string };
            stored = s.serverUrl;
        } catch { /* optional */ }
        return { token: ak.token, serverUrl: defaultServerUrl(stored), source: 'happy/access.key' };
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
