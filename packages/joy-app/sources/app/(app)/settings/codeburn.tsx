// Rich machine-wide usage report via codeburn (getagentseal/codeburn),
// fetched through the joy-tmux daemon (joy-codeburn op). The lighter ccusage
// view lives at /settings/joy-usage; this one adds per-project, per-model,
// activity, tool and MCP breakdowns over today / 30 / 90 / 180-day windows.
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

// Survives navigation so revisits render instantly (same trick as joy-usage).
let cachedBurnMachineIds: Set<string> | null = null;

const PERIODS = [
    { key: 'today', label: 'Today' },
    { key: '30days', label: '30 days' },
    { key: '90days', label: '90 days' },
    { key: '6months', label: '6 months' },
] as const;
type PeriodKey = typeof PERIODS[number]['key'];

type BurnReport = {
    ok?: boolean;
    error?: string;
    generated?: string;
    currency?: string;
    period?: string;
    overview?: {
        cost: number;
        netCost: number;
        savings: number;
        calls: number;
        sessions: number;
        cacheHitPercent: number;
        tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
    };
    projects?: Array<{ name: string; path?: string; cost: number; calls: number; sessions: number; avgCostPerSession?: number }>;
    models?: Array<{ name: string; cost: number; calls: number; inputTokens: number; outputTokens: number; oneShotRate?: number | null; costPerEdit?: number | null }>;
    activities?: Array<{ category: string; cost: number; turns: number; oneShotRate?: number | null }>;
    tools?: Array<{ name: string; calls: number }>;
    mcpServers?: Array<{ name: string; calls: number }>;
    skills?: Array<{ name: string; calls?: number; cost?: number }>;
    subagents?: Array<{ name: string; calls?: number; cost?: number }>;
};

function fmtTokens(n: number | undefined): string {
    if (n == null) return '0';
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
}

function fmtCost(n: number | undefined): string {
    return `$${(n ?? 0).toFixed(2)}`;
}

