import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Platform } from 'react-native';
import { useAuth } from '@/auth/AuthContext';
import Ionicons from '@expo/vector-icons/Ionicons';
import { copyToClipboard } from '@/utils/clipboard';
import { alertError, guarded } from '@/utils/guardAsync';
import { isLatest, nextGen, retire, useLatestKey } from '@/utils/latest';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { formatSecretKeyForBackup } from '@/auth/secretKeyBackup';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { layout } from '@/components/layout';
import { useSettingMutable, useProfile } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useUnistyles } from 'react-native-unistyles';
import { Switch } from '@/components/Switch';
import { useConnectAccount } from '@/hooks/useConnectAccount';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl, relayNameForUrl, getStoredRelayAccessKey, setRelayAccessKey } from '@/sync/serverConfig';
import { getDisplayName } from '@/sync/profile';
import { fetchPushTokens, type PushToken } from '@/sync/apiPush';
import {
    getCurrentExpoPushToken,
    getCurrentPushDeviceMetadata,
    getPushPermissionInfo,
    requestPushPermissionOrOpenSettings,
    removePushToken,
    syncCurrentPushToken,
    type PushPermissionInfo,
} from '@/sync/pushRegistration';

function formatPushPermissionLabel(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Loading';
    }
    if (permission.status === 'unsupported') {
        return 'Unavailable';
    }
    if (permission.granted) {
        return 'Allowed';
    }
    if (permission.status === 'denied') {
        return 'Denied';
    }
    return 'Not requested';
}

function formatPushPermissionSubtitle(permission: PushPermissionInfo | null): string {
    if (!permission) {
        return 'Checking push notification permissions for this device.';
    }
    if (permission.status === 'unsupported') {
        return 'Push notification permissions are only managed on mobile devices.';
    }
    if (permission.granted) {
        return 'This device can receive push notifications.';
    }
    if (permission.canAskAgain) {
        return 'The system prompt can still be shown again from the app.';
    }
    return 'iOS has stopped prompting. Open system settings to enable notifications again.';
}

/** Why a granted permission still produced no relay registration (#168). */
function describeMissingRegistration(result: { registered: boolean; token: string | null; permission: PushPermissionInfo }): string {
    if (!result.permission.granted) {
        return 'Push notification permission was not granted.';
    }
    // registered:false with permission granted has exactly one cause today:
    // no Expo project id, so no token could be requested from Expo.
    const base = 'Notification permission is granted, but this build has no Expo project id, so no push token could be obtained or registered with the relay.';
    return result.token ? `${base} The previously registered token stays in place.` : base;
}

function formatPushTokenFingerprint(token: string): string {
    const rawValue = token.replace(/^ExponentPushToken\[/, '').replace(/\]$/, '');
    if (rawValue.length <= 12) {
        return rawValue;
    }
    return `${rawValue.slice(0, 6)}…${rawValue.slice(-6)}`;
}

