import { describe, it, expect } from 'vitest';
import { localSettingsParse, localSettingsDefaults } from './localSettings';

describe('localSettingsParse — one invalid preference does not reset the rest (#380)', () => {
    it('keeps appLock, theme and font when an unrelated field is malformed', () => {
        const parsed = localSettingsParse({
            appLock: true,
            themePreference: 'dark',
            fontOverride: 'JetBrains Mono',
            limitSessionMemory: '5', // string where a number is expected
        });
        expect(parsed.appLock).toBe(true);
        expect(parsed.themePreference).toBe('dark');
        expect(parsed.fontOverride).toBe('JetBrains Mono');
        expect(parsed.limitSessionMemory).toBe(localSettingsDefaults.limitSessionMemory); // only the bad field falls back
    });

    it('returns defaults for non-object input', () => {
        expect(localSettingsParse(null)).toEqual(localSettingsDefaults);
        expect(localSettingsParse('x')).toEqual(localSettingsDefaults);
        expect(localSettingsParse([])).toEqual(localSettingsDefaults);
    });

    it('preserves unknown fields written by a newer app version', () => {
        const parsed = localSettingsParse({ appLock: true, futureFlag: 'yes' }) as Record<string, unknown>;
        expect(parsed.futureFlag).toBe('yes');
        expect(parsed.appLock).toBe(true);
    });

    it('still coerces a retired avatarVariant instead of resetting anything', () => {
        const parsed = localSettingsParse({ appLock: true, avatarVariant: 'hashicon' });
        expect(parsed.avatarVariant).toBe('circles');
        expect(parsed.appLock).toBe(true);
    });
});
