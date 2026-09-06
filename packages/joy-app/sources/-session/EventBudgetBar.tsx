import * as React from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

// The relay caps a session at 50,000 events and answers every further output
// post with 429 session_event_budget_exhausted — for good (docs/API.md). The
// daemon drops that output so the turn can still terminalize and carries the
// loss on the card as `joy__eventBudget` {since, dropped} (#130). Without
// this bar the user saw a conversation that simply stopped growing, with no
// way to tell a quiet agent from a truncated one.
//
// Persistent and visible: it reads the card, not a push notification (a
// device with notifications off must still see it), and it never clears —
// the budget is per session and retrying never refills it. The only recovery
// is a fresh session, so the action opens the new-session screen on the same
// machine and folder.
export const EventBudgetBar = React.memo(function EventBudgetBar({ sessionId }: { sessionId: string }) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const session = useSession(sessionId);
    const budget = session?.metadata?.joy__eventBudget;
    const machineId = session?.metadata?.machineId;
    const path = session?.metadata?.path;

    const startNewSession = React.useCallback(() => {
        const params: Record<string, string> = {};
        if (machineId) params.machineId = machineId;
        if (path) params.path = path;
        router.push({ pathname: '/joy/new', params });
    }, [router, machineId, path]);

    if (!budget || budget.dropped <= 0) return null;

    const since = new Date(budget.since).toLocaleString();
    return (
        <View
            testID="event-budget-bar"
            accessibilityRole="alert"
            style={[styles.bar, { backgroundColor: theme.colors.surface, borderBottomColor: theme.colors.divider }]}
        >
            <View style={styles.row}>
                <Ionicons name="warning" size={16} color={DROPPED_COLOR} style={{ marginRight: 8 }} />
                <Text style={[styles.label, { color: DROPPED_COLOR }]}>{t('joyEventBudget.label')}</Text>
                <Text style={[styles.title, { color: theme.colors.text }]}>{t('joyEventBudget.title')}</Text>
            </View>
            <Text style={[styles.body, { color: theme.colors.textSecondary }]}>
                {t('joyEventBudget.body', { dropped: budget.dropped, since })}
            </Text>
            <Pressable
                onPress={startNewSession}
                accessibilityRole="button"
                accessibilityLabel={t('joyEventBudget.action')}
                testID="event-budget-new-session"
                style={(p) => [styles.action, { opacity: p.pressed ? 0.7 : 1 }]}
            >
                <Ionicons name="add-circle-outline" size={15} color={theme.colors.textLink} style={{ marginRight: 4 }} />
                <Text style={[styles.actionText, { color: theme.colors.textLink }]}>{t('joyEventBudget.action')}</Text>
            </Pressable>
        </View>
    );
});

/** Same red the sidebar marker uses — the loss is an error state, not a status. */
export const DROPPED_COLOR = '#FF3B30';

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
    body: {
        fontSize: 12,
        ...Typography.default(),
    },
    action: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        paddingVertical: 2,
    },
    actionText: {
        fontSize: 12,
        ...Typography.default('semiBold'),
    },
}));