function formatPushTimestamp(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function buildPushTokenSubtitle(pushToken: PushToken, options: {
    isCurrentDevice: boolean;
    currentDeviceLabel: string;
    currentAppLabel: string | null;
}): string {
    const lines: string[] = [];

    if (options.isCurrentDevice) {
        lines.push(options.currentDeviceLabel);
        if (options.currentAppLabel) {
            lines.push(options.currentAppLabel);
        }
    } else {
        lines.push('Other device or stale registration');
    }

    lines.push(`Registered: ${formatPushTimestamp(pushToken.createdAt)}`);
    lines.push(`Last seen: ${formatPushTimestamp(pushToken.updatedAt)}`);
    lines.push(`Server ID: ${pushToken.id}`);
    lines.push(`Token: ${formatPushTokenFingerprint(pushToken.token)}`);
    return lines.join('\n');
}

export default React.memo(() => {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [showSecret, setShowSecret] = useState(false);
    const [copiedRecently, setCopiedRecently] = useState(false);
    const router = useRouter();
    const { connectAccount, isLoading: isConnecting } = useConnectAccount();
    const profile = useProfile();
    const currentPushDevice = useMemo(() => getCurrentPushDeviceMetadata(), []);
    const [pushTokens, setPushTokens] = useState<PushToken[]>([]);
    const [pushPermission, setPushPermission] = useState<PushPermissionInfo | null>(null);
    const [currentPushToken, setCurrentPushToken] = useState<string | null>(null);
    const [loadingPushSettings, setLoadingPushSettings] = useState(false);
    const [requestingPushPermission, setRequestingPushPermission] = useState(false);
    const [refreshingPushToken, setRefreshingPushToken] = useState(false);
    const [deletingPushToken, setDeletingPushToken] = useState<string | null>(null);

    // The relay this device talks to, and its perimeter password (a gated
    // relay refuses every connection without it). Changing relay lives on the
    // relay screen, behind signing out.
    const activeServerUrl = getServerUrl();
    const [relayKeyTick, setRelayKeyTick] = useState(0);
    const hasRelayPassword = useMemo(() => !!getStoredRelayAccessKey(activeServerUrl), [activeServerUrl, relayKeyTick]);
    const handleSetRelayPassword = useCallback(async () => {
        const next = await Modal.prompt(
            t('settingsAccount.relayPassword'),
            t('settingsAccount.relayPasswordMessage', { relay: relayNameForUrl(activeServerUrl) }),
            {
                defaultValue: getStoredRelayAccessKey(activeServerUrl) ?? '',
                placeholder: '—',
                confirmText: t('common.save'),
                inputType: 'secure-text',
            },
        );
        if (next === null) return; // cancelled
        setRelayAccessKey(next.trim() || null, activeServerUrl);
        setRelayKeyTick((n) => n + 1);
        // Bounce the v2 live stream so the next connect carries (or drops) it.
        sync.stopV2Live();
        sync.startV2Live();
    }, [activeServerUrl]);

    // Get the current secret key
    const currentSecret = auth.credentials?.secret || '';
    const formattedSecret = currentSecret ? formatSecretKeyForBackup(currentSecret) : '';

    // Profile display values
    const displayName = getDisplayName(profile);

    // Every push-settings load is a generation: a slower earlier load (mount
    // and focus used to start two) can no longer restore a token row that a
    // later delete-and-reload removed, and the loading flag follows the
    // newest request only (#167). Token registration/deletion retire whatever
    // is in flight before they start.
    const pushKey = useLatestKey('push-settings');
    // Push requests this screen starts are cancelled when it unmounts: the
    // generation check above drops a late RESULT, the signal stops the
    // REQUEST (and its retries) as well. A user-confirmed token delete is
    // deliberately not on it — leaving the screen must not undo a delete.
    const pushLifetime = useRef<AbortController | null>(null);
    if (pushLifetime.current === null) pushLifetime.current = new AbortController();
    useEffect(() => {
        const controller = pushLifetime.current!;
        return () => { controller.abort(); };
    }, []);
    const pushSignal = pushLifetime.current.signal;
    const loadPushSettings = useCallback(async (showError = false) => {
        if (!auth.credentials) {
            retire(pushKey);
            setPushTokens([]);
            setPushPermission(null);
            setCurrentPushToken(null);
            return;
        }

        const gen = nextGen(pushKey);
        setLoadingPushSettings(true);
        try {
            const [tokens, permission, liveToken] = await Promise.all([
                fetchPushTokens(auth.credentials, { signal: pushSignal }),
                getPushPermissionInfo(),
                getCurrentExpoPushToken(),
            ]);
            if (!isLatest(pushKey, gen)) return;
            setPushTokens(tokens);
            setPushPermission(permission);
            setCurrentPushToken(liveToken);
        } catch (error) {
            if (!isLatest(pushKey, gen)) return;
            console.error('Failed to load push notification settings:', error);
            if (showError) {
                Modal.alert(t('common.error'), 'Failed to load push notification settings.');
            }
        } finally {
            if (isLatest(pushKey, gen)) setLoadingPushSettings(false);
        }
    }, [auth.credentials, pushKey, pushSignal]);

    // Focus fires on mount as well, so one load per visit (not mount + focus).
    useFocusEffect(
        useCallback(() => {
            void loadPushSettings();
        }, [loadPushSettings])
    );

    const handleShowSecret = () => {
        setShowSecret(!showSecret);
    };

    const handleCopySecret = async () => {
        if (!(await copyToClipboard(formattedSecret, { failureMessage: t('settingsAccount.secretKeyCopyFailed') }))) return;
        setCopiedRecently(true);
        setTimeout(() => setCopiedRecently(false), 2000);
        Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
    };

    const handleLogout = async () => {
        const confirmed = await Modal.confirm(
            t('common.logout'),
            t('settingsAccount.logoutConfirm'),
            { confirmText: t('common.logout'), destructive: true }
        );
        if (confirmed) {
            guarded(() => auth.logout(), alertError())();
        }
    };

    const handlePushPermissionRequest = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRequestingPushPermission(true);
        retire(pushKey); // a load already in flight predates the registration
        try {
            const result = await requestPushPermissionOrOpenSettings();
            setPushPermission(result.permission);

            if (result.granted) {
                // OS permission is not registration: without an Expo project id
                // (or when the token fetch fails) nothing reaches the relay, and
                // this used to claim success anyway (#168).
                const registration = await syncCurrentPushToken(auth.credentials, { signal: pushSignal });
                await loadPushSettings();
                if (registration.registered && registration.token) {
                    Modal.alert(t('common.success'), 'Push notifications are enabled for this device.');
                } else {
                    Modal.alert('Not registered', describeMissingRegistration(registration));
                }
                return;
            }

            await loadPushSettings();

            if (result.openedSettings) {
                Modal.alert('Open Settings', 'The system will not show the permission prompt again, so Joy opened Settings instead.');
                return;
            }

            Modal.alert(t('common.error'), 'Push notification permission was not granted.');
        } catch (error) {
            console.error('Failed to request push permission:', error);
            Modal.alert(t('common.error'), 'Failed to request push notification permission.');
        } finally {
            setRequestingPushPermission(false);
        }
    }, [auth.credentials, loadPushSettings, pushKey, pushSignal]);

    const handleRefreshCurrentPushToken = useCallback(async () => {
        if (!auth.credentials) {
            return;
        }

        setRefreshingPushToken(true);
        retire(pushKey);
        try {
            const result = await syncCurrentPushToken(auth.credentials, { signal: pushSignal });
            setPushPermission(result.permission);
            await loadPushSettings();

            if (!result.permission.granted) {
                Modal.alert(t('common.error'), 'Push notifications are not enabled for this device yet.');
                return;
            }

            // Permission alone does not mean a token was sent to the relay (#168).
            if (!result.registered || !result.token) {
                Modal.alert('Not registered', describeMissingRegistration(result));
                return;
            }

            Modal.alert(t('common.success'), 'This device push token was refreshed.');
        } catch (error) {
            console.error('Failed to refresh push token:', error);
            Modal.alert(t('common.error'), 'Failed to refresh this device push token.');
        } finally {
            setRefreshingPushToken(false);
        }
    }, [auth.credentials, loadPushSettings, pushKey, pushSignal]);

    const handleDeletePushToken = useCallback(async (pushToken: PushToken) => {
        if (!auth.credentials) {
            return;
        }

        const confirmed = await Modal.confirm(
            'Delete Push Token',
            `Remove ${formatPushTokenFingerprint(pushToken.token)} from your account?`,
            { confirmText: t('common.delete'), destructive: true }
        );

        if (!confirmed) {
            return;
        }

        setDeletingPushToken(pushToken.token);
        retire(pushKey); // a load already in flight predates the delete
        try {
            await removePushToken(auth.credentials, pushToken.token);
            await loadPushSettings();
        } catch (error) {
            console.error('Failed to delete push token:', error);
            Modal.alert(t('common.error'), 'Failed to delete push token.');
        } finally {
            setDeletingPushToken(null);
        }
    }, [auth.credentials, loadPushSettings, pushKey]);

    return (
        <>
            <ItemList>
                {/* Account Info */}
                <ItemGroup title={t('settingsAccount.accountInformation')}>
                    <Item
                        title={t('settingsAccount.status')}
                        detail={auth.isAuthenticated ? t('settingsAccount.statusActive') : t('settingsAccount.statusNotAuthenticated')}
                        showChevron={false}
                    />
                    <Item
                        title={t('settingsAccount.anonymousId')}
                        detail={sync.anonID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.anonID}
                    />
                    <Item
                        title={t('settingsAccount.publicId')}
                        detail={sync.serverID || t('settingsAccount.notAvailable')}
                        showChevron={false}
                        copy={!!sync.serverID}
                    />
                    {Platform.OS !== 'web' && (
                        <Item
                            title={t('settingsAccount.linkNewDevice')}
                            subtitle={isConnecting ? t('common.scanning') : t('settingsAccount.linkNewDeviceSubtitle')}
                            icon={<Ionicons name="qr-code-outline" size={29} color="#007AFF" />}
                            onPress={connectAccount}
                            disabled={isConnecting}
                            showChevron={false}
                        />
                    )}
                </ItemGroup>

                {/* Relay */}
                <ItemGroup title={t('settingsAccount.relay')} footer={t('settingsAccount.relayFooter')}>
                    <Item
                        title={relayNameForUrl(activeServerUrl)}
                        subtitle={activeServerUrl.replace(/^https?:\/\//, '') + (hasRelayPassword ? ` · ${t('settingsAccount.relayPasswordSet')}` : '')}
                        icon={<Ionicons name="git-network-outline" size={29} color={theme.colors.accents.green} />}
                        rightElement={(
                            <Pressable
                                onPress={() => void handleSetRelayPassword()}
                                hitSlop={10}
                                accessibilityRole="button"
                                accessibilityLabel={t('settingsAccount.relayPassword')}
                            >
                                <Ionicons
                                    name={hasRelayPassword ? 'lock-closed' : 'lock-open-outline'}
                                    size={20}
                                    color={hasRelayPassword ? theme.colors.textLink : theme.colors.textSecondary}
                                />
                            </Pressable>
                        )}
                        onPress={() => router.push('/server')}
                    />
                </ItemGroup>

                {/* Profile Section */}
                {displayName && (
                    <ItemGroup title={t('settingsAccount.profile')}>
                        {displayName && (
                            <Item
                                title={t('settingsAccount.name')}
                                detail={displayName}
                                showChevron={false}
                            />
                        )}
                    </ItemGroup>
                )}

                {/* Backup Section */}
                <ItemGroup
                    title={t('settingsAccount.backup')}
                    footer={t('settingsAccount.backupDescription')}
                >
                    <Item
                        title={t('settingsAccount.secretKey')}
                        subtitle={showSecret ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        icon={<Ionicons name={showSecret ? "eye-off-outline" : "eye-outline"} size={29} color="#FF9500" />}
                        onPress={handleShowSecret}
                        showChevron={false}
                    />
                </ItemGroup>

                {/* Secret Key Display */}
                {showSecret && (
                    <ItemGroup>
                        <Pressable onPress={handleCopySecret}>
                            <View style={{
                                backgroundColor: theme.colors.surface,
                                paddingHorizontal: 16,
                                paddingVertical: 14,
                                width: '100%',
                                maxWidth: layout.maxWidth,
                                alignSelf: 'center'
                            }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                                    <Text style={{
                                        fontSize: 11,
                                        color: theme.colors.textSecondary,
                                        letterSpacing: 0.5,
                                        textTransform: 'uppercase',
                                        ...Typography.default('semiBold')
                                    }}>
                                        {t('settingsAccount.secretKeyLabel')}
                                    </Text>
                                    <Ionicons
                                        name={copiedRecently ? "checkmark-circle" : "copy-outline"}
                                        size={18}
                                        color={copiedRecently ? "#34C759" : theme.colors.textSecondary}
                                    />
                                </View>
                                <Text style={{
                                    fontSize: 13,
                                    letterSpacing: 0.5,
                                    lineHeight: 20,
                                    color: theme.colors.text,
                                    ...Typography.mono()
                                }}>
                                    {formattedSecret}
                                </Text>
                            </View>
                        </Pressable>
                    </ItemGroup>
                )}


                <ItemGroup
                    title="Push Notifications"
                    footer="Shows every push token registered on your account. Tap an old token to delete it."
                >
                    <Item
                        title="Permission"
                        detail={formatPushPermissionLabel(pushPermission)}
                        subtitle={formatPushPermissionSubtitle(pushPermission)}
                        icon={<Ionicons name="notifications-outline" size={29} color="#007AFF" />}
                        loading={loadingPushSettings}
                        showChevron={false}
                    />
                    <Item
                        title="Request Permission Again"
                        subtitle={pushPermission?.status === 'unsupported'
                            ? 'Push notification permissions are only available on iPhone and Android.'
                            : pushPermission?.canAskAgain
                            ? 'Shows the system prompt again if iOS still allows it.'
                            : 'Opens system settings when iOS will not prompt again.'}
                        icon={<Ionicons name="shield-checkmark-outline" size={29} color="#34C759" />}
                        onPress={handlePushPermissionRequest}
                        loading={requestingPushPermission}
                        disabled={requestingPushPermission || loadingPushSettings || pushPermission?.status === 'unsupported' || !auth.credentials}
                        showChevron={false}
                    />
                    <Item
                        title="Re-register This Device"
                        subtitle={currentPushToken
                            ? `Current token ${formatPushTokenFingerprint(currentPushToken)}`
                            : 'Fetches the current Expo token and registers it again.'}
                        icon={<Ionicons name="refresh-outline" size={29} color="#FF9500" />}
                        onPress={handleRefreshCurrentPushToken}
                        loading={refreshingPushToken}
                        disabled={refreshingPushToken || loadingPushSettings || !auth.credentials}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title={`Registered Tokens (${pushTokens.length})`}
                    footer="Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps."
                >
                    {pushTokens.length === 0 ? (
                        <Item
                            title="No registered push tokens"
                            subtitle="Once this device is registered, it will appear here."
                            showChevron={false}
                        />
                    ) : (
                        <>
                            {pushTokens.map((pushToken) => {
                                const isCurrentDevice = currentPushToken === pushToken.token;
                                return (
                                    <Item
                                        key={pushToken.id}
                                        title={formatPushTokenFingerprint(pushToken.token)}
                                        detail={isCurrentDevice ? 'This device' : undefined}
                                        subtitle={buildPushTokenSubtitle(pushToken, {
                                            isCurrentDevice,
                                            currentDeviceLabel: currentPushDevice.deviceLabel,
                                            currentAppLabel: currentPushDevice.appLabel,
                                        })}
                                        subtitleLines={0}
                                        icon={(
                                            <Ionicons
                                                name={isCurrentDevice ? 'phone-portrait-outline' : 'trash-outline'}
                                                size={29}
                                                color={isCurrentDevice ? theme.colors.textSecondary : '#FF3B30'}
                                            />
                                        )}
                                        onPress={isCurrentDevice ? undefined : () => handleDeletePushToken(pushToken)}
                                        loading={deletingPushToken === pushToken.token}
                                        disabled={deletingPushToken !== null}
                                        showChevron={false}
                                        copy={isCurrentDevice ? pushToken.token : false}
                                    />
                                );
                            })}
                        </>
                    )}
                </ItemGroup>

                {/* Danger Zone */}
                <ItemGroup title={t('settingsAccount.dangerZone')}>
                    <Item
                        title={t('settingsAccount.logout')}
                        subtitle={t('settingsAccount.logoutSubtitle')}
                        icon={<Ionicons name="log-out-outline" size={29} color="#FF3B30" />}
                        destructive
                        onPress={handleLogout}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
});
