import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// The agent's active /goal, surfaced by joy-tmux as session.metadata.joy__goal
// (from Claude's goal_status transcript events). Shown as a pinned bar at the top
// of the chat while a goal is in progress; tap the text to edit (re-sends
// `/goal <new>`), or the × to clear (`/goal clear`). joy already passes slash
// commands straight through to Claude, so the daemon will update/clear the bar
// when Claude emits the next goal_status.
export const GoalBar = React.memo(function GoalBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const session = useSession(sessionId);
    const goal = session?.metadata?.joy__goal;

    const onEdit = React.useCallback(async () => {
        if (!goal?.condition) return;
        const next = await Modal.prompt(t('goal.editTitle'), t('goal.editMessage'), {
            defaultValue: goal.condition,
        });
        const trimmed = next?.trim();
        if (!trimmed || trimmed === goal.condition.trim()) return;
        sync.sendMessage(sessionId, `/goal ${trimmed}`, { source: 'chat' });
    }, [sessionId, goal?.condition]);

    const onClear = React.useCallback(() => {
        sync.sendMessage(sessionId, '/goal clear', { source: 'chat' });
    }, [sessionId]);

    if (!goal?.condition) return null;

    return (
        <View style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}>
            <Ionicons name="flag" size={16} color={theme.colors.textLink} style={{ marginRight: 8 }} />
            <Pressable style={{ flex: 1 }} onPress={onEdit} hitSlop={6} accessibilityLabel={t('goal.editTitle')}>
                <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('goal.label')}</Text>
                <Text style={[styles.text, { color: theme.colors.text }]} numberOfLines={2}>{goal.condition}</Text>
            </Pressable>
            <Pressable onPress={onClear} hitSlop={8} accessibilityLabel="Clear goal" style={(p) => [styles.clear, { opacity: p.pressed ? 0.6 : 1 }]}>
                <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    label: {
        fontSize: 10,
        ...Typography.default('semiBold'),
    },
    text: {
        fontSize: 14,
        ...Typography.default(),
    },
    clear: {
        width: 28,
        height: 28,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
    },
}));
