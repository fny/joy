// Per-session token usage & cost, reported by ccusage running on the
// session's machine via the joy-tmux daemon (joy-usage op). Works for any
// session whose machine runs joy-tmux: the conversation is matched by claude
// session id, which comes from happy metadata or (for joy sessions) the
// daemon's live record.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSession } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

type ModelBreakdown = {
    modelName: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
};

type UsageEntry = {
    period: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    totalTokens: number;
    modelsUsed: string[];
    modelBreakdowns: ModelBreakdown[];
    metadata?: { lastActivity?: string };
};

function fmtTokens(n: number | undefined): string {
    if (n == null) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function fmtCost(n: number | undefined): string {
    return `$${(n ?? 0).toFixed(2)}`;
}

function raceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        p,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ]);
}

export default React.memo(function SessionUsageScreen() {
    const { theme } = useUnistyles();
    const { id } = useLocalSearchParams<{ id: string }>();
    const session = useSession(id);

    const machineId = session?.metadata?.machineId;
    const metaClaudeId = session?.metadata?.claudeSessionId;
    const joySessionId = session?.metadata?.joy__sessionId;

    const [state, setState] = React.useState<
        | { phase: 'loading' }
        | { phase: 'error'; message: string }
        | { phase: 'done'; entry: UsageEntry | null }
    >({ phase: 'loading' });

    React.useEffect(() => {
        if (!machineId) {
            setState({ phase: 'error', message: 'Session has no machine id.' });
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                // Resolve the claude session id: happy metadata carries it;
                // joy sessions ask the daemon for the live record.
                let claudeId = metaClaudeId ?? null;
                if (!claudeId && joySessionId) {
                    const live = await raceTimeout(
                        apiSocket.machineRPC<{ claude_session_id?: string; error?: string }, { id: string }>(
                            machineId, 'joy-get-session', { id: joySessionId }),
                        5000, 'joy-tmux did not respond',
                    );
                    claudeId = live.claude_session_id ?? null;
                }
                if (!claudeId) {
                    if (!cancelled) setState({ phase: 'error', message: 'No claude session id known for this session yet.' });
                    return;
                }
                const result = await raceTimeout(
                    apiSocket.machineRPC<{ ok?: boolean; entry?: UsageEntry | null; error?: string }, { kind: string; claudeSessionId: string }>(
                        machineId, 'joy-usage', { kind: 'session', claudeSessionId: claudeId }),
                    30000, 'joy-tmux did not respond — is the daemon running on this machine?',
                );
                if (cancelled) return;
                if (!result.ok) {
                    setState({ phase: 'error', message: result.error || 'usage query failed' });
                    return;
                }
                setState({ phase: 'done', entry: result.entry ?? null });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : 'usage query failed' });
            }
        })();
        return () => { cancelled = true; };
    }, [machineId, metaClaudeId, joySessionId]);

    if (state.phase === 'loading') {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    asking ccusage on the session machine…
                </Text>
            </View>
        );
    }

    if (state.phase === 'error') {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 }}>
                <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center', ...Typography.default() }}>
                    {state.message}
                </Text>
            </View>
        );
    }

    const entry = state.entry;
    if (!entry) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 }}>
                <Ionicons name="analytics-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center', ...Typography.default() }}>
                    No usage recorded for this conversation yet.
                </Text>
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title="Totals"
                footer={entry.metadata?.lastActivity ? `Last activity ${new Date(entry.metadata.lastActivity).toLocaleString()}` : undefined}
            >
                <Item title="Cost" detail={fmtCost(entry.totalCost)} icon={<Ionicons name="cash-outline" size={29} color="#34C759" />} showChevron={false} />
                <Item title="Total tokens" detail={fmtTokens(entry.totalTokens)} icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />} showChevron={false} />
                <Item title="Input" detail={fmtTokens(entry.inputTokens)} showChevron={false} />
                <Item title="Output" detail={fmtTokens(entry.outputTokens)} showChevron={false} />
                <Item title="Cache write" detail={fmtTokens(entry.cacheCreationTokens)} showChevron={false} />
                <Item title="Cache read" detail={fmtTokens(entry.cacheReadTokens)} showChevron={false} />
            </ItemGroup>

            <ItemGroup title="By model">
                {entry.modelBreakdowns.map((m) => (
                    <Item
                        key={m.modelName}
                        title={m.modelName}
                        subtitle={`in ${fmtTokens(m.inputTokens)} · out ${fmtTokens(m.outputTokens)} · cache ${fmtTokens(m.cacheCreationTokens + m.cacheReadTokens)}`}
                        detail={fmtCost(m.cost)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>
        </ItemList>
    );
});
