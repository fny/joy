import * as React from 'react';
import { View, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { ItemGroup } from '@/components/ItemGroup';
import { Modal } from '@/modal';
import { machineListLogs, machineReadLog, type JoyLogEntry } from '@/sync/ops';
import { formatLastSeen } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const EXCERPT_LIMIT = 120;
// A project with a long history collapses to its most-recent few, with a toggle
// to reveal the rest — so a heavily-used project doesn't bury the screen.
const COLLAPSED_COUNT = 3;

/** Last path segment of a project dir, for the group header. */
export function folderName(dir: string): string {
    return dir.split(/[/\\]/).filter(Boolean).pop() || dir;
}

// One project's (cwd's) session logs — transcripts on disk — newest first, with
// a per-row last-message excerpt. Shared by the machine projects browser and the
// per-session Projects screen (which passes a single dir). Long lists show only
// the most recent COLLAPSED_COUNT until expanded.
export const ProjectSessionsGroup = React.memo(function ProjectSessionsGroup({ machineId, dir }: { machineId: string; dir: string }) {
    const { theme } = useUnistyles();
    const [logs, setLogs] = React.useState<JoyLogEntry[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [expanded, setExpanded] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        setLogs(null);
        setError(null);
        setExpanded(false);
        machineListLogs(machineId, dir)
            .then((entries) => { if (!cancelled) setLogs([...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [machineId, dir]);

    const canToggle = logs !== null && logs.length > COLLAPSED_COUNT;
    const visible = logs === null ? null : (canToggle && !expanded ? logs.slice(0, COLLAPSED_COUNT) : logs);
    const hiddenCount = logs !== null && visible !== null ? logs.length - visible.length : 0;

    return (
        <ItemGroup title={folderName(dir)} footer={dir}>
            {error ? (
                <View style={styles.statusRow}>
                    <Ionicons name="alert-circle-outline" size={18} color={theme.colors.textDestructive} />
                    <Text style={[styles.statusText, { color: theme.colors.textDestructive }]} numberOfLines={2}>{error}</Text>
                </View>
            ) : visible === null ? (
                <View style={styles.statusRow}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : visible.length === 0 ? (
                <View style={styles.statusRow}>
                    <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>No session logs</Text>
                </View>
            ) : (
                <>
                    {visible.map((log, i) => (
                        <SessionRow
                            key={log.sessionId}
                            machineId={machineId}
                            dir={dir}
                            log={log}
                            isLast={!canToggle && i === visible.length - 1}
                        />
                    ))}
                    {canToggle && (
                        <Pressable
                            onPress={() => setExpanded((e) => !e)}
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.toggleRow, pressed && { backgroundColor: theme.colors.surfacePressed }]}
                        >
                            <Text style={[styles.toggleText, { color: theme.colors.textLink }]}>
                                {expanded ? 'Show less' : `Show ${hiddenCount} more`}
                            </Text>
                            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={theme.colors.textLink} />
                        </Pressable>
                    )}
                </>
            )}
        </ItemGroup>
    );
});

const SessionRow = React.memo(function SessionRow({
    machineId, dir, log, isLast,
}: {
    machineId: string;
    dir: string;
    log: JoyLogEntry;
    isLast: boolean;
}) {
    const { theme } = useUnistyles();
    const [excerpt, setExcerpt] = React.useState<string | null>(null);

    // Each row pulls the last message of its own transcript for an excerpt.
    React.useEffect(() => {
        let cancelled = false;
        machineReadLog(machineId, dir, log.sessionId, 1)
            .then((msgs) => {
                if (cancelled) return;
                const last = msgs[msgs.length - 1];
                if (last) {
                    const who = last.role === 'user' ? 'You' : 'Claude';
                    const text = last.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LIMIT);
                    setExcerpt(text ? `${who}: ${text}` : null);
                }
            })
            .catch(() => { /* excerpt is best-effort; ignore failures */ });
        return () => { cancelled = true; };
    }, [machineId, dir, log.sessionId]);

    const copyId = React.useCallback(async () => {
        await Clipboard.setStringAsync(log.sessionId);
        Modal.alert('Copied', 'Session ID copied to clipboard');
    }, [log.sessionId]);

    const open = React.useCallback(() => {
        router.push({ pathname: '/joy/logs/view', params: { machine: machineId, dir, sessionId: log.sessionId } });
    }, [machineId, dir, log.sessionId]);

    // Right-click on web, long-press on touch → copy the session id.
    const menuProps = Platform.OS === 'web'
        ? { onContextMenu: (e: any) => { e?.preventDefault?.(); copyId(); }, onLongPress: copyId }
        : { onLongPress: copyId };

    return (
        <Pressable
            onPress={open}
            {...(menuProps as any)}
            style={({ pressed }) => [
                styles.row,
                !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider },
                pressed && { backgroundColor: theme.colors.surfacePressed },
            ]}
        >
            <Ionicons name="document-text-outline" size={24} color={theme.colors.text} style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
                <Text style={[styles.rowTitle, { color: theme.colors.text }]}>{log.sessionId.slice(0, 8)}</Text>
                <Text style={[styles.rowSub, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                    {new Date(log.mtimeMs).toLocaleString()} · {formatLastSeen(log.mtimeMs)}
                </Text>
                {excerpt ? (
                    <Text style={[styles.rowExcerpt, { color: theme.colors.textSecondary }]} numberOfLines={2}>{excerpt}</Text>
                ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
        </Pressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 14,
    },
    statusText: {
        fontSize: 14,
        flex: 1,
        ...Typography.default(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    rowTitle: {
        fontSize: 15,
        fontFamily: 'monospace',
    },
    rowSub: {
        fontSize: 12,
        marginTop: 2,
        ...Typography.default(),
    },
    rowExcerpt: {
        fontSize: 13,
        marginTop: 4,
        ...Typography.default(),
    },
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
    },
    toggleText: {
        fontSize: 14,
        ...Typography.default('semiBold'),
    },
}));
