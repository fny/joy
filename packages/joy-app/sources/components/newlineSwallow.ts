/**
 * True when `text` is `base` with exactly one "\n" inserted somewhere.
 *
 * On iOS/Android a return key the onKeyPress handler consumed (autocomplete
 * applied a suggestion) still inserts a newline natively — preventDefault is a
 * no-op there — and the following onChangeText overwrote the applied
 * suggestion (#27). MultiTextInput swallows a change matching this shape that
 * arrives right after a handled Enter.
 */
export function isTextPlusOneNewline(base: string, text: string): boolean {
    if (text.length !== base.length + 1) return false;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) !== 10) continue;
        if (text.slice(0, i) + text.slice(i + 1) === base) return true;
    }
    return false;
}
