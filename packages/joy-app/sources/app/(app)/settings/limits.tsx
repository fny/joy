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
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { Typography } from '@/constants/Typography';
import { sync } from '@/sync/sync';
import { machineLimitsOnly } from '@/sync/v2/machine';

// Normalized shape the daemon's tunnel route returns per harness
// (`GET /v2/harnesses/:harness/limits`): one row per quota window.
interface LimitRow {
    id: string;
    usedPercent: number;
    /** ISO string; codex rows may carry unix seconds instead. */
    resetsAt?: string | number | null;
    windowMinutes?: number;
    scope?: string;
}
interface HarnessLimits {
    ok?: boolean;
    harness?: string;
    limits?: LimitRow[];
    status?: { state?: string };
    error?: { code?: string; message?: string };
    observedAt?: number;
}
interface LimitsReply {
    claude?: HarnessLimits;
    codex?: HarnessLimits;
}

const HOT = 80;

function toDate(at: string | number | null | undefined): Date | null {
    if (at == null) return null;
    if (typeof at === 'number') return new Date(at < 1e12 ? at * 1000 : at);
    return new Date(at);
}

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

const KNOWN_WINDOWS: Record<string, string> = {
    five_hour: '5-hour window',
    seven_day: 'Weekly window',
    seven_day_opus: 'Weekly · Opus',
    seven_day_sonnet: 'Weekly · Sonnet',
};

function rowLabel(row: LimitRow, index: number): string {
    if (KNOWN_WINDOWS[row.id]) return KNOWN_WINDOWS[row.id];
    // A model-scoped window from the usage API's structured list — "Fable" is
    // one; the daemon names it from scope.model.display_name.
    if (row.scope && row.id.startsWith('weekly_scoped')) return `Weekly · ${row.scope}`;
    if (row.id === 'primary' || row.id === 'secondary') {
        return windowName(row.windowMinutes, index === 0 ? 'Primary window' : 'Secondary window');
    }
    return row.windowMinutes != null ? windowName(row.windowMinutes, row.id) : row.id;
}

function HarnessSection(props: { title: string; data: HarnessLimits | undefined; emptyText: string }) {
    const { data } = props;
    let body: React.ReactNode;
    if (!data) {
        body = <Text style={styles.errorText}>unavailable</Text>;
    } else if (data.error?.message) {
        body = <Text style={styles.errorText}>{data.error.message}</Text>;
    } else {
        const rows = (data.limits ?? []).filter(r => typeof r.usedPercent === 'number');
        body = rows.length === 0
            ? <Text style={styles.errorText}>{props.emptyText}</Text>
            : rows.map((r, i) => (
                <LimitBar key={r.id} label={rowLabel(r, i)} percent={r.usedPercent} sub={resetLabel(toDate(r.resetsAt))} />
            ));
    }
    return (
        <>
            <Text style={styles.sectionTitle}>{props.title}</Text>
            {body}
        </>
    );
}

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
                    (() => { const c = sync.machineOnlyCtx(props.machineId); return c
                        // v2: per-harness limits from the daemon over the tunnel,
                        // merged into the legacy {claude, codex} reply shape.
                        ? Promise.all([machineLimitsOnly(c, 'claude'), machineLimitsOnly(c, 'codex')])
                            .then(([cl, cx]) => ({ claude: cl.data as HarnessLimits | undefined, codex: cx.data as HarnessLimits | undefined }) as LimitsReply)
                        : Promise.reject(new Error('no machine context')); })(),
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
                    <HarnessSection title="Claude" data={state.reply.claude} emptyText="no limits reported" />
                    <HarnessSection title="Codex" data={state.reply.codex} emptyText="no recent codex activity" />
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
