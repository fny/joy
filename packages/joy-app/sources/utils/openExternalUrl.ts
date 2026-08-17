import { Linking, Platform } from 'react-native';
import { isTauri } from './isTauri';

/**
 * Opens a URL in the system browser. Handles Tauri, web, and native platforms.
 * Tauri gets a fallback chain (plugin-opener → raw invoke → window.open) with
 * loud logging — a silently-swallowed opener failure previously made every
 * link in the desktop app a no-op.
 */
export async function openExternalUrl(url: string): Promise<void> {
    if (Platform.OS === 'web') {
        if (isTauri()) {
            try {
                const { openUrl } = await import('@tauri-apps/plugin-opener');
                await openUrl(url);
                return;
            } catch (e) {
                console.error('[openExternalUrl] plugin-opener failed:', e);
            }
            try {
                const { invoke } = await import('@tauri-apps/api/core');
                await invoke('plugin:opener|open_url', { url, with: null });
                return;
            } catch (e) {
                console.error('[openExternalUrl] opener invoke failed:', e);
            }
            // Last resort — Tauri may hand _blank to the system browser.
        }
        if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer');
        }
        return;
    }

    await Linking.openURL(url);
}
