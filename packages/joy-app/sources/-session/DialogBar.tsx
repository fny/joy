import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// joy-tmux surfaces an interactive CLI dialog (model picker, "Switch model?"
// confirm, /effort slider…) as session.metadata.joy__dialog. These dialogs are
// the HARNESS asking a human — Claude never sees them, nothing echoes to the
// transcript until answered, and any command that opened one sits undelivered.
// Pinned bar: says what's being asked and deep-links to the terminal pane view
// where it can be answered. Auto-clears when the daemon sees the dialog gone.
export const DialogBar = React.memo(function DialogBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const session = useSession(sessionId);
    const dialog = session?.metadata?.joy__dialog;
    const machineId = session?.metadata?.machineId;
    const joyId = session?.metadata?.joy__sessionId;

    const openTerminal = React.useCallback(() => {
        if (!machineId || !joyId) return;
        router.push(`/joy/pane/${encodeURIComponent(machineId)}/${encodeURIComponent(joyId)}`);
    }, [router, machineId, joyId]);

    if (!dialog) return null;

    return (
        <Pressable
            onPress={openTerminal}
            accessibilityRole="button"
            accessibilityLabel={t('joyDialog.openTerminal')}
            style={(p) => [styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider, opacity: p.pressed ? 0.8 : 1 }]}
        >
            <View style={styles.row}>
                <Ionicons name="help-circle" size={16} color="#FF9500" style={{ marginRight: 8 }} />
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('joyDialog.label')}</Text>
                <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
                    {dialog.title ?? t('joyDialog.fallbackTitle')}
                </Text>
                <Ionicons name="terminal-outline" size={16} color={theme.colors.textLink} style={{ marginLeft: 8 }} />
            </View>
            {dialog.options.length > 0 && (
                <Text style={[styles.options, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                    {dialog.options.join('   ')}
                </Text>
            )}
            <Text style={[styles.hint, { color: theme.colors.textLink }]}>{t('joyDialog.openTerminal')}</Text>
        </Pressable>
    );
});

const styles = StyleSheet.create(() => ({
    bar: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        gap: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    label: {
        fontSize: 10,
        marginRight: 8,
        ...Typography.default('semiBold'),
    },
    title: {
        flex: 1,
        fontSize: 13,
        ...Typography.default('semiBold'),
    },
    options: {
        fontSize: 12,
        ...Typography.default(),
    },
    hint: {
        fontSize: 11,
        ...Typography.default(),
    },
}));
