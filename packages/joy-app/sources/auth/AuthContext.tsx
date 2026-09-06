import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, AuthCredentials } from '@/auth/tokenStorage';
import { syncCreate, sync } from '@/sync/sync';
import * as Updates from 'expo-updates';
import { clearPersistence, loadRegisteredPushToken } from '@/sync/persistence';
import { unregisterPushToken } from '@/sync/apiPush';
import { Platform } from 'react-native';
import { t } from '@/text';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/** How long logout waits for the relay to forget this device's push token
 *  before moving on. Removing the credentials must never depend on the
 *  network: offline, the unregister used to retry forever and the user was
 *  stuck on the account screen with the account still on disk (#9). */
export const LOGOUT_UNREGISTER_TIMEOUT_MS = 4_000;

/** The sync engine boots once per process. If that boot rejected (no
 *  WebCrypto on an insecure origin, a relay that answered garbage), a later
 *  syncCreate is a silent no-op — it cannot be retried without a reload — so
 *  login must not pretend a retry succeeded (#190). */
let syncBootFailed = false;

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(credentials ? { isAuthenticated, credentials, login, logout } : null);
    }, [isAuthenticated, credentials]);

    const login = async (token: string, secret: string) => {
        if (syncBootFailed) {
            throw new Error(t('errors.syncStartFailedReload'));
        }
        const newCredentials: AuthCredentials = { token, secret };
        const previousAuth = getCurrentAuth();
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        // Publish the credentials to the non-React global BEFORE the sync
        // engine boots: syncCreate awaits the first settings/profile
        // fetches, and every /joy/v2 call reads its bearer from
        // getCurrentAuth(). The effect below only runs after setCredentials,
        // which would be after this await — a deadlock (not_logged_in loop).
        setCurrentAuth({ isAuthenticated: true, credentials: newCredentials, login, logout });
        try {
            await syncCreate(newCredentials);
        } catch (error) {
            // Roll the provisional login back so the app does not boot into a
            // half-initialised account on the next start, and so the failure
            // is visible instead of the React state claiming success (#190).
            syncBootFailed = true;
            setCurrentAuth(previousAuth);
            await TokenStorage.removeCredentials();
            throw error;
        }
        setCredentials(newCredentials);
        setIsAuthenticated(true);
    };

    const logout = async () => {
        const registeredPushToken = credentials ? loadRegisteredPushToken() : null;
        if (credentials && registeredPushToken) {
            // Best effort, bounded (#9): the relay-side token is nice to
            // remove, but never worth keeping the account on the device.
            await Promise.race([
                unregisterPushToken(credentials, registeredPushToken).catch((error) => {
                    console.log('Failed to unregister push token during logout:', error);
                }),
                new Promise<void>((resolve) => setTimeout(resolve, LOGOUT_UNREGISTER_TIMEOUT_MS)),
            ]);
        }

        // The credentials must be confirmed gone BEFORE anything else is torn
        // down: a failed SecureStore delete used to be ignored, the UI logged
        // out and reloaded, and the next boot signed straight back in (#188).
        const removed = await TokenStorage.removeCredentials();
        if (!removed) {
            throw new Error(t('errors.logoutFailed'));
        }
        clearPersistence();

        // Stop the previous account's live work now rather than relying on
        // the reload (which rejects in dev builds, #189). The sync singleton
        // still cannot be re-created for another account in this process —
        // that needs a reset hook in sync.ts — but it must at least go quiet.
        try {
            sync.stopV2Live();
        } catch (error) {
            console.log('Failed to stop live sync during logout:', error);
        }
        setCurrentAuth(null);

        // Update React state to ensure UI consistency
        setCredentials(null);
        setIsAuthenticated(false);

        if (Platform.OS === 'web') {
            window.location.reload();
        } else {
            try {
                await Updates.reloadAsync();
            } catch (error) {
                // In dev mode, reloadAsync will throw ERR_UPDATES_DISABLED
                console.log('Reload failed (expected in dev mode):', error);
            }
        }
    };

    return (
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
