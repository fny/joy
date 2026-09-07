import * as React from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import type { Metadata } from '@/sync/storageTypes';

/** How long a background item has been running before it is worth doubting.
 *  The daemon ages a launch out after six hours (BG_LAUNCH_TTL_MS); anything
 *  past this has been going long enough that a lost completion is the more
 *  likely explanation than real work. */
const STALE_AFTER_MS = 30 * 60_000;

function elapsed(since: number | undefined, now: number): string | null {
    if (!since) return null;
    const ms = Math.max(0, now - since);
    const mins = Math.floor(ms / 60_000);
    if (mins < 1) return t('backgroundWork.justStarted');
    if (mins < 60) return t('backgroundWork.forMinutes', { count: mins });
    return t('backgroundWork.forHours', { count: Math.floor(mins / 60) });
}

const ICONS = {
    agent: 'people-outline',
    shell: 'terminal-outline',
    process: 'pulse-outline',
} as const;

/**
 * What is running behind this session (#646).
 *
 * The status line could only ever say "3/6 tasks" — a number with nothing
 * behind it. That is exactly wrong when the count is stuck, which is the case
 * you most need to understand: an outstanding count also suppresses the
 * turn-done push, so a wedged job costs notifications for six hours while
 * looking like ordinary progress.
 */
export const BackgroundWorkSheet = React.memo((props: {
    metadata: Metadata | null;
    onClose: () => void;
}) => {
    const { theme } = useUnistyles();
    const items = props.metadata?.joy__bgDetail?.items ?? [];
    // One clock for the whole list, ticking while the sheet is open, so every
    // row ages together instead of each re-rendering on its own schedule.
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);

    return (
        <View style={styles.sheet}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('backgroundWork.title')}</Text>
                <Pressable onPress={props.onClose} hitSlop={10} accessibilityLabel={t('backgroundWork.close')}>
                    <Ionicons name="close" size={18} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            {items.length === 0 ? (
                <Text style={styles.empty}>{t('backgroundWork.empty')}</Text>
            ) : (
                <ScrollView style={{ maxHeight: 260 }} keyboardShouldPersistTaps="handled">
                    {items.map((item) => {
                        const age = elapsed(item.since, now);
                        const stale = !!item.since && now - item.since > STALE_AFTER_MS;
                        return (
                            <View key={item.id} style={styles.row}>
                                <Ionicons
                                    name={ICONS[item.kind]}
                                    size={15}
                                    color={stale ? theme.colors.warning : theme.colors.textSecondary}
                                    style={{ marginRight: 8, marginTop: 2 }}
                                />
                                <View style={{ flex: 1 }}>
                                    {/* A label when the agent gave one, else the raw id — which is
                                        still enough to match against `joy events` or a task list. */}
                                    <Text style={styles.label} numberOfLines={1}>
                                        {item.label ?? item.id}
                                    </Text>
                                    <Text style={[styles.meta, stale && { color: theme.colors.warning }]} numberOfLines={1}>
                                        {t(`backgroundWork.kind.${item.kind}`)}
                                        {age ? ` · ${age}` : ''}
                                        {stale ? ` · ${t('backgroundWork.mayBeStuck')}` : ''}
                                    </Text>
                                </View>
                            </View>
                        );
                    })}
                </ScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    sheet: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        paddingVertical: 10,
        paddingHorizontal: 12,
        width: '100%',
        maxWidth: 420,
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 6,
    },
    title: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    empty: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        paddingVertical: 6,
        ...Typography.default(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 6,
    },
    label: {
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.default(),
    },
    meta: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        marginTop: 1,
        ...Typography.default(),
    },
}));
