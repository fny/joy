import { describe, expect, it } from 'vitest';
import { resolveConsoleOutputEnabled } from './consoleOutputSetting';

describe('resolveConsoleOutputEnabled (#425)', () => {
    it('an explicit false survives a restart in a build whose default is true', () => {
        expect(resolveConsoleOutputEnabled(JSON.stringify({ consoleLoggingEnabled: false }), true)).toBe(false);
    });

    it('an explicit true wins over a build default of false', () => {
        expect(resolveConsoleOutputEnabled(JSON.stringify({ consoleLoggingEnabled: true }), false)).toBe(true);
    });

    it('an unset preference uses the build default, then off', () => {
        expect(resolveConsoleOutputEnabled(JSON.stringify({ theme: 'dark' }), true)).toBe(true);
        expect(resolveConsoleOutputEnabled(JSON.stringify({ theme: 'dark' }), false)).toBe(false);
        expect(resolveConsoleOutputEnabled(null, undefined)).toBe(false);
        expect(resolveConsoleOutputEnabled(undefined, true)).toBe(true);
    });

    it('a malformed value or unreadable blob falls back to the build default', () => {
        expect(resolveConsoleOutputEnabled(JSON.stringify({ consoleLoggingEnabled: 'yes' }), true)).toBe(true);
        expect(resolveConsoleOutputEnabled('{not json', true)).toBe(true);
        expect(resolveConsoleOutputEnabled('[1,2]', false)).toBe(false);
    });
});
