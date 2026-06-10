// Rich machine-wide usage report via codeburn (getagentseal/codeburn),
// fetched through the joy-tmux daemon (joy-codeburn op). Mirrors the codeburn
// TUI visually: every row carries a proportional bar (scaled to the section
// max), with a daily-activity chart up top. The lighter ccusage view lives at
// /settings/joy-usage.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';

// Survives navigation so revisits render instantly (same trick as joy-usage).
let cachedBurnMachineIds: Set<string> | null = null;

const PERIODS = [
    { key: 'today', label: 'Today' },
    { key: 'week', label: '1 Week' },
    { key: '30days', label: '30 Days' },
    { key: '90days', label: '90 Days' },
    { key: '6months', label: '6 Months' },
] as const;
type PeriodKey = typeof PERIODS[number]['key'];

type BurnReport = {
    ok?: boolean;
    error?: string;
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
    daily?: Array<{ date: string; cost: number; calls: number }>;
    projects?: Array<{ name: string; path?: string; cost: number; calls: number; sessions: number; avgCostPerSession?: number }>;
    models?: Array<{ name: string; cost: number; calls: number; inputTokens: number; outputTokens: number; oneShotRate?: number | null }>;
    activities?: Array<{ category: string; cost: number; turns: number; oneShotRate?: number | null }>;
    tools?: Array<{ name: string; calls: number }>;
    mcpServers?: Array<{ name: string; calls: number }>;
    skills?: Array<{ name: string; calls?: number; cost?: number }>;
    subagents?: Array<{ name: string; calls?: number; cost?: number }>;
};

