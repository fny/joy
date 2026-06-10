// Prevent iOS Safari's automatic page zoom when an input with
// font-size < 16px gains focus (e.g. the monospace terminal input on
// /joy/pane). Adding maximum-scale=1 to the viewport suppresses exactly
// that focus auto-zoom; iOS deliberately ignores maximum-scale for user
// pinch gestures, so accessibility zoom keeps working.
//
// Done at runtime because web.output is "single" — the +html.tsx shell
// (which carries the same tag for static export) isn't used in that mode.
import { Platform } from 'react-native';

export function preventInputZoom(): void {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="viewport"]');
    const content = 'width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no';
    if (meta) {
        meta.setAttribute('content', content);
    } else {
        const el = document.createElement('meta');
        el.name = 'viewport';
        el.content = content;
        document.head.appendChild(el);
    }
}
