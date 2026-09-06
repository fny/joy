import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { AuthCredentials } from '@/auth/tokenStorage';
import { clearRegisteredPushToken, loadRegisteredPushToken, saveRegisteredPushToken } from './persistence';
import { registerPushToken, unregisterPushToken, type PushApiOptions } from './apiPush';
import { relayScopedMMKV } from './serverConfig';
import {
    hasPendingCleanup,
    needsDisabledCleanup,
    reconcileRegistration,
    serialized,
    unregisterDevice,
    type PushTokenApi,
    type PushTokenStore,
} from './pushTokenReconcile';

// Tokens the relay still holds that this device no longer uses (an old token
// after a rotation, or the device's own token after Mobile push was turned
// off). Persisted so the deletion survives a restart (#385, #181).
const PENDING_UNREGISTER_KEY = 'push-token-pending-unregister';

function pushTokenStore(): PushTokenStore {
    const mmkv = relayScopedMMKV();
    return {
        loadRegistered: loadRegisteredPushToken,
        saveRegistered: saveRegisteredPushToken,
        clearRegistered: clearRegisteredPushToken,
        loadPendingUnregister: () => {
            try {
                const parsed = JSON.parse(mmkv.getString(PENDING_UNREGISTER_KEY) ?? '[]');
                return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
            } catch {
                return [];
            }
        },
        savePendingUnregister: (tokens) => {
            if (tokens.length === 0) mmkv.delete(PENDING_UNREGISTER_KEY);
            else mmkv.set(PENDING_UNREGISTER_KEY, JSON.stringify(tokens));
        },
    };
}

// The caller's cancellation (screen unmount, logout, engine shutdown) rides
// along on every request; the per-attempt deadline is the API helper's own.
function pushTokenApi(credentials: AuthCredentials, options?: PushApiOptions): PushTokenApi {
    return {
        register: (token) => registerPushToken(credentials, token, options),
        unregister: (token) => unregisterPushToken(credentials, token, options),
    };
}

const logCleanup = (message: string, error?: unknown) => console.log(`[push] ${message}`, error ?? '');

export type PushPermissionStatus = 'unsupported' | 'granted' | 'denied' | 'undetermined';

export interface PushPermissionInfo {
    status: PushPermissionStatus;
    granted: boolean;
    canAskAgain: boolean;
}

export interface CurrentPushDeviceMetadata {
    deviceLabel: string;
    appLabel: string | null;
}

export interface PushPermissionRequestResult {
    granted: boolean;
    openedSettings: boolean;
    permission: PushPermissionInfo;
}

export interface SyncCurrentPushTokenResult {
    registered: boolean;
    token: string | null;
    permission: PushPermissionInfo;
}

function normalizePushPermission(result: {
    status: string;
    granted?: boolean;
    canAskAgain?: boolean;
}): PushPermissionInfo {
    const status: PushPermissionStatus =
        result.status === 'granted' || result.status === 'denied' || result.status === 'undetermined'
            ? result.status
            : 'undetermined';

    return {
        status,
        granted: result.granted === true || status === 'granted',
        canAskAgain: result.canAskAgain === true,
    };
}

function getExpoProjectId(): string | null {
    return Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId ?? null;
}

export async function getPushPermissionInfo(): Promise<PushPermissionInfo> {
    if (Platform.OS === 'web') {
        return {
            status: 'unsupported',
            granted: false,
            canAskAgain: false,
        };
    }

    try {
        return normalizePushPermission(await Notifications.getPermissionsAsync());
    } catch (error) {
        console.log('Failed to get push notification permissions:', error);
        return {
            status: 'undetermined',
            granted: false,
            canAskAgain: false,
        };
    }
}

export async function requestPushPermissionOrOpenSettings(): Promise<PushPermissionRequestResult> {
    if (Platform.OS === 'web') {
        return {
            granted: false,
            openedSettings: false,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            }
        };
    }

    const existingPermission = await getPushPermissionInfo();
    if (existingPermission.granted) {
        return {
            granted: true,
            openedSettings: false,
            permission: existingPermission,
        };
    }

    if (existingPermission.canAskAgain) {
        const requestedPermission = normalizePushPermission(await Notifications.requestPermissionsAsync());
        return {
            granted: requestedPermission.granted,
            openedSettings: false,
            permission: requestedPermission,
        };
    }

    await Linking.openSettings();
    return {
        granted: false,
        openedSettings: true,
        permission: existingPermission,
    };
}

