import { useLocalSetting } from '@/sync/storage';

// Session-list identicon size — a device-local px value stepped on the
// Appearance screen. Clamped and snapped on READ as well as on write, so a
// value persisted under an older range (the size stepper used to go to 48)
// can't render a giant mark in the session list; it just pins to the max.

export const AVATAR_SIZE_MIN = 8;
export const AVATAR_SIZE_MAX = 24;
export const AVATAR_SIZE_STEP = 2;
export const AVATAR_SIZE_DEFAULT = 16;

export function clampSessionAvatarSize(value: number): number {
    if (!Number.isFinite(value)) {
        return AVATAR_SIZE_DEFAULT;
    }
    const clamped = Math.min(AVATAR_SIZE_MAX, Math.max(AVATAR_SIZE_MIN, value));
    // Snap to the 2px grid so a legacy odd/off-grid value steps cleanly.
    return Math.round(clamped / AVATAR_SIZE_STEP) * AVATAR_SIZE_STEP;
}

export function useSessionAvatarSize(): number {
    return clampSessionAvatarSize(useLocalSetting('sessionAvatarSize'));
}
