import * as React from 'react';
import { View, TextInput, Pressable, Platform, ScrollView } from 'react-native';
import { Text } from '@/components/StyledText';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

// ONE stack component for everything pinned above the composer. Two instances:
//   Waiting — every message you sent that has not reached the agent yet,
//             wherever it is held (WaitingStack merges the app-held items and
//             the daemon's dispatch queue; the user does not care which).
//   Drafts  — messages you deliberately stashed; never auto-sent.
// Same header (title · count, collapsible, +N more), same inline-editable
// rows, same × remove. Only the send-side control differs per row, and the
// row says which it has: ↑ send now, ↻ retry, or ⇡ steer.
//
// Height is bounded at VISIBLE_ROWS; past that the stack scrolls, so a long
// queue can never take the whole screen.
const VISIBLE_ROWS = 3;
const ROW_HEIGHT = 60 + 6; // input minHeight + gap

export interface QueueRowModel {
    id: string;
    text: string;
    /** Live edit (app-held items update the store on every keystroke). */
    onChange?: (text: string) => void;
    /** Commit on blur/submit (daemon-queued items: one PATCH, not one per key). */
    onCommit?: (text: string) => void;
    onRemove: () => void;
    /** ↑ — send this now (drafts). */
    onSend?: () => void;
    /** ↻ — retry a release that keeps failing. */
    onRetry?: () => void;
    /** ⇡ — steer: deliver into the running turn instead of waiting. */
    onSteer?: () => void;
    /** Red line under the row (why it is stuck). */
    error?: string | null;
}

export const QueueStack = React.memo(function QueueStack({ title, icon, rows, notice }: {
    title: string;
    icon: 'time-outline' | 'document-text-outline';
    rows: QueueRowModel[];
    /** Banner above the rows — tap to act (the daemon's paused-queue resume). */
    notice?: { text: string; onPress: () => void } | null;
}) {
    const { theme } = useUnistyles();
    const [collapsed, setCollapsed] = React.useState(false);
    if (rows.length === 0 && !notice) return null;
    const overflow = rows.length - VISIBLE_ROWS;
    return (
        <View style={styles.wrap}>
            {rows.length > 0 && (
                <Pressable
                    onPress={() => setCollapsed((c) => !c)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={collapsed ? t('joyQueue.expand') : t('joyQueue.collapse')}
                    style={(p) => [styles.headerRow, { opacity: p.pressed ? 0.6 : 1 }]}
                >
                    <Ionicons name={icon} size={12} color={theme.colors.textSecondary} />
                    <Text style={styles.header}>{`${title.toUpperCase()} · ${rows.length}`}</Text>
                    {overflow > 0 && !collapsed && (
                        <Text style={styles.more}>{t('joyQueue.moreItems', { count: overflow })}</Text>
                    )}
                    <Ionicons name={collapsed ? 'chevron-up' : 'chevron-down'} size={14} color={theme.colors.textSecondary} />
                </Pressable>
            )}
            {notice && (
                <Pressable style={(p) => [styles.notice, { opacity: p.pressed ? 0.6 : 1 }]} onPress={notice.onPress} accessibilityRole="button">
                    <Ionicons name="warning-outline" size={15} color="#FF9500" />
                    <Text style={styles.noticeText} numberOfLines={2}>{notice.text}</Text>
                </Pressable>
            )}
            {!collapsed && rows.length > 0 && (
                <ScrollView
                    style={{ maxHeight: VISIBLE_ROWS * ROW_HEIGHT }}
                    contentContainerStyle={styles.list}
                    nestedScrollEnabled
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={rows.length > VISIBLE_ROWS}
                >
                    {rows.map((r) => <QueueRow key={r.id} row={r} />)}
                </ScrollView>
            )}
        </View>
    );
});

const QueueRow = React.memo(function QueueRow({ row }: { row: QueueRowModel }) {
    const { theme } = useUnistyles();
    // Local buffer so a commit-on-blur row (daemon item) edits smoothly; a live
    // row (app item) writes through on every change as well.
    const [text, setText] = React.useState(row.text);
    React.useEffect(() => { setText(row.text); }, [row.text]);
    const commit = React.useCallback(() => {
        const next = text.trim();
        if (row.onCommit && next && next !== row.text) row.onCommit(next);
    }, [row, text]);
    return (
        <View style={styles.row}>
            <View style={styles.inputWrap}>
                <TextInput
                    value={text}
                    onChangeText={(next) => { setText(next); row.onChange?.(next); }}
                    onBlur={commit}
                    onSubmitEditing={commit}
                    multiline
                    placeholder={t('joyQueue.draftPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary as string}
                    style={[
                        styles.input,
                        { color: theme.colors.text, backgroundColor: theme.colors.input.background },
                        Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : null,
                    ]}
                />
                <View style={styles.actions}>
                    <Pressable onPress={row.onRemove} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.delete')} style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.6 : 1 }]}>
                        <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                    </Pressable>
                    {row.onSteer && (
                        <Pressable onPress={row.onSteer} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('joyQueue.steerNow')} style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}>
                            <Ionicons name="arrow-up-circle-outline" size={20} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {row.onSend && (
                        <Pressable onPress={row.onSend} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('joyQueue.sendNow')} style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}>
                            <Ionicons name="arrow-up" size={22} color={theme.colors.text} />
                        </Pressable>
                    )}
                    {row.onRetry && (
                        <Pressable onPress={row.onRetry} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('joyQueue.retry')} style={(p) => [styles.iconButton, { opacity: p.pressed ? 0.5 : 1 }]}>
                            <Ionicons name="refresh" size={20} color={theme.colors.text} />
                        </Pressable>
                    )}
                </View>
            </View>
            {row.error ? <Text style={styles.error} numberOfLines={2}>{row.error}</Text> : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    wrap: { marginBottom: 8, gap: 6 },
    headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8, paddingVertical: 2 },
    header: { fontSize: 11, letterSpacing: 0.4, color: theme.colors.textSecondary, ...Typography.default('semiBold') },
    more: { fontSize: 11, color: theme.colors.textSecondary, ...Typography.default() },
    notice: {
        flexDirection: 'row', alignItems: 'center', gap: 8,
        paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
        backgroundColor: theme.colors.input.background,
    },
    noticeText: { flex: 1, fontSize: 13, color: theme.colors.text, ...Typography.default() },
    list: { gap: 6 },
    row: { gap: 4 },
    inputWrap: { position: 'relative' },
    input: {
        minHeight: 60, maxHeight: 120, borderRadius: 12,
        paddingHorizontal: 12, paddingVertical: 8, paddingRight: 76,
        fontSize: 15, ...Typography.default(),
    },
    actions: { position: 'absolute', right: 6, top: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 4 },
    iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
    error: { paddingHorizontal: 12, fontSize: 12, color: theme.colors.textDestructive, ...Typography.default() },
}));
