import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { createUpdateChecker, type PendingOtaUpdate, type UpdateChecker } from './updateCheck';

export function useUpdates() {
    const [updateAvailable, setUpdateAvailable] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [pendingUpdate, setPendingUpdate] = useState<PendingOtaUpdate | null>(null);

    // ONE synchronous guard for the whole check+download, shared by the
    // initial, foreground and manual checks (#327). The AppState listener is
    // installed once, so it must not read React state to decide.
    const checkerRef = useRef<UpdateChecker | null>(null);
    if (!checkerRef.current) checkerRef.current = createUpdateChecker(Updates);
    const mountedRef = useRef(true);

    const checkForUpdates = useCallback(async () => {
        if (__DEV__) {
            // Don't check for updates in development
            return;
        }
        const checker = checkerRef.current!;
        if (checker.busy) return;
        setIsChecking(true);
        try {
            const outcome = await checker.check();
            if (!mountedRef.current || !outcome) return;
            if (outcome.kind === 'ready') {
                // A rollback (#328) or a genuinely new download (#329) is the
                // only thing worth a reload invitation.
                setPendingUpdate(outcome.pending);
                setUpdateAvailable(true);
            }
        } catch (error) {
            console.error('Error checking for updates:', error);
        } finally {
            if (mountedRef.current) setIsChecking(false);
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        // Check for updates when app becomes active
        const handleAppStateChange = (nextAppState: AppStateStatus) => {
            if (nextAppState === 'active') {
                void checkForUpdates();
            }
        };
        const subscription = AppState.addEventListener('change', handleAppStateChange);

        // Initial check
        void checkForUpdates();

        return () => {
            mountedRef.current = false;
            subscription.remove();
        };
    }, [checkForUpdates]);

    const reloadApp = async () => {
        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                console.error('Error reloading app:', error);
            }
        }
    };

    return {
        updateAvailable,
        isChecking,
        pendingUpdate,
        checkForUpdates,
        reloadApp,
    };
}
