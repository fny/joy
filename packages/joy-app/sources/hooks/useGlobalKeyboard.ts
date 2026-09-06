import { useEffect } from 'react';
import { Platform } from 'react-native';

/**
 * Cmd/Ctrl+K → open the command palette. While `enabled` is false NO listener
 * is installed: the old no-op-callback approach still preventDefault'ed the
 * key, so disabling the palette also broke the browser's own Ctrl+K (#206).
 */
export function useGlobalKeyboard(onCommandPalette: () => void, enabled: boolean = true) {
    useEffect(() => {
        if (Platform.OS !== 'web' || !enabled) {
            return;
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            // Check for CMD+K (Mac) or Ctrl+K (Windows/Linux)
            const isModifierPressed = e.metaKey || e.ctrlKey;
            
            if (isModifierPressed && e.key === 'k') {
                e.preventDefault();
                e.stopPropagation();
                onCommandPalette();
            }
        };

        // Add event listener
        window.addEventListener('keydown', handleKeyDown);

        // Cleanup
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [onCommandPalette, enabled]);
}