export async function getCurrentExpoPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') {
        return null;
    }

    const permission = await getPushPermissionInfo();
    if (!permission.granted) {
        return loadRegisteredPushToken();
    }

    const projectId = getExpoProjectId();
    if (!projectId) {
        return loadRegisteredPushToken();
    }

    try {
        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        return tokenData.data ?? loadRegisteredPushToken();
    } catch (error) {
        console.log('Failed to get Expo push token:', error);
        return loadRegisteredPushToken();
    }
}

export async function syncCurrentPushToken(credentials: AuthCredentials, options?: PushApiOptions): Promise<SyncCurrentPushTokenResult> {
    if (Platform.OS === 'web') {
        return {
            registered: false,
            token: null,
            permission: {
                status: 'unsupported',
                granted: false,
                canAskAgain: false,
            }
        };
    }

    // One sync at a time: a slower sync that learned an obsolete token must not
    // overwrite or unregister the token a newer sync already registered (#386).
    return serialized(async () => {
        let permission = await getPushPermissionInfo();
        if (!permission.granted) {
            if (!permission.canAskAgain) {
                return {
                    registered: false,
                    token: loadRegisteredPushToken(),
                    permission,
                };
            }

            permission = normalizePushPermission(await Notifications.requestPermissionsAsync());
            if (!permission.granted) {
                return {
                    registered: false,
                    token: loadRegisteredPushToken(),
                    permission,
                };
            }
        }

        const projectId = getExpoProjectId();
        if (!projectId) {
            return {
                registered: false,
                token: loadRegisteredPushToken(),
                permission,
            };
        }

        const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
        const currentToken = tokenData.data;
        await reconcileRegistration(pushTokenApi(credentials, options), pushTokenStore(), currentToken, logCleanup);

        return {
            registered: true,
            token: currentToken,
            permission,
        };
    });
}

/**
 * Mobile push was turned off (or is off at startup): delete this device's
 * token from the relay. The setting is device-local and never reaches the
 * relay, so without this the relay kept pushing to the token (#181). A failed
 * deletion stays pending — see `hasPendingPushTokenCleanup` — for a retry.
 */
export async function unregisterCurrentDevicePushToken(credentials: AuthCredentials, options?: PushApiOptions): Promise<{ removed: boolean; pending: string[] }> {
    if (Platform.OS === 'web') {
        return { removed: true, pending: [] };
    }
    return serialized(() => unregisterDevice(pushTokenApi(credentials, options), pushTokenStore(), logCleanup));
}

/**
 * Mobile push is OFF right now (startup, foreground, or the setting just
 * changed): remove whatever of this device is still on the relay. Called by
 * the sync owner's push-token sync, so an offline removal followed by a
 * restart is finished without anyone opening the notifications screen (#181).
 */
export async function reconcileDisabledPushState(credentials: AuthCredentials, options?: PushApiOptions): Promise<void> {
    if (Platform.OS === 'web') return;
    if (!needsDisabledCleanup(pushTokenStore())) return;
    await unregisterCurrentDevicePushToken(credentials, options);
}

/** True while an old (or disabled) token of this device may still be on the relay. */
export function hasPendingPushTokenCleanup(): boolean {
    if (Platform.OS === 'web') return false;
    return hasPendingCleanup(pushTokenStore());
}

export async function removePushToken(credentials: AuthCredentials, token: string, options?: PushApiOptions): Promise<void> {
    await serialized(async () => {
        await unregisterPushToken(credentials, token, options);

        if (loadRegisteredPushToken() === token) {
            clearRegisteredPushToken();
        }
    });
}

export function getCurrentPushDeviceMetadata(): CurrentPushDeviceMetadata {
    const deviceParts = [
        Device.deviceName,
        Device.modelName && Device.modelName !== Device.deviceName ? Device.modelName : null,
        [Device.osName ?? Platform.OS, Device.osVersion].filter(Boolean).join(' '),
    ].filter((value): value is string => !!value && value.trim().length > 0);

    const appParts = [
        Application.nativeApplicationVersion ? `Joy ${Application.nativeApplicationVersion}` : null,
        Application.nativeBuildVersion ? `build ${Application.nativeBuildVersion}` : null,
        Device.isDevice === false ? 'simulator' : null,
    ].filter((value): value is string => !!value);

    return {
        deviceLabel: deviceParts.join(' • ') || `${Platform.OS} device`,
        appLabel: appParts.length > 0 ? appParts.join(' • ') : null,
    };
}
