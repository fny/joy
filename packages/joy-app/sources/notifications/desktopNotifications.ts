// Desktop notifications for the web app and the Tauri desktop build.
// - Browsers: the Web Notifications API.
// - Tauri (macOS): the native @tauri-apps/plugin-notification (WKWebView's web
//   Notification support is unreliable), loaded lazily so the web bundle stays lean.
// All functions no-op safely off-web (native mobile uses expo-notifications/push).
import { Platform } from 'react-native';

function isTauri(): boolean {
    return typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

// Ask once. Returns true if granted.
export async function ensureDesktopNotificationPermission(): Promise<boolean> {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
    try {
        if (isTauri()) {
            const n = await import('@tauri-apps/plugin-notification');
            if (await n.isPermissionGranted()) return true;
            return (await n.requestPermission()) === 'granted';
        }
        if (typeof Notification === 'undefined') return false;
        if (Notification.permission === 'granted') return true;
        if (Notification.permission === 'denied') return false;
        return (await Notification.requestPermission()) === 'granted';
    } catch { return false; }
}

// Show a banner. (Web focuses the window on click; deep-linking can come later.)
export async function showDesktopNotification(title: string, body: string): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
        if (isTauri()) {
            const n = await import('@tauri-apps/plugin-notification');
            if (!(await n.isPermissionGranted())) return;
            await n.sendNotification({ title, body });
            return;
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const notif = new Notification(title, { body });
        notif.onclick = () => { try { window.focus(); } catch {} notif.close(); };
    } catch {}
}

// Suppression: only notify when the window is NOT focused (you're not actively
// present) — mirrors the server's "suppress when a client is active/foreground".
export function isWindowFocused(): boolean {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus());
}
