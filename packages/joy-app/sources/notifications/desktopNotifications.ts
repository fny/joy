// Desktop notifications for the web app and the Tauri desktop build.
// - Browsers: the Web Notifications API (click → focus + open the session).
// - Tauri (macOS): the native @tauri-apps/plugin-notification (WKWebView's web
//   Notification support is unreliable), loaded lazily so the web bundle stays lean.
//   The plugin surfaces NO click event on desktop, but a banner click activates
//   the app — so we single-shot navigate to the most recent notification's
//   session on the next window focus (bounded window, only when the
//   notification fired while unfocused).
// All functions no-op safely off-web (native mobile uses expo-notifications/push).
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { navigateToSession } from '@/hooks/useNavigateToSession';

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

function openSession(sessionId: string): void {
    try {
        navigateToSession(router, sessionId);
    } catch (e) {
        console.error('[desktopNotifications] navigate failed:', e);
    }
}

// Tauri focus-heuristic state: the banner click activates the app but no DOM
// event identifies it, so the first focus within the window navigates.
const TAURI_CLICK_WINDOW_MS = 5 * 60 * 1000;
let tauriPending: { sessionId: string; at: number } | null = null;
let tauriFocusListenerInstalled = false;
function armTauriFocusNavigation(sessionId: string): void {
    tauriPending = { sessionId, at: Date.now() };
    if (tauriFocusListenerInstalled) return;
    tauriFocusListenerInstalled = true;
    window.addEventListener('focus', () => {
        const pending = tauriPending;
        tauriPending = null; // single shot — a second focus never re-fires
        if (!pending) return;
        if (Date.now() - pending.at > TAURI_CLICK_WINDOW_MS) return;
        openSession(pending.sessionId);
    });
}

// Show a banner. When sessionId is provided, clicking it opens that session
// (web: real click handler; Tauri: next-focus heuristic — see header).
export async function showDesktopNotification(title: string, body: string, opts?: { sessionId?: string }): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
        if (isTauri()) {
            const n = await import('@tauri-apps/plugin-notification');
            if (!(await n.isPermissionGranted())) return;
            n.sendNotification({ title, body });
            if (opts?.sessionId) armTauriFocusNavigation(opts.sessionId);
            return;
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const notif = new Notification(title, { body });
        notif.onclick = () => {
            try { window.focus(); } catch { /* focus policy */ }
            if (opts?.sessionId) openSession(opts.sessionId);
            notif.close();
        };
    } catch {}
}

// Suppression: only notify when the window is NOT focused (you're not actively
// present) — mirrors the server's "suppress when a client is active/foreground".
export function isWindowFocused(): boolean {
    if (typeof document === 'undefined') return false;
    return document.visibilityState === 'visible' && (typeof document.hasFocus !== 'function' || document.hasFocus());
}
