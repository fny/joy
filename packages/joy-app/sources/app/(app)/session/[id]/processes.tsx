// Processes: every process under this session's agent — the agent, its tool
// shells, dev servers, test runners, subagents and their shells — in tree
// order, each with CPU right now, resident memory and age. The info screen's
// "CPU · Memory" row is the sum; this is the list behind it. Re-sampled every
// 5 s while the screen is up (each sample is a 400 ms two-snapshot read on
// the daemon, so this is not free — hence only while looking).
//
// Personal-build dev surface — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineSessionProcesses, type SessionProcesses } from '@/sync/v2/machine';
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { Typography } from '@/constants/Typography';
import { formatBytes, ageLabel } from '@/utils/storageFormat';

function elapsed(s: number | null): string {
    if (s == null) return '—';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

export default React.memo(function SessionProcessesScreen() {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);
    const machineId = session?.metadata?.machineId;
    const [data, setData] = React.useState<SessionProcesses | null>(null);
    const [readAt, setReadAt] = React.useState<number | null>(null);
    const [error, setError] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        if (!machineId) { setError('Session has no machine id.'); return; }
        try {
            const ctx = await sync.awaitMachineCtx(id);
            if (!ctx) { setError('No machine context — is the daemon online?'); return; }
            const r = await machineSessionProcesses(ctx);
            if (!r.data?.ok) { setError(r.data?.error === 'session_not_found' ? 'The daemon has no process for this session — it has ended, or the daemon predates this page.' : (r.data?.error ?? `daemon answered ${r.status}`)); return; }
            setData(r.data); setReadAt(Date.now()); setError(null);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }, [id, machineId]);
    useActiveInterval(() => { void load(); }, 5_000, !!machineId);

    const rows = data?.processes ?? [];
    const hotCpu = (v: number) => v >= 80;
    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Processes' }} />
            <ScrollView style={styles.container} contentContainerStyle={styles.content}>
                {!data && !error ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}
                {error ? <Text style={styles.errorText}>{error}{data ? ` — showing the last read, ${ageLabel(readAt)}` : ''}</Text> : null}
                {data?.totals ? (
                    <View style={styles.totals}>
                        <Text style={styles.totalsText}>{data.totals.processCount} process{data.totals.processCount === 1 ? '' : 'es'} · {data.totals.cpuPercent}% CPU · {formatBytes(data.totals.rssBytes)}</Text>
                        <Text style={styles.muted}>CPU is percent of one core over a 400 ms sample; 200% is two cores busy. Read {ageLabel(readAt)}.</Text>
                    </View>
                ) : null}
                {rows.map((p) => (
                    <View key={p.pid} style={[styles.row, { paddingLeft: 12 + p.depth * 16 }]}>
                        <View style={styles.rowTop}>
                            <Text style={styles.name} numberOfLines={1}>{p.depth > 0 ? '└ ' : ''}{p.name}</Text>
                            <Text style={[styles.metric, hotCpu(p.cpuPercent) && { color: '#FF3B30' }]}>{p.cpuPercent}%</Text>
                            <Text style={styles.metric}>{formatBytes(p.rssBytes)}</Text>
                        </View>
                        <Text style={styles.args} numberOfLines={2}>{p.args}</Text>
                        <Text style={styles.muted}>pid {p.pid} · up {elapsed(p.elapsedSeconds)}</Text>
                    </View>
                ))}
                {data && rows.length === 0 ? <Text style={styles.muted}>No processes under this session right now.</Text> : null}
                <View style={{ height: 32 }} />
            </ScrollView>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { padding: 16, gap: 8 },
    totals: { backgroundColor: theme.colors.surface, borderRadius: 12, padding: 12, gap: 4 },
    totalsText: { fontSize: 15, color: theme.colors.text, ...Typography.default('semiBold') },
    muted: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    errorText: { fontSize: 13, color: '#FF3B30', ...Typography.default() },
    row: { backgroundColor: theme.colors.surface, borderRadius: 10, paddingVertical: 8, paddingRight: 12, gap: 2 },
    rowTop: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
    name: { flex: 1, fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    metric: { fontSize: 13, color: theme.colors.text, minWidth: 52, textAlign: 'right', ...Typography.default() },
    args: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
}));
