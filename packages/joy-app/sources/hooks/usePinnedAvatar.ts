import { useLocalSetting } from '@/sync/storage';
import type { AvatarVariant } from '@/components/AvatarIdenticon';

/**
 * The identicon on a pinned row: its own size and its own shape.
 *
 * Pins are the one part of the list you built by hand, and they sit above
 * everything else — so it is worth being able to make them look different
 * from an ordinary row rather than merely sit higher than one. They are also
 * one line tall where an ordinary row is three, which is a different amount
 * of space for a mark to live in.
 *
 * Shape defaults to 'match', meaning whatever Appearance → Identicons says,
 * so nothing changes until you ask it to. Size is clamped and snapped on READ
 * as well as on write, like the other size settings.
 */
export const PINNED_AVATAR_MIN = 8;
export const PINNED_AVATAR_MAX = 24;
export const PINNED_AVATAR_STEP = 2;
export const PINNED_AVATAR_DEFAULT = 16;

export type PinnedAvatarShape = 'match' | AvatarVariant;

export function clampPinnedAvatarSize(value: number): number {
    if (!Number.isFinite(value)) {
        return PINNED_AVATAR_DEFAULT;
    }
    const clamped = Math.min(PINNED_AVATAR_MAX, Math.max(PINNED_AVATAR_MIN, value));
    return Math.round(clamped / PINNED_AVATAR_STEP) * PINNED_AVATAR_STEP;
}

/** `variant: undefined` means "whatever the global setting says". */
export function usePinnedAvatar(): { size: number; variant: AvatarVariant | undefined } {
    const size = clampPinnedAvatarSize(useLocalSetting('pinnedAvatarSize'));
    const shape = useLocalSetting('pinnedAvatarShape');
    return { size, variant: shape === 'match' ? undefined : shape };
}
