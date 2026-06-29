// Notifications settings — toggle desktop (web/Tauri) and mobile push alerts.
// Personal-build surface — plain strings.
import * as React from 'react';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Switch } from '@/components/Switch';
import { useSettingMutable } from '@/sync/storage';
import { ensureDesktopNotificationPermission } from '@/notifications/desktopNotifications';

export default React.memo(function NotificationsSettingsScreen() {
    const { theme } = useUnistyles();
    const [notificationsDesktop, setNotificationsDesktop] = useSettingMutable('notificationsDesktop');
    const [notificationsMobile, setNotificationsMobile] = useSettingMutable('notificationsMobile');

    const onDesktopChange = React.useCallback((value: boolean) => {
        setNotificationsDesktop(value);
        if (value) void ensureDesktopNotificationPermission();
    }, [setNotificationsDesktop]);

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
                    rightElement={<Switch value={notificationsMobile} onValueChange={setNotificationsMobile} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
