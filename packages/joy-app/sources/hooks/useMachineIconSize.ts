import { useLocalSetting } from '@/sync/storage';

// The glyph on a machine separator in the session list — the small monitor
// before the host name. Device-local, stepped on the Appearance screen.
//
// Clamped and snapped on READ as well as on write, the same way the identicon
// size is: a value persisted under a different range can only pin to the edge
// of this one, never render a glyph that swamps the 11px label beside it.

export const MACHINE_ICON_MIN = 7;
export const MACHINE_ICON_MAX = 16;
export const MACHINE_ICON_STEP = 1;
export const MACHINE_ICON_DEFAULT = 9;

export function clampMachineIconSize(value: number): number {
    if (!Number.isFinite(value)) {
        return MACHINE_ICON_DEFAULT;
    }
    const clamped = Math.min(MACHINE_ICON_MAX, Math.max(MACHINE_ICON_MIN, value));
    return Math.round(clamped / MACHINE_ICON_STEP) * MACHINE_ICON_STEP;
}

export function useMachineIconSize(): number {
    return clampMachineIconSize(useLocalSetting('machineIconSize'));
}
