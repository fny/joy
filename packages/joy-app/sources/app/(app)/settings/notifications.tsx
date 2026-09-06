// Notifications settings — toggle desktop (web/Tauri) and mobile push alerts.
// Personal-build surface — plain strings.
import * as React from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { useAuth } from '@/auth/AuthContext';
import { Modal } from '@/modal';
import { guarded, logError } from '@/utils/guardAsync';
import { ensureDesktopNotificationPermission } from '@/notifications/desktopNotifications';
import { hasPendingPushTokenCleanup, unregisterCurrentDevicePushToken } from '@/sync/pushRegistration';

export default React.memo(function NotificationsSettingsScreen() {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const [notificationsDesktop, setNotificationsDesktop] = useSettingMutable('notificationsDesktop');
    const [notificationsMobile, setNotificationsMobile] = useSettingMutable('notificationsMobile');
    // The relay never learns the (device-local) Mobile push setting, so turning
    // it off must also delete this device's token there — otherwise the relay
    // keeps pushing to it (#181). A deletion the relay did not confirm stays
    // pending and is offered for retry until it succeeds.
    const [pendingCleanup, setPendingCleanup] = React.useState(() => hasPendingPushTokenCleanup());
    const [cleaningUp, setCleaningUp] = React.useState(false);
    // Leaving the screen cancels a removal still in flight; the token stays on
    // the persisted pending list, so the sync owner finishes it (#181).
    const lifetime = React.useRef<AbortController | null>(null);
    if (lifetime.current === null) lifetime.current = new AbortController();
    React.useEffect(() => {
        const controller = lifetime.current!;
        return () => { controller.abort(); };
    }, []);

    const removeDeviceToken = React.useCallback(async (announceFailure: boolean) => {
        if (!auth.credentials || Platform.OS === 'web') return;
        setCleaningUp(true);
        try {
            const result = await unregisterCurrentDevicePushToken(auth.credentials, { signal: lifetime.current?.signal });
            setPendingCleanup(!result.removed);
            if (!result.removed && announceFailure) {
                Modal.alert(
                    'Push token still registered',
                    'The relay could not be reached, so this device may keep receiving push notifications. Joy will retry; you can also tap "Retry token removal" below.',
                );
            }
        } finally {
            setCleaningUp(false);
        }
    }, [auth.credentials]);

    // Retry a removal a previous visit (or a restart mid-way) left pending.
    React.useEffect(() => {
        if (!notificationsMobile && hasPendingPushTokenCleanup()) {
            guarded(() => removeDeviceToken(false), logError)();
        }
    }, [notificationsMobile, removeDeviceToken]);

    const onDesktopChange = React.useCallback((value: boolean) => {
        setNotificationsDesktop(value);
        if (value) void ensureDesktopNotificationPermission();
    }, [setNotificationsDesktop]);

    const onMobileChange = React.useCallback((value: boolean) => {
        setNotificationsMobile(value);
        // Turning it on re-registers through sync's pushTokenSync; turning it
        // off has to remove the token here (#181).
        if (!value) guarded(() => removeDeviceToken(true), logError)();
    }, [setNotificationsMobile, removeDeviceToken]);

    return (
        <ItemList>
            <Stack.Screen options={{ headerTitle: 'Notifications' }} />
            <ItemGroup
                title="Notifications"
                footer="Desktop banners show on this device when the app isn't focused — the same idea as the mobile push, which is suppressed while you have the app open."
            >
                <Item
                    title="Desktop notifications"
                    subtitle="Banners on this device when the app isn't focused. Web & desktop app."
                    icon={<Ionicons name="notifications-outline" size={29} color={theme.colors.accents.blue} />}
                    rightElement={<Switch value={notificationsDesktop} onValueChange={onDesktopChange} />}
                    showChevron={false}
                />
                <Item
                    title="Mobile push"
                    subtitle="Push notifications to your phone."
                    icon={<Ionicons name="phone-portrait-outline" size={29} color={theme.colors.accents.green} />}
                    rightElement={<Switch value={notificationsMobile} onValueChange={onMobileChange} />}
                    showChevron={false}
                />
                {!notificationsMobile && pendingCleanup && (
                    <Item
                        title="Retry token removal"
                        subtitle={cleaningUp
                            ? 'Removing this device\'s push token from the relay…'
                            : 'This device\'s push token is still registered on the relay, so it may keep receiving notifications.'}
                        icon={<Ionicons name="alert-circle-outline" size={29} color={theme.colors.accents.orange} />}
                        onPress={() => guarded(() => removeDeviceToken(true), logError)()}
                        disabled={cleaningUp}
                        showChevron={false}
                    />
                )}
            </ItemGroup>
        </ItemList>
    );
});