function fmtTokens(n: number | undefined): string {
    if (n == null) return '0';
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

function fmtCost(n: number | undefined): string {
    const v = n ?? 0;
    if (v !== 0 && v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
}

// ── Date helpers for the activity rollups ───────────────────────────────────
// All date strings are codeburn's local YYYY-MM-DD; T12:00 dodges TZ edges.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayOfWeek(dateStr: string): string {
    return DOW[new Date(`${dateStr}T12:00:00`).getDay()];
}

function mondayOf(dateStr: string): Date {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
}

function isoDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type DailyRow = { date: string; cost: number; calls: number };
type ActivityRow = { key: string; label: string; cost: number; calls: number };

// 90 days reads better as 13 weekly bars than 90 daily slivers; same idea
// for 6 months → monthly. Codeburn only emits days with activity, so the
// rollup is a plain group-by (gaps simply contribute nothing).
function rollupActivity(daily: DailyRow[], period: PeriodKey): ActivityRow[] {
    if (period === '90days') {
        const weeks = new Map<string, ActivityRow>();
        for (const d of daily) {
            const wk = isoDate(mondayOf(d.date));
            const row = weeks.get(wk) ?? { key: wk, label: `wk ${wk.slice(5)}`, cost: 0, calls: 0 };
            row.cost += d.cost;
            row.calls += d.calls;
            weeks.set(wk, row);
        }
        return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    if (period === '6months') {
        const months = new Map<string, ActivityRow>();
        for (const d of daily) {
            const mo = d.date.slice(0, 7);
            const label = `${MONTHS[parseInt(mo.slice(5), 10) - 1]} ${mo.slice(0, 4)}`;
            const row = months.get(mo) ?? { key: mo, label, cost: 0, calls: 0 };
            row.cost += d.cost;
            row.calls += d.calls;
            months.set(mo, row);
        }
        return [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
    }
    return daily.map(d => ({ key: d.date, label: `${dayOfWeek(d.date)} ${d.date.slice(5)}`, cost: d.cost, calls: d.calls }));
}

// GitHub-style heatmap for the 30-day view: rows are calendar weeks
// (Mon → Sun), cell intensity is the day's cost share of the period max.
function Heatmap({ daily }: { daily: DailyRow[] }) {
    const byDate = new Map(daily.map(d => [d.date, d]));
    const max = Math.max(1e-9, ...daily.map(d => d.cost));

    const end = new Date(); end.setHours(12, 0, 0, 0);
    const start = new Date(end); start.setDate(start.getDate() - 29);
    const cursor = mondayOf(isoDate(start));

    const weeks: Array<Array<{ iso: string; dayNum: number; cost: number | null; inRange: boolean }>> = [];
    while (cursor <= end) {
        const week: Array<{ iso: string; dayNum: number; cost: number | null; inRange: boolean }> = [];
        for (let i = 0; i < 7; i++) {
            const iso = isoDate(cursor);
            const inRange = cursor >= start && cursor <= end;
            const day = byDate.get(iso);
            week.push({ iso, dayNum: cursor.getDate(), cost: day ? day.cost : null, inRange });
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push(week);
    }

    return (
        <View style={{ gap: 4 }}>
            <View style={styles.heatRow}>
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                    <Text key={d} style={styles.heatHeader}>{d}</Text>
                ))}
            </View>
            {weeks.map((week, wi) => (
                <View key={wi} style={styles.heatRow}>
                    {week.map(cell => {
                        const intensity = cell.cost != null ? 0.18 + 0.82 * (cell.cost / max) : 0;
                        return (
                            <View
                                key={cell.iso}
                                style={[
                                    styles.heatCell,
                                    !cell.inRange && { opacity: 0.25 },
                                    cell.cost != null
                                        ? { backgroundColor: `rgba(255, 107, 53, ${intensity.toFixed(2)})` }
                                        : null,
                                ]}
                            >
                                <Text style={[styles.heatDay, cell.cost != null && cell.cost / max > 0.55 && { color: '#FFF' }]}>
                                    {cell.dayNum}
                                </Text>
                                {cell.cost != null && (
                                    <Text style={[styles.heatCost, cell.cost / max > 0.55 && { color: '#FFF' }]} numberOfLines={1}>
                                        ${cell.cost < 10 ? cell.cost.toFixed(1) : Math.round(cell.cost)}
                                    </Text>
                                )}
                            </View>
                        );
                    })}
                </View>
            ))}
        </View>
    );
}

// One TUI-style row: proportional bar | label | value columns.
function BarRow({ frac, label, value, sub, color }: {
    frac: number;          // 0..1 share of the section max
    label: string;
    value: string;
    sub?: string;
    color: string;
}) {
    return (
        <View style={styles.barRow}>
            <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${Math.max(2, Math.round(frac * 100))}%`, backgroundColor: color }]} />
            </View>
            <Text style={styles.barLabel} numberOfLines={1}>{label}</Text>
            {sub != null && <Text style={styles.barSub} numberOfLines={1}>{sub}</Text>}
            <Text style={styles.barValue} numberOfLines={1}>{value}</Text>
        </View>
    );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View style={styles.card}>
            <Text style={styles.cardTitle}>{title}</Text>
            {children}
        </View>
    );
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
            <View style={styles.center}>
                <ActivityIndicator />
                <Text style={styles.centerText}>looking for machines running joy-tmux…</Text>
            </View>
        );
    }

    if (joyMachineIds.size === 0) {
        return (
            <View style={styles.center}>
                <Ionicons name="cloud-offline-outline" size={48} color={styles.centerText.color} />
                <Text style={styles.centerText}>
                    No online machine answered the joy-tmux probe. Codeburn reporting runs through the daemon.
                </Text>
            </View>
        );
    }

    const report = state.phase === 'done' ? state.report : null;
    const o = report?.overview;
    const activityRows = rollupActivity(report?.daily ?? [], period);
    const maxActivityRow = Math.max(1e-9, ...activityRows.map(d => d.cost));
    const maxProject = Math.max(1e-9, ...(report?.projects ?? []).map(p => p.cost));
    const maxModel = Math.max(1e-9, ...(report?.models ?? []).map(m => m.cost));
    const maxActivity = Math.max(1e-9, ...(report?.activities ?? []).map(a => a.cost));
    const maxTool = Math.max(1e-9, ...(report?.tools ?? []).map(t => t.calls));
    const maxMcp = Math.max(1e-9, ...(report?.mcpServers ?? []).map(s => s.calls));
    const maxSkill = Math.max(1e-9, ...(report?.skills ?? []).map(s => s.cost ?? s.calls ?? 0));
    const maxSub = Math.max(1e-9, ...(report?.subagents ?? []).map(s => s.cost ?? s.calls ?? 0));

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* Period chips — mirrors the TUI's top strip */}
            <View style={styles.chipRow}>
                {PERIODS.map(p => (
                    <Pressable
                        key={p.key}
                        onPress={() => setPeriod(p.key)}
                        style={[styles.chip, period === p.key && styles.chipActive]}
                    >
                        <Text style={[styles.chipText, period === p.key && styles.chipTextActive]}>{p.label}</Text>
                    </Pressable>
                ))}
            </View>

            {joyMachineIds.size > 1 && (
                <View style={styles.chipRow}>
                    {[...joyMachineIds].map(id => (
                        <Pressable
                            key={id}
                            onPress={() => setSelectedMachineId(id)}
                            style={[styles.chip, id === selectedMachineId && styles.chipActive]}
                        >
                            <Text style={[styles.chipText, id === selectedMachineId && styles.chipTextActive]}>{machineName(id)}</Text>
                        </Pressable>
                    ))}
                </View>
            )}

            {state.phase === 'loading' && (
                <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
                    <ActivityIndicator />
                    <Text style={styles.centerText}>running codeburn…</Text>
                </View>
            )}

            {state.phase === 'error' && (
                <Section title="Error">
                    <Text style={styles.centerText}>{state.message}</Text>
                </Section>
            )}

            {report && o && (
                <>
                    {/* Header — big burn number, like the TUI banner */}
                    <View style={styles.card}>
                        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                            <Ionicons name="flame" size={22} color="#FF6B35" />
                            <Text style={styles.heroCost}>{fmtCost(o.cost)}</Text>
                            <Text style={styles.heroPeriod}>{report.period}</Text>
                        </View>
                        <Text style={styles.heroLine}>
                            {o.calls.toLocaleString()} calls · {o.sessions} sessions · {o.cacheHitPercent}% cache hit
                        </Text>
                        <Text style={styles.heroLine}>
                            {fmtTokens(o.tokens.input)} in · {fmtTokens(o.tokens.output)} out · {fmtTokens(o.tokens.cacheRead)} cached · {fmtTokens(o.tokens.cacheWrite)} written
                        </Text>
                    </View>

                    {period === '30days' && !!report.daily?.length && (
                        <Section title="30-Day Heatmap">
                            <Heatmap daily={report.daily} />
                        </Section>
                    )}

                    {activityRows.length > 1 && (
                        <Section title={period === '90days' ? 'Weekly Activity' : period === '6months' ? 'Monthly Activity' : 'Daily Activity'}>
                            {activityRows.map(d => (
                                <BarRow
                                    key={d.key}
                                    frac={d.cost / maxActivityRow}
                                    label={d.label}
                                    value={fmtCost(d.cost)}
                                    sub={`${d.calls}`}
                                    color="#FF6B35"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.projects?.length && (
                        <Section title="By Project">
                            {report.projects.map(p => (
                                <BarRow
                                    key={p.name}
                                    frac={p.cost / maxProject}
                                    label={p.path?.split('/').filter(Boolean).slice(-2).join('/') || p.name}
                                    value={fmtCost(p.cost)}
                                    sub={`${p.sessions} sess`}
                                    color="#0A84FF"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.models?.length && (
                        <Section title="By Model">
                            {report.models.map(m => (
                                <BarRow
                                    key={m.name}
                                    frac={m.cost / maxModel}
                                    label={m.name}
                                    value={fmtCost(m.cost)}
                                    sub={m.oneShotRate != null ? `${m.oneShotRate}% 1-shot` : `${m.calls} calls`}
                                    color="#BF5AF2"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.activities?.length && (
                        <Section title="By Activity">
                            {report.activities.map(a => (
                                <BarRow
                                    key={a.category}
                                    frac={a.cost / maxActivity}
                                    label={a.category}
                                    value={fmtCost(a.cost)}
                                    sub={a.oneShotRate != null ? `${a.turns}t · ${a.oneShotRate}%` : `${a.turns} turns`}
                                    color="#30D158"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.tools?.length && (
                        <Section title="Core Tools">
                            {report.tools.map(tl => (
                                <BarRow
                                    key={tl.name}
                                    frac={tl.calls / maxTool}
                                    label={tl.name}
                                    value={String(tl.calls)}
                                    color="#FFD60A"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.mcpServers?.length && (
                        <Section title="MCP Servers">
                            {report.mcpServers.map(s => (
                                <BarRow
                                    key={s.name}
                                    frac={s.calls / maxMcp}
                                    label={s.name}
                                    value={String(s.calls)}
                                    color="#64D2FF"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.skills?.length && (
                        <Section title="Skills & Agents">
                            {report.skills.map(s => (
                                <BarRow
                                    key={s.name}
                                    frac={(s.cost ?? s.calls ?? 0) / maxSkill}
                                    label={s.name}
                                    value={s.cost != null ? fmtCost(s.cost) : String(s.calls ?? 0)}
                                    sub={s.calls != null ? `${s.calls} uses` : undefined}
                                    color="#FF375F"
                                />
                            ))}
                        </Section>
                    )}

                    {!!report.subagents?.length && (
                        <Section title="Subagents">
                            {report.subagents.map(s => (
                                <BarRow
                                    key={s.name}
                                    frac={(s.cost ?? s.calls ?? 0) / maxSub}
                                    label={s.name}
                                    value={s.cost != null ? fmtCost(s.cost) : String(s.calls ?? 0)}
                                    sub={s.calls != null ? `${s.calls} uses` : undefined}
                                    color="#AC8E68"
                                />
                            ))}
                        </Section>
                    )}
                </>
            )}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    content: {
        maxWidth: layout.maxWidth,
        width: '100%',
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingVertical: 12,
        gap: 10,
    },
    center: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        paddingHorizontal: 32,
    },
    centerText: {
        color: theme.colors.textSecondary,
        fontSize: 14,
        textAlign: 'center',
        ...Typography.default(),
    },
    chipRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
    },
    chip: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    chipActive: {
        backgroundColor: theme.colors.button.primary.background,
        borderColor: theme.colors.button.primary.background,
    },
    chipText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    chipTextActive: {
        color: theme.colors.button.primary.tint,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    cardTitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginBottom: 4,
        ...Typography.default('semiBold'),
    },
    heroCost: {
        fontSize: 28,
        color: theme.colors.text,
        ...Typography.mono('semiBold'),
    },
    heroPeriod: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    heroLine: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    barRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 3,
    },
    barTrack: {
        width: 72,
        height: 10,
        borderRadius: 3,
        backgroundColor: theme.colors.divider,
        overflow: 'hidden',
        flexShrink: 0,
    },
    barFill: {
        height: '100%',
        borderRadius: 3,
    },
    barLabel: {
        flex: 1,
        fontSize: 13,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    barSub: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        flexShrink: 0,
        ...Typography.mono(),
    },
    barValue: {
        fontSize: 13,
        color: theme.colors.text,
        minWidth: 62,
        textAlign: 'right',
        flexShrink: 0,
        ...Typography.mono('semiBold'),
    },
    heatRow: {
        flexDirection: 'row',
        gap: 4,
    },
    heatHeader: {
        flex: 1,
        fontSize: 10,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    heatCell: {
        flex: 1,
        aspectRatio: 1,
        borderRadius: 6,
        backgroundColor: theme.colors.divider,
        alignItems: 'center',
        justifyContent: 'center',
    },
    heatDay: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        ...Typography.mono(),
    },
    heatCost: {
        fontSize: 9,
        color: theme.colors.text,
        ...Typography.mono('semiBold'),
    },
}));
