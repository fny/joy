/**
 * Strip ONLY the dev-login query parameters from a URL, keeping every other
 * query parameter and the fragment.
 *
 * Startup used to `replaceState(pathname)` after consuming dev credentials,
 * which also erased "#key=<publicKey>" from /terminal/connect links before
 * the approval screen mounted — terminal pairing failed whenever
 * EXPO_PUBLIC_DEV_TOKEN/SECRET auto-login was enabled (#185).
 */
export const DEV_CREDENTIAL_PARAMS = ['dev_token', 'dev_secret'] as const;

/** Returns the relative URL (path + remaining query + hash) without the dev credential params. */
export function stripDevCredentialParams(href: string): string {
    const url = new URL(href, 'http://localhost');
    for (const key of DEV_CREDENTIAL_PARAMS) url.searchParams.delete(key);
    return url.pathname + url.search + url.hash;
}
