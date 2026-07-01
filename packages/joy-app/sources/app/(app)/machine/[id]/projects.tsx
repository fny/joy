import * as React from 'react';
import { View, Pressable, ActivityIndicator, Platform } from 'react-native';
import { Text } from '@/components/StyledText';
import { router, useLocalSearchParams, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Modal } from '@/modal';
import { useAllSessions, useAllMachines } from '@/sync/storage';
import { machineListLogs, machineReadLog, type JoyLogEntry } from '@/sync/ops';
import { formatLastSeen } from '@/utils/sessionUtils';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const EXCERPT_LIMIT = 120;

function folderName(dir: string): string {
    return dir.split(/[/\\]/).filter(Boolean).pop() || dir;
}

// Per-machine project browser. Lists every project (cwd) the machine has run a
// session in, each with its session logs (transcripts on disk) + an excerpt of
// the most recent one. Tap a session to preview its last 10 messages; right-
// click (web) / long-press (touch) to copy the session id.
export default React.memo(function MachineProjectsScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const sessions = useAllSessions();
    const machines = useAllMachines({ includeOffline: true });
    const { theme } = useUnistyles();

    const machineName = React.useMemo(() => {
        const m = machines.find((x) => x.id === id);
        return m?.metadata?.displayName || m?.metadata?.host || id;
    }, [machines, id]);

    // Distinct project dirs this machine has sessions in.
    const dirs = React.useMemo(() => {
        const set = new Set<string>();
        for (const s of sessions) {
            if (s.metadata?.machineId !== id) continue;
            const path = s.metadata?.path;
            if (path) set.add(path);
        }
        return Array.from(set).sort();
    }, [sessions, id]);

    return (
        <>
            <Stack.Screen options={{ headerTitle: `Projects · ${machineName}` }} />
            <ItemList>
                {dirs.length === 0 ? (
                    <ItemGroup>
                        <Item
                            title="No projects yet"
                            subtitle="Start a session on this machine to see its projects here."
                            icon={<Ionicons name="folder-open-outline" size={28} color={theme.colors.textSecondary} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : (
                    dirs.map((dir) => <ProjectGroup key={dir} machineId={id} dir={dir} />)
                )}
            </ItemList>
        </>
    );
});

// Loads + renders one project's session logs. Each project fetches its own
// transcript list so they resolve independently; each row then fetches its own
// last-message excerpt.
const ProjectGroup = React.memo(function ProjectGroup({ machineId, dir }: { machineId: string; dir: string }) {
    const { theme } = useUnistyles();
    const [logs, setLogs] = React.useState<JoyLogEntry[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        setLogs(null);
        setError(null);
        machineListLogs(machineId, dir)
            .then((entries) => { if (!cancelled) setLogs([...entries].sort((a, b) => b.mtimeMs - a.mtimeMs)); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [machineId, dir]);

    return (
        <ItemGroup title={folderName(dir)} footer={dir}>
            {error ? (
                <View style={styles.statusRow}>
                    <Ionicons name="alert-circle-outline" size={18} color={theme.colors.textDestructive} />
                    <Text style={[styles.statusText, { color: theme.colors.textDestructive }]} numberOfLines={2}>{error}</Text>
                </View>
            ) : logs === null ? (
                <View style={styles.statusRow}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : logs.length === 0 ? (
                <View style={styles.statusRow}>
                    <Text style={[styles.statusText, { color: theme.colors.textSecondary }]}>No session logs</Text>
                </View>
            ) : (
                logs.map((log, i) => (
                    <SessionRow
                        key={log.sessionId}
                        machineId={machineId}
                        dir={dir}
                        log={log}
                        isLast={i === logs.length - 1}
                    />
                ))
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
}));