export default React.memo(function CodeburnSettingsScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: false });
    const onlineIds = machines.filter(isMachineOnline).map(m => m.id);

    const [joyMachineIds, setJoyMachineIds] = React.useState<Set<string> | null>(cachedBurnMachineIds);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(
        () => cachedBurnMachineIds?.values().next().value ?? null,
    );
    const [period, setPeriod] = React.useState<PeriodKey>('today');
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
            cachedBurnMachineIds = found;
            setJoyMachineIds(found);
            setSelectedMachineId(prev => prev ?? (found.values().next().value ?? null));
        })();
        return () => { cancelled = true; };
    }, [onlineIds.join(',')]);

    const [state, setState] = React.useState<
        | { phase: 'loading' }
        | { phase: 'error'; message: string }
        | { phase: 'done'; report: BurnReport }
    >({ phase: 'loading' });

    React.useEffect(() => {
        if (!selectedMachineId) return;
        setState({ phase: 'loading' });
        let cancelled = false;
        (async () => {
            try {
                const result = await Promise.race([
                    apiSocket.machineRPC<BurnReport, { period: string }>(selectedMachineId, 'joy-codeburn', { period }),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond — is the daemon running?')), 60000)),
                ]);
                if (cancelled) return;
                if (!result.ok) {
                    setState({ phase: 'error', message: result.error || 'codeburn query failed' });
                    return;
                }
                setState({ phase: 'done', report: result });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : 'codeburn query failed' });
            }
        })();
        return () => { cancelled = true; };
    }, [selectedMachineId, period]);

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
                    No online machine answered the joy-tmux probe. Codeburn reporting runs through the daemon.
                </Text>
            </View>
        );
    }

    const report = state.phase === 'done' ? state.report : null;
    const o = report?.overview;

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

            <ItemGroup title="Period">
                {PERIODS.map(p => (
                    <Item
                        key={p.key}
                        title={p.label}
                        rightElement={period === p.key ? <Ionicons name="checkmark" size={18} color={theme.colors.text} /> : undefined}
                        onPress={() => setPeriod(p.key)}
                        showChevron={false}
                    />
                ))}
            </ItemGroup>

            {state.phase === 'loading' && (
                <View style={{ alignItems: 'center', paddingVertical: 32, gap: 12 }}>
                    <ActivityIndicator />
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13, ...Typography.default() }}>
                        running codeburn on {selectedMachineId ? machineName(selectedMachineId) : 'machine'}…
                    </Text>
                </View>
            )}

            {state.phase === 'error' && (
                <ItemGroup>
                    <Item title="Error" subtitle={state.message} icon={<Ionicons name="warning-outline" size={29} color="#FF9500" />} showChevron={false} />
                </ItemGroup>
            )}

            {report && o && (
                <>
                    <ItemGroup title={`Overview — ${report.period ?? ''}`}>
                        <Item title="Cost" detail={fmtCost(o.cost)} icon={<Ionicons name="flame-outline" size={29} color="#FF3B30" />} showChevron={false} />
                        {o.savings > 0 && (
                            <Item title="Net cost / savings" detail={`${fmtCost(o.netCost)} / ${fmtCost(o.savings)}`} showChevron={false} />
                        )}
                        <Item title="Sessions / calls" detail={`${o.sessions} / ${o.calls}`} icon={<Ionicons name="layers-outline" size={29} color="#007AFF" />} showChevron={false} />
                        <Item title="Cache hit" detail={`${o.cacheHitPercent}%`} icon={<Ionicons name="flash-outline" size={29} color="#FFCC00" />} showChevron={false} />
                        <Item title="Input / output" detail={`${fmtTokens(o.tokens.input)} / ${fmtTokens(o.tokens.output)}`} showChevron={false} />
                        <Item title="Cache read / write" detail={`${fmtTokens(o.tokens.cacheRead)} / ${fmtTokens(o.tokens.cacheWrite)}`} showChevron={false} />
                    </ItemGroup>

                    {!!report.projects?.length && (
                        <ItemGroup title="By project">
                            {report.projects.map(p => (
                                <Item
                                    key={p.name}
                                    title={p.path?.split('/').filter(Boolean).pop() || p.name}
                                    subtitle={`${p.sessions} sessions · ${p.calls} calls${p.avgCostPerSession != null ? ` · ${fmtCost(p.avgCostPerSession)}/session` : ''}`}
                                    detail={fmtCost(p.cost)}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.models?.length && (
                        <ItemGroup title="By model" footer="One-shot rate = edits that landed without a retry.">
                            {report.models.map(m => (
                                <Item
                                    key={m.name}
                                    title={m.name}
                                    subtitle={`in ${fmtTokens(m.inputTokens)} · out ${fmtTokens(m.outputTokens)}${m.oneShotRate != null ? ` · one-shot ${m.oneShotRate}%` : ''}`}
                                    detail={fmtCost(m.cost)}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.activities?.length && (
                        <ItemGroup title="By activity">
                            {report.activities.map(a => (
                                <Item
                                    key={a.category}
                                    title={a.category}
                                    subtitle={`${a.turns} turns${a.oneShotRate != null ? ` · one-shot ${a.oneShotRate}%` : ''}`}
                                    detail={fmtCost(a.cost)}
                                    showChevron={false}
                                />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.tools?.length && (
                        <ItemGroup title="Top tools">
                            {report.tools.map(tl => (
                                <Item key={tl.name} title={tl.name} detail={`${tl.calls} calls`} showChevron={false} />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.mcpServers?.length && (
                        <ItemGroup title="MCP servers">
                            {report.mcpServers.map(s => (
                                <Item key={s.name} title={s.name} detail={`${s.calls} calls`} showChevron={false} />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.skills?.length && (
                        <ItemGroup title="Skills">
                            {report.skills.map(s => (
                                <Item key={s.name} title={s.name} detail={s.calls != null ? `${s.calls} calls` : undefined} showChevron={false} />
                            ))}
                        </ItemGroup>
                    )}

                    {!!report.subagents?.length && (
                        <ItemGroup title="Subagents">
                            {report.subagents.map(s => (
                                <Item key={s.name} title={s.name} detail={s.calls != null ? `${s.calls} calls` : undefined} showChevron={false} />
                            ))}
                        </ItemGroup>
                    )}
                </>
            )}
        </ItemList>
    );
});
