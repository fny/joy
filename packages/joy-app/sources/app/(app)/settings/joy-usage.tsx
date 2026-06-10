// Machine-wide token usage & cost via ccusage, fetched through the joy-tmux
// daemon (joy-usage op). Probes online machines for a daemon — same pattern
// as settings/joy-sessions — and shows daily (last 30 days) or monthly
// rollups for the selected machine. Unlike /settings/usage (happy's
// server-side report), this reads the machine's actual ~/.claude transcripts.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

// Survives navigation so revisits render instantly (same trick as joy-sessions).
let cachedUsageMachineIds: Set<string> | null = null;

type UsageRow = {
    period: string; // YYYY-MM-DD (daily) or YYYY-MM (monthly)
    inputTokens: number;
    outputTokens: number;
    totalCost: number;
    totalTokens: number;
    modelsUsed: string[];
};

type UsageTotals = {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalCost: number;
    totalTokens: number;
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

function sinceYYYYMMDD(daysBack: number): string {
    const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export default React.memo(function JoyUsageSettingsScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: false });
    const onlineIds = machines.filter(isMachineOnline).map(m => m.id);

    const [joyMachineIds, setJoyMachineIds] = React.useState<Set<string> | null>(cachedUsageMachineIds);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(
        () => cachedUsageMachineIds?.values().next().value ?? null,
    );
    const [kind, setKind] = React.useState<'daily' | 'monthly'>('daily');
    const probedRef = React.useRef(false);

    React.useEffect(() => {
        if (probedRef.current || onlineIds.length === 0) return;
        probedRef.current = true;
        let cancelled = false;
        (async () => {
            const probeOne = (id: string) => Promise.race([
                apiSocket.machineRPC(id, 'joy-status', {}).then(() => id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
            ]);
            const results = await Promise.allSettled(onlineIds.map(probeOne));
            if (cancelled) return;
            const found = new Set(
                results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value),
            );
            cachedUsageMachineIds = found;
            setJoyMachineIds(found);
            setSelectedMachineId(prev => prev ?? (found.values().next().value ?? null));
        })();
        return () => { cancelled = true; };
    }, [onlineIds.join(',')]);

    const [state, setState] = React.useState<
        | { phase: 'loading' }
        | { phase: 'error'; message: string }
        | { phase: 'done'; rows: UsageRow[]; totals: UsageTotals | null }
    >({ phase: 'loading' });

    React.useEffect(() => {
        if (!selectedMachineId) return;
        setState({ phase: 'loading' });
        let cancelled = false;
        (async () => {
            try {
                type Result = { ok?: boolean; daily?: UsageRow[]; monthly?: UsageRow[]; totals?: UsageTotals; error?: string };
                const params: Record<string, string> = { kind };
                if (kind === 'daily') params.since = sinceYYYYMMDD(30);
                const result = await Promise.race([
                    apiSocket.machineRPC<Result, Record<string, string>>(selectedMachineId, 'joy-usage', params),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond — is the daemon running?')), 30000)),
                ]);
                if (cancelled) return;
                if (!result.ok) {
                    setState({ phase: 'error', message: result.error || 'usage query failed' });
                    return;
                }
                const rows = (kind === 'daily' ? result.daily : result.monthly) ?? [];
                // ccusage returns oldest-first; most recent on top reads better.
                setState({ phase: 'done', rows: [...rows].reverse(), totals: result.totals ?? null });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : 'usage query failed' });
            }
        })();
        return () => { cancelled = true; };
    }, [selectedMachineId, kind]);

    const machineName = (id: string) => {
        const m = machines.find(x => x.id === id);
        return m?.metadata?.displayName || m?.metadata?.host || id.slice(0, 8);
    };

    if (!joyMachineIds) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    looking for machines running joy-tmux…
                </Text>
            </View>
        );
    }

    if (joyMachineIds.size === 0) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 }}>
                <Ionicons name="cloud-offline-outline" size={48} color={theme.colors.textSecondary} />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, textAlign: 'center', ...Typography.default() }}>
                    No online machine answered the joy-tmux probe. Usage reporting runs through the daemon.
                </Text>
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {joyMachineIds.size > 1 && (
                <ItemGroup title="Machine">
                    {[...joyMachineIds].map(id => (
                        <Item
                            key={id}
                            title={machineName(id)}
                            rightElement={id === selectedMachineId
                                ? <Ionicons name="checkmark" size={18} color={theme.colors.text} />
                                : undefined}
                            onPress={() => setSelectedMachineId(id)}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            )}

            <ItemGroup title="Period" footer="Daily covers the last 30 days; monthly covers everything ccusage finds on the machine.">
                <Item
                    title="Daily"
                    rightElement={kind === 'daily' ? <Ionicons name="checkmark" size={18} color={theme.colors.text} /> : undefined}
                    onPress={() => setKind('daily')}
                    showChevron={false}
                />
                <Item
                    title="Monthly"
                    rightElement={kind === 'monthly' ? <Ionicons name="checkmark" size={18} color={theme.colors.text} /> : undefined}
                    onPress={() => setKind('monthly')}
                    showChevron={false}
                />
            </ItemGroup>

            {state.phase === 'loading' && (
                <View style={{ alignItems: 'center', paddingVertical: 32 }}>
                    <ActivityIndicator />
                </View>
            )}

            {state.phase === 'error' && (
                <ItemGroup>
                    <Item title="Error" subtitle={state.message} icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />} showChevron={false} />
                </ItemGroup>
            )}

            {state.phase === 'done' && (
                <>
                    {state.totals && (
                        <ItemGroup title={kind === 'daily' ? 'Totals (last 30 days)' : 'Totals (all time)'}>
                            <Item title="Cost" detail={fmtCost(state.totals.totalCost)} icon={<Ionicons name="cash-outline" size={29} color="#34C759" />} showChevron={false} />
                            <Item title="Total tokens" detail={fmtTokens(state.totals.totalTokens)} icon={<Ionicons name="analytics-outline" size={29} color="#007AFF" />} showChevron={false} />
                            <Item title="Input / output" detail={`${fmtTokens(state.totals.inputTokens)} / ${fmtTokens(state.totals.outputTokens)}`} showChevron={false} />
                            <Item title="Cache write / read" detail={`${fmtTokens(state.totals.cacheCreationTokens)} / ${fmtTokens(state.totals.cacheReadTokens)}`} showChevron={false} />
                        </ItemGroup>
                    )}
                    <ItemGroup title={kind === 'daily' ? 'By day' : 'By month'}>
                        {state.rows.length === 0 && (
                            <Item title="No usage in this period" showChevron={false} />
                        )}
                        {state.rows.map(row => (
                            <Item
                                key={row.period}
                                title={row.period}
                                subtitle={`in ${fmtTokens(row.inputTokens)} · out ${fmtTokens(row.outputTokens)} · ${row.modelsUsed.join(', ')}`}
                                detail={fmtCost(row.totalCost)}
                                showChevron={false}
                            />
                        ))}
                    </ItemGroup>
                </>
            )}
        </ItemList>
    );
});
