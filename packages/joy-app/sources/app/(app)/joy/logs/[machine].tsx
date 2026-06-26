import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Text } from '@/components/StyledText';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { machineListLogs, type JoyLogEntry } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let v = bytes / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// List the Claude transcript logs (one per conversation) for one project dir.
export default React.memo(function JoyLogsListScreen() {
    const { machine, dir } = useLocalSearchParams<{ machine: string; dir: string }>();
    const { theme } = useUnistyles();
    const [logs, setLogs] = React.useState<JoyLogEntry[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;
        if (!machine || !dir) { setError('Missing machine or directory'); return; }
        setLogs(null);
        setError(null);
        machineListLogs(machine, dir)
            .then((r) => { if (!cancelled) setLogs(r); })
            .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
        return () => { cancelled = true; };
    }, [machine, dir]);

    const copyId = React.useCallback(async (id: string) => {
        await Clipboard.setStringAsync(id);
        Modal.alert('Copied', 'Session ID copied to clipboard');
    }, []);

    const openLog = React.useCallback((sessionId: string) => {
        router.push({ pathname: '/joy/logs/view', params: { machine: machine!, dir: dir!, sessionId } });
    }, [machine, dir]);

    if (error) {
        return (
            <ItemList>
                <ItemGroup>
                    <Item
                        title="Couldn't load logs"
                        subtitle={error}
                        icon={<Ionicons name="alert-circle-outline" size={28} color={theme.colors.textDestructive} />}
                        showChevron={false}
                    />
                </ItemGroup>
            </ItemList>
        );
    }

    if (logs === null) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            </View>
        );
    }

    return (
        <ItemList>
            <ItemGroup
                title={`${logs.length} ${logs.length === 1 ? 'log' : 'logs'}`}
                footer={dir}
            >
                {logs.length === 0 ? (
                    <Item title="No logs found" showChevron={false} />
                ) : (
                    logs.map((log) => (
                        <Item
                            key={log.sessionId}
                            title={log.sessionId.slice(0, 8)}
                            subtitle={`${new Date(log.mtimeMs).toLocaleString()} · ${formatBytes(log.sizeBytes)}`}
                            subtitleLines={1}
                            icon={<Ionicons name="document-text-outline" size={28} color={theme.colors.text} />}
                            onPress={() => openLog(log.sessionId)}
                            onLongPress={() => copyId(log.sessionId)}
                        />
                    ))
                )}
            </ItemGroup>
            <Text
                style={{
                    color: theme.colors.textSecondary,
                    fontSize: 13,
                    textAlign: 'center',
                    paddingHorizontal: 24,
                    marginTop: 4,
                }}
            >
                Tap a log to preview its last messages · long-press to copy its ID
            </Text>
        </ItemList>
    );
});
