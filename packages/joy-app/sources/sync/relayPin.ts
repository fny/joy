import { hasServerUrl, setServerUrl } from './serverConfig';
import { TokenStorage, type AuthCredentials } from '@/auth/tokenStorage';

// ONE-TIME MIGRATION, 2026-09-11 — delete this file (and its call in
// app/_layout.tsx) once every install has run a build that carries it.
//
// Until this build the app fell back to a built-in relay whenever none was
// saved, so a signed-in install could have no relay saved at all — it was
// simply on the fallback. The fallback is gone. Before anything reads the
// relay, an install that has NO relay saved but DOES hold credentials for
// the retired built-in relay has that relay saved explicitly: it stays
// signed in, on the relay it was already using, and nothing moves. An
// install without such credentials (fresh, or signed out) saves nothing and
// the welcome screen asks for a relay.
//
// The URL has to be named here: the credential store cannot list its keys,
// so the only way to find the old slot is to ask for it by relay.
export const RETIRED_BUILTIN_RELAY = 'https://joy.voltai.party:4997';

export interface RelayPinDeps {
    hasServerUrl: () => boolean;
    setServerUrl: (url: string) => void;
    getCredentials: (url: string) => Promise<AuthCredentials | null>;
}

const defaults: RelayPinDeps = {
    hasServerUrl,
    setServerUrl: (url) => setServerUrl(url),
    getCredentials: (url) => TokenStorage.getCredentials(url),
};

/** Resolves true when it saved the retired relay for this install. */
export async function pinRetiredBuiltinRelay(deps: RelayPinDeps = defaults): Promise<boolean> {
    if (deps.hasServerUrl()) return false;
    const credentials = await deps.getCredentials(RETIRED_BUILTIN_RELAY);
    if (!credentials) return false;
    deps.setServerUrl(RETIRED_BUILTIN_RELAY);
    return true;
}
