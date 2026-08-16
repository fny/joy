// Account limits & quota windows — SERVER truth (the ccusage-ecosystem data
// source), not the transcript-derived cost stats on the usage page. Each
// online machine's daemon reads its own local credentials: claude via the
// Claude Code OAuth token against api/oauth/usage (5h + weekly windows,
// utilization % and reset times), codex from the newest rollout's
// token_count.rate_limits. No credential entry in the app — the daemon sits
// next to the credentials.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ScrollView, ActivityIndicator, Pressable } from 'react-native';
import { Stack } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { apiSocket } from '@/sync/apiSocket';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { Typography } from '@/constants/Typography';

interface Bucket { utilization?: number; resets_at?: string }
interface CodexWindow { used_percent?: number; window_minutes?: number; resets_in_seconds?: number; resets_at?: number }
interface LimitsReply {
    ok?: boolean;
    claude?: { ok: true; limits: Record<string, Bucket | null | undefined> } | { ok: false; error: string };
    codex?: { ok: true; limits: { primary?: CodexWindow | null; secondary?: CodexWindow | null; observedAt?: string } } | { ok: false; error: string };
}

const HOT = 80;

function resetLabel(at: Date | null): string | null {
    if (!at || isNaN(at.getTime())) return null;
    const ms = at.getTime() - Date.now();
    if (ms <= 0) return 'resets soon';
    const h = Math.floor(ms / 3600_000);
    const m = Math.round((ms % 3600_000) / 60_000);
    if (h >= 48) return `resets in ${Math.round(h / 24)}d`;
    return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

function windowName(minutes: number | undefined, fallback: string): string {
    if (minutes == null) return fallback;
    if (minutes <= 360) return '5-hour window';
    if (minutes <= 20_000) return 'Weekly window';
    return `${Math.round(minutes / 1440)}-day window`;
}

const CLAUDE_BUCKETS: Array<{ key: string; label: string }> = [
    { key: 'five_hour', label: '5-hour window' },
    { key: 'seven_day', label: 'Weekly window' },
    { key: 'seven_day_opus', label: 'Weekly · Opus' },
    { key: 'seven_day_sonnet', label: 'Weekly · Sonnet' },
];

function LimitBar(props: { label: string; percent: number; sub?: string | null }) {
    const { theme } = useUnistyles();
    const pct = Math.max(0, Math.min(100, props.percent));
    const hot = pct >= HOT;
    return (
        <View style={styles.barBlock}>
            <View style={styles.barLabelRow}>
                <Text style={styles.barLabel}>{props.label}</Text>
                <Text style={[styles.barPercent, hot && { color: '#FF3B30' }]}>{Math.round(pct)}%</Text>
            </View>
            <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${pct}%` as any, backgroundColor: hot ? '#FF3B30' : theme.colors.textLink }]} />
            </View>
            {props.sub ? <Text style={styles.barSub}>{props.sub}</Text> : null}
        </View>
    );
}

function MachineLimits(props: { machineId: string; name: string }) {
    const [state, setState] = React.useState<{ phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'done'; reply: LimitsReply }>({ phase: 'loading' });
    const [refreshNonce, setRefreshNonce] = React.useState(0);

    React.useEffect(() => {
        let cancelled = false;
        setState({ phase: 'loading' });
        (async () => {
            try {
                const reply = await Promise.race([
                    apiSocket.machineRPC<LimitsReply, {}>(props.machineId, 'joy-limits', {}),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('daemon did not respond — joy update needed?')), 30000)),
                ]);
                if (!cancelled) setState({ phase: 'done', reply });
            } catch (e) {
                if (!cancelled) setState({ phase: 'error', message: e instanceof Error ? e.message : String(e) });
            }
        })();
        return () => { cancelled = true; };
    }, [props.machineId, refreshNonce]);

    return (
        <View style={styles.card}>
            <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>{props.name}</Text>
                <Pressable onPress={() => setRefreshNonce(n => n + 1)} hitSlop={8}>
                    <Text style={styles.refresh}>refresh</Text>
                </Pressable>
            </View>
            {state.phase === 'loading' && <ActivityIndicator style={{ paddingVertical: 16 }} />}
            {state.phase === 'error' && <Text style={styles.errorText}>{state.message}</Text>}
            {state.phase === 'done' && (
                <>
                    <Text style={styles.sectionTitle}>Claude</Text>
                    {state.reply.claude?.ok ? (
                        CLAUDE_BUCKETS.flatMap(({ key, label }) => {
                            const b = (state.reply.claude as { limits: Record<string, Bucket | null | undefined> }).limits[key];
                            if (!b || b.utilization == null) return [];
                            return [<LimitBar key={key} label={label} percent={b.utilization} sub={resetLabel(b.resets_at ? new Date(b.resets_at) : null)} />];
                        })
                    ) : (
                        <Text style={styles.errorText}>{state.reply.claude?.ok === false ? state.reply.claude.error : 'unavailable'}</Text>
                    )}
                    <Text style={styles.sectionTitle}>Codex</Text>
                    {state.reply.codex?.ok ? (
                        (() => {
                            const l = (state.reply.codex as { limits: { primary?: CodexWindow | null; secondary?: CodexWindow | null } }).limits;
                            const rows = [l.primary, l.secondary].filter((w): w is CodexWindow => !!w && w.used_percent != null);
                            if (rows.length === 0) return <Text style={styles.errorText}>no recent codex activity</Text>;
                            return rows.map((w, i) => {
                                const resetAt = w.resets_at != null ? new Date(w.resets_at * 1000)
                                    : w.resets_in_seconds != null ? new Date(Date.now() + w.resets_in_seconds * 1000) : null;
                                return <LimitBar key={i} label={windowName(w.window_minutes, i === 0 ? 'Primary window' : 'Secondary window')} percent={w.used_percent ?? 0} sub={resetLabel(resetAt)} />;
                            });
                        })()
                    ) : (
                        <Text style={styles.errorText}>{state.reply.codex?.ok === false ? state.reply.codex.error : 'unavailable'}</Text>
                    )}
                </>
            )}
        </View>
    );
}

export default React.memo(function LimitsScreen() {
    const machines = useAllMachines({ includeOffline: false }).filter(isMachineOnline);
    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <Stack.Screen options={{ headerTitle: 'Limits' }} />
            <Text style={styles.pageNote}>
                Account quota windows straight from each provider — server truth, independent of the cost stats on the Usage page.
            </Text>
            {machines.length === 0 && <Text style={styles.errorText}>No online machines.</Text>}
            {machines.map(m => (
                <MachineLimits
                    key={m.id}
                    machineId={m.id}
                    name={m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8)}
                />
            ))}
        </ScrollView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { padding: 16, gap: 12, maxWidth: 700, width: '100%', alignSelf: 'center' },
    pageNote: { color: theme.colors.textSecondary, fontSize: 13, lineHeight: 18 },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 14,
        gap: 8,
    },
    cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    cardTitle: { color: theme.colors.text, fontSize: 16, ...Typography.default('semiBold') },
    refresh: { color: theme.colors.textLink, fontSize: 13 },
    sectionTitle: { color: theme.colors.textSecondary, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 6 },
    errorText: { color: theme.colors.textSecondary, fontSize: 13 },
    barBlock: { gap: 3 },
    barLabelRow: { flexDirection: 'row', justifyContent: 'space-between' },
    barLabel: { color: theme.colors.text, fontSize: 14 },
    barPercent: { color: theme.colors.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] },
    barTrack: { height: 6, borderRadius: 3, backgroundColor: theme.colors.divider, overflow: 'hidden' },
    barFill: { height: 6, borderRadius: 3 },
    barSub: { color: theme.colors.textSecondary, fontSize: 12 },
}));
