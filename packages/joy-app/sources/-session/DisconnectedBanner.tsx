import * as React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSocketStatus } from '@/sync/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// Discrete "no connection" notice pinned at the top of the session — same
// unobtrusive register as the other in-session notices (DialogBar etc.). Shown
// only after the socket has been down briefly, so a fast reconnect (or the
// normal cold-start connect) never flashes it. While it's up, a sent message
// queues (PendingQueueStrip) and retries on reconnect.
export const DisconnectedBanner = React.memo(function DisconnectedBanner() {
    const { theme } = useUnistyles();
    const { status } = useSocketStatus();
    const offline = status === 'disconnected' || status === 'error';
    const [show, setShow] = React.useState(false);

    React.useEffect(() => {
        if (!offline) { setShow(false); return; }
        const timer = setTimeout(() => setShow(true), 1200);
        return () => clearTimeout(timer);
    }, [offline]);

    if (!show) return null;

    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}>
            <Ionicons name="cloud-offline-outline" size={15} color={theme.colors.textSecondary} style={{ marginRight: 8 }} />
            <Text style={[styles.text, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {t('joyQueue.offlineBanner')}
            </Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 7,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    text: {
        flex: 1,
        fontSize: 12,
        ...Typography.default(),
    },
}));
