// Per-session cost, read over v2 from the daemon on the session's machine
// (GET /v2/sessions/:id/usage through the sealed tunnel). The daemon resolves
// the conversation's claude session id itself, so this screen needs no
// separate lookup.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineSessionUsage } from '@/sync/v2/machine';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

type SessionUsage = {
    id: string;
    project: string;
    startedAt: string;
    cost: number;
    calls: number;
    turns: number;
    models?: Array<{ name: string; cost: number }>;
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
    // The v2 link arrives with session sync, which can land AFTER first paint.
    // Keying the effect on it means we retry once it does instead of latching
    // "no v2 machine context" forever.
    const v2SessionId = (session?.metadata as { v2?: { sessionId?: string } } | undefined)?.v2?.sessionId;

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
                const ctx = await sync.awaitMachineCtx(id);
                if (cancelled) return;
                if (!ctx) {
                    setState({ phase: 'error', message: 'No v2 machine context for this session yet.' });
                    return;
                }
                const { status, data } = await raceTimeout(
                    machineSessionUsage(ctx, 'all'),
                    60000, 'the daemon did not respond — is it running on this machine?',
                );
                if (cancelled) return;
                if (status !== 200 || !data || data.error) {
                    setState({ phase: 'error', message: data?.error ?? `usage query failed (${status})` });
                    return;
                }
                setState({ phase: 'done', entry: (data.entry ?? null) as SessionUsage | null });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : 'usage query failed' });
            }
        })();
        return () => { cancelled = true; };
    }, [machineId, id, v2SessionId]);

    if (state.phase === 'loading') {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    computing usage on the session machine…
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

            {!!entry.models?.length && (
                <ItemGroup title="By model">
                    {entry.models.map(m => (
                        <Item
                            key={m.name}
                            title={m.name}
                            detail={`$${m.cost.toFixed(2)}`}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}
        </ItemList>
    );
});
