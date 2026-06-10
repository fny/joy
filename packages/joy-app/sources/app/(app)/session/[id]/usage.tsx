// Per-session cost, reported by codeburn running on the session's machine
// via the joy-tmux daemon (joy-codeburn-sessions op). Works for any session
// whose machine runs joy-tmux: the conversation is matched by claude session
// id, which comes from happy metadata or (for joy sessions) the daemon's
// live record.
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

type SessionUsage = {
    id: string;
    project: string;
    startedAt: string;
    cost: number;
    calls: number;
    turns: number;
};

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
        | { phase: 'done'; entry: SessionUsage | null }
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
                    apiSocket.machineRPC<{ ok?: boolean; entry?: SessionUsage | null; error?: string }, { period: string; claudeSessionId: string }>(
                        machineId, 'joy-codeburn-sessions', { period: 'all', claudeSessionId: claudeId }),
                    60000, 'joy-tmux did not respond — is the daemon running on this machine?',
                );
                if (cancelled) return;
                if (!result.ok) {
                    setState({ phase: 'error', message: result.error || 'codeburn query failed' });
                    return;
                }
                setState({ phase: 'done', entry: result.entry ?? null });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : 'codeburn query failed' });
            }
        })();
        return () => { cancelled = true; };
    }, [machineId, metaClaudeId, joySessionId]);

    if (state.phase === 'loading') {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    running codeburn on the session machine…
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
            <View style={{
                backgroundColor: theme.colors.surface,
                borderRadius: 12,
                marginHorizontal: 16,
                marginTop: 16,
                paddingVertical: 20,
                alignItems: 'center',
                gap: 4,
            }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                    <Ionicons name="flame" size={24} color="#FF6B35" />
                    <Text style={{ fontSize: 32, color: theme.colors.text, ...Typography.mono('semiBold') }}>
                        ${entry.cost.toFixed(2)}
                    </Text>
                </View>
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, ...Typography.mono() }}>
                    {entry.calls.toLocaleString()} calls · {entry.turns} turns
                </Text>
            </View>

            <ItemGroup title="Session">
                <Item
                    title="Project"
                    subtitle={entry.project}
                    icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                    showChevron={false}
                />
                <Item
                    title="Started"
                    subtitle={entry.startedAt ? new Date(entry.startedAt).toLocaleString() : 'unknown'}
                    icon={<Ionicons name="calendar-outline" size={29} color="#007AFF" />}
                    showChevron={false}
                />
                <Item
                    title="Claude Session ID"
                    subtitle={entry.id}
                    icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                    showChevron={false}
                />
                <Item
                    title="Avg cost per turn"
                    detail={entry.turns > 0 ? `$${(entry.cost / entry.turns).toFixed(2)}` : '—'}
                    icon={<Ionicons name="trending-up-outline" size={29} color="#34C759" />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
