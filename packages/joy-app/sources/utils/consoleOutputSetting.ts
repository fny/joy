import { hasOwn } from '@/utils/safeGet';

/**
 * Initial console-output state at boot: the user's EXPLICIT preference wins;
 * only an unset preference falls back to the build variant's default.
 *
 * Before (#425) this was `settings.consoleLoggingEnabled || config.default`:
 * the parsed local settings fill a missing field with `false`, so an explicit
 * `false` and "never set" were indistinguishable and a dev/preview build
 * (default true) re-enabled logging on every restart despite the user having
 * turned it off. Reads the RAW persisted JSON so presence of the key is known.
 */
export function resolveConsoleOutputEnabled(rawLocalSettings: string | null | undefined, buildDefault: boolean | undefined): boolean {
    if (rawLocalSettings) {
        try {
            const parsed: unknown = JSON.parse(rawLocalSettings);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && hasOwn(parsed, 'consoleLoggingEnabled')) {
                const value = (parsed as Record<string, unknown>).consoleLoggingEnabled;
                if (typeof value === 'boolean') return value;
            }
        } catch {
            // unreadable settings: fall through to the build default
        }
    }
    return buildDefault ?? false;
}
