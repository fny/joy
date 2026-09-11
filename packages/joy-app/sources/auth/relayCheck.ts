import { Modal } from '@/modal';
import { t } from '@/text';
import { relayAccessKeyHeaders, relayNameForUrl, setRelayAccessKey, validateServerUrl } from '@/sync/serverConfig';

/** A relay URL as typed: trimmed, no trailing slash, and a bare host[:port]
 *  gets https:// — the same rule as `joy auth` on the daemon side. */
export function normalizeRelayInput(input: string): string {
    const v = input.trim().replace(/\/+$/, '');
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return v;
    return `https://${v}`;
}

export type RelayProbe = 'ok' | 'gated' | 'error' | 'not_relay' | 'unreachable';

/** One capabilities probe of `url` with the given perimeter key (or the key
 *  saved for THAT relay). 'gated' = the relay answered 401/403: it exists but
 *  wants an access key. */
export async function probeRelay(url: string, accessKey?: string): Promise<RelayProbe> {
    try {
        // joy-relay answers its unauthenticated capabilities probe with
        // `relay: 'joy-relay'`; anything else is not a relay we can talk to.
        // The fetch interceptor only adds the key for the relay already in
        // use, so a relay being checked carries its own saved key here (#160).
        const keyHeaders = accessKey ? { 'X-Joy-Relay-Key': accessKey } : relayAccessKeyHeaders(url);
        const response = await fetch(`${url.replace(/\/+$/, '')}/joy/v2/capabilities`, {
            method: 'GET',
            headers: { 'Accept': 'application/json', ...keyHeaders },
        });
        if (response.status === 401 || response.status === 403) return 'gated';
        if (!response.ok) return 'error';
        const caps = await response.json().catch(() => null) as { relay?: string } | null;
        return caps?.relay === 'joy-relay' ? 'ok' : 'not_relay';
    } catch {
        return 'unreachable';
    }
}

/** Is `url` a joy relay we can reach? A gated relay prompts for its access
 *  key, which is saved for that relay once it works. Resolves an error
 *  sentence, or null when the relay is good to use. */
export async function checkRelay(url: string): Promise<string | null> {
    const shape = validateServerUrl(url);
    if (!shape.valid) return shape.error ?? t('errors.invalidFormat');
    let result = await probeRelay(url);
    if (result === 'gated') {
        const entered = await Modal.prompt(
            t('server.relayAccessKeyLabel'),
            t('server.relayAccessKeyRequired', { relay: relayNameForUrl(url) }),
            { placeholder: '—', inputType: 'secure-text' },
        );
        const key = entered?.trim();
        if (!key) return t('server.serverReturnedError');
        result = await probeRelay(url, key);
        if (result === 'ok') setRelayAccessKey(key, url);
    }
    switch (result) {
        case 'ok': return null;
        case 'not_relay': return t('server.notValidJoyServer');
        case 'unreachable': return t('server.failedToConnectToServer');
        default: return t('server.serverReturnedError');
    }
}
