/**
 * Account credentials loaded from disk. joy-daemon is interop with the existing
 * relay; it expects the same on-disk credentials format the legacy CLI writes
 * (token + 32-byte session secret). The path is configurable via JOY_CREDS or
 * defaults to ${JOY_HOME}/credentials.json.
 *
 * For pairing/QR/auth the user runs the legacy `happy connect` flow today; the
 * owned-core daemon reuses those credentials and does not own pairing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { joyHome } from '../util/paths';
import { b64decode } from './encryption';

export interface Credentials {
    /** Bearer token presented to the relay server. */
    token: string;
    /** 32-byte session secret used for E2E encryption (XSalsa20-Poly1305). */
    sessionSecret: Uint8Array;
    /** Base URL of the relay server (e.g. https://api.happy-servers.com). */
    serverUrl: string;
}

export function credentialsPath(): string {
    return process.env.JOY_CREDS ?? join(joyHome(), 'credentials.json');
}

interface OnDiskCreds {
    token: string;
    sessionSecret: string; // base64
    serverUrl?: string;
}

export function loadCredentials(): Credentials {
    const p = credentialsPath();
    let raw: string;
    try {
        raw = readFileSync(p, 'utf8');
    } catch (e) {
        throw new Error(`joy-daemon: credentials not found at ${p} — run pairing (legacy 'happy connect') first`);
    }
    const obj = JSON.parse(raw) as OnDiskCreds;
    if (!obj.token || !obj.sessionSecret) {
        throw new Error(`joy-daemon: credentials at ${p} missing token/sessionSecret`);
    }
    return {
        token: obj.token,
        sessionSecret: b64decode(obj.sessionSecret),
        serverUrl: obj.serverUrl ?? process.env.HAPPY_SERVER_URL ?? 'https://api.happy-servers.com',
    };
}
