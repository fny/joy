import { useLocalSetting } from '@/sync/storage';

// Chat font scale — a device-local multiplier applied to the chat message text
// metrics (user bubbles in MessageView, markdown body in MarkdownView). Read
// reactively so stepping the value on the Appearance screen restyles open
// chats immediately. The value is clamped on read as well as on write so a
// bad persisted value can never blow up the chat layout, and snapped to the
// 0.05 step grid to avoid float drift from repeated +/- stepping.

export const CHAT_FONT_SCALE_MIN = 0.8;
export const CHAT_FONT_SCALE_MAX = 1.4;
export const CHAT_FONT_SCALE_STEP = 0.05;

export function clampChatFontScale(value: number): number {
    if (!Number.isFinite(value)) {
        return 1;
    }
    const clamped = Math.min(CHAT_FONT_SCALE_MAX, Math.max(CHAT_FONT_SCALE_MIN, value));
    // Snap via an integer grid (x20) so 1.0 stays exactly 1 (the "!== 1"
    // reset affordance relies on that) instead of accumulating FP drift.
    return Math.round(clamped * 20) / 20;
}

export function useChatFontScale(): number {
    return clampChatFontScale(useLocalSetting('chatFontScale'));
}
