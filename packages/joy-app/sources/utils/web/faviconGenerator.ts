/**
 * Theme-aware favicon swapper (web). Picks the transparent rainbow-"J" variant
 * that matches the browser's color scheme — the light-echo icon for light mode,
 * the dark-echo icon for dark mode — and swaps to the notification (unread)
 * variant when a session needs attention. Re-applies on color-scheme change.
 */

const NORMAL = { light: '/favicon.ico', dark: '/favicon-dark.ico' };
const ACTIVE = { light: '/favicon-active.ico', dark: '/favicon-active-dark.ico' };

let state: 'normal' | 'active' = 'normal';
let themeListenerAttached = false;

function prefersDark(): boolean {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Updates the favicon in the document
 */
function setFavicon(url: string) {
    if (typeof document === 'undefined') return;

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');

    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.type = 'image/x-icon';
        document.head.appendChild(link);
    }

    // Force reload by adding timestamp
    link.href = url + '?t=' + Date.now();
}

function apply() {
    const variant = state === 'active' ? ACTIVE : NORMAL;
    setFavicon(prefersDark() ? variant.dark : variant.light);
}

// Re-apply the current favicon when the OS/browser color scheme flips.
function ensureThemeListener() {
    if (themeListenerAttached || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    themeListenerAttached = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => apply());
}

/**
 * Updates the favicon to show a notification indicator
 */
export function updateFaviconWithNotification() {
    state = 'active';
    ensureThemeListener();
    apply();
}

/**
 * Resets the favicon to its original state
 */
export function resetFavicon() {
    state = 'normal';
    ensureThemeListener();
    apply();
}
