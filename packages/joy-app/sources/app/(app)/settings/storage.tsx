// Storage: what every session leaves behind — on each machine's disk under
// ~/.joy (media, record, queue, receipts, ledger rows) and on the relay (event
// rows) — with size and age, selectable, and deletable in one press. The
// Cleanup page is folder-shaped (retire machines, purge remembered folders);
// this one is byte-shaped: biggest first, oldest visible, nuke what you pick.
//
// Order of a nuke matters: the daemon first (it kills a live session and
// archives its card), then the relay row (events go with it). The other way
// round the daemon's archive would land on a row that no longer exists.
//
// Personal-build dev surface — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { sync } from '@/sync/sync';
import { machineStorage, machineStorageNuke, type StorageReport, type StorageSession, type StorageLooseTmux } from '@/sync/v2/machine';
import { v2 } from '@/sync/v2/api';
import { sessionDelete } from '@/sync/ops';
import { Modal } from '@/modal';
import { Typography } from '@/constants/Typography';
import { formatBytes, ageLabel, summarizeSelection, describeNuke } from '@/utils/storageFormat';

interface RelayRow { events: number; bytes: number; newest: number | null }
interface MachineReport { machineId: string; name: string; online: boolean; report: StorageReport | null; error: string | null }

function folderName(path: string): string {
    const segs = path.split(/[\\/]/).filter(Boolean);
    return segs.length ? segs[segs.length - 1] : path;
}

export default function StorageScreen() {
    const { theme } = useUnistyles();
    const machines = useAllMachines({ includeOffline: true });
    const [reports, setReports] = React.useState<MachineReport[]>([]);
    const [relay, setRelay] = React.useState<Map<string, RelayRow>>(new Map());
    const [loading, setLoading] = React.useState(true);
    const [selected, setSelected] = React.useState<Set<string>>(new Set());
    const [busy, setBusy] = React.useState<string | null>(null);

    const load = React.useCallback(async () => {
        setLoading(true);
        const [relayRows, perMachine] = await Promise.all([
            v2.sessionsStorage().then((r) => r.sessions).catch(() => []),
            Promise.all(machines.map(async (m): Promise<MachineReport> => {
                const name = m.metadata?.displayName || m.metadata?.host || m.id.slice(0, 8);
                const online = isMachineOnline(m);
                if (!online) return { machineId: m.id, name, online, report: null, error: null };
                const ctx = sync.machineOnlyCtx(m.id);
                if (!ctx) return { machineId: m.id, name, online, report: null, error: 'no machine key' };
                try {
                    const r = await machineStorage(ctx);
                    if (r.status !== 200 || !r.data?.ok) return { machineId: m.id, name, online, report: null, error: r.data?.error ?? `daemon answered ${r.status} — update it` };
                    return { machineId: m.id, name, online, report: r.data, error: null };
                } catch (e) {
                    return { machineId: m.id, name, online, report: null, error: e instanceof Error ? e.message : String(e) };
                }
            })),
        ]);
        setRelay(new Map(relayRows.map((r) => [r.sessionId, { events: r.events, bytes: r.bytes, newest: r.newest }])));
        setReports(perMachine);
        setLoading(false);
    }, [machines]);

    React.useEffect(() => { void load(); }, [load]);

    // Selection keys are machineId:sessionId — the same local id can exist on two machines.
    const key = (machineId: string, id: string) => `${machineId}:${id}`;
    const toggle = (k: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; });

    // Sessions and loose tmux servers share one selection; a loose row carries
    // `tmux` and no session, and the summary keeps them apart.
    const tmuxKey = (machineId: string, label: string) => `${machineId}:tmux:${label}`;
    const allRows = React.useMemo(() => reports.flatMap((m) => [
        ...(m.report?.sessions ?? []).map((s) => {
            const rr = s.v2SessionId ? relay.get(s.v2SessionId) : undefined;
            return { id: key(m.machineId, s.id), machineId: m.machineId, session: s as StorageSession | null, loose: null as StorageLooseTmux | null, bytes: s.bytes, running: s.kind ? s.kind === 'running' : s.live, relayEvents: rr?.events ?? 0, relayBytes: rr?.bytes ?? 0, tmux: undefined as { alive: boolean } | undefined };
        }),
        ...(m.report?.looseTmux ?? []).map((l) => ({ id: tmuxKey(m.machineId, l.label), machineId: m.machineId, session: null as StorageSession | null, loose: l as StorageLooseTmux | null, bytes: 0, running: false, relayEvents: 0, relayBytes: 0, tmux: { alive: l.alive } as { alive: boolean } | undefined })),
    ]), [reports, relay]);
    const summary = summarizeSelection(allRows, selected);

    const nuke = async () => {
        if (summary.count + summary.tmux === 0) return;
        const total = summary.count + summary.tmux;
        const ok = await Modal.confirm(summary.count > 0 ? 'Delete sessions?' : 'Kill loose tmux servers?', describeNuke(summary), { confirmText: `Delete ${total}`, destructive: true });
        if (!ok) return;
        setBusy('Deleting…');
        let freed = 0; const failed: string[] = [];
        for (const m of reports) {
            const mine = allRows.filter((r) => r.machineId === m.machineId && selected.has(r.id));
            if (mine.length === 0) continue;
            const sessions = mine.filter((r) => r.session).map((r) => r.session!);
            const labels = mine.filter((r) => r.loose).map((r) => r.loose!.label);
            const ctx = sync.machineOnlyCtx(m.machineId);
            if (!ctx) { failed.push(...sessions.map((s) => s.id), ...labels); continue; }
            const r = await machineStorageNuke(ctx, { ids: sessions.map((s) => s.id), tmux: labels, killLive: true }).catch(() => null);
            const results = r?.data?.results ?? [];
            for (const s of sessions) {
                const res = results.find((x) => x.id === s.id);
                if (!res?.ok) { failed.push(s.id); continue; }
                freed += res.bytesFreed;
                // Daemon done: the relay row (and its events) can go.
                if (s.v2SessionId) await sessionDelete(s.v2SessionId).catch(() => { /* already gone, or archived elsewhere */ });
            }
            for (const t of r?.data?.tmux ?? []) if (t.error) failed.push(t.label);
            if (!r?.data?.tmux && labels.length) failed.push(...labels);
        }
        setSelected(new Set());
        setBusy(null);
        await load();
        if (failed.length > 0) await Modal.alert('Some could not be deleted', `${failed.length} left in place (${failed.map((f) => f.length > 12 ? f.slice(0, 12) + '…' : f).join(', ')}). Freed ${formatBytes(freed)}.`);
    };

    const selectAllOn = (machineId: string) => setSelected((prev) => {
        const n = new Set(prev);
        for (const r of allRows) if (r.machineId === machineId) n.add(r.id);
        return n;
    });

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Storage' }} />
            <ScrollView style={styles.container} contentContainerStyle={styles.content}>
                <Text style={styles.intro}>Everything each session leaves behind — on the machine under ~/.joy, and on the relay. Biggest first. Pick and delete.</Text>
                {loading && reports.length === 0 ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}
                {reports.map((m) => (
                    <View key={m.machineId} style={styles.machine}>
                        <View style={styles.machineHeader}>
                            <Text style={styles.machineName}>{m.name}</Text>
                            {m.report ? (
                                <Pressable onPress={() => selectAllOn(m.machineId)} hitSlop={8}>
                                    <Text style={styles.link}>select all</Text>
                                </Pressable>
                            ) : null}
                        </View>
                        {!m.online ? <Text style={styles.muted}>offline — its disk cannot be read until its daemon is back</Text> : null}
                        {m.error ? <Text style={styles.errorText}>{m.error}</Text> : null}
                        {m.report ? (
                            <>
                                <Text style={styles.muted}>
                                    {formatBytes(m.report.totalBytes)} in {m.report.homeDir}
                                    {m.report.shared ? ` · shared: ledger ${formatBytes(m.report.shared.ledgerBytes)}, usage cache ${formatBytes(m.report.shared.usageCacheBytes)}${m.report.shared.importedBytes ? `, v1 import ${formatBytes(m.report.shared.importedBytes)}` : ''}${m.report.shared.orphanFiles ? `, ${m.report.shared.orphanFiles} orphaned file${m.report.shared.orphanFiles === 1 ? '' : 's'} (${formatBytes(m.report.shared.orphanBytes)})` : ''}` : ''}
                                </Text>
                                {(m.report.sessions ?? []).length === 0 ? <Text style={styles.muted}>nothing attributable to a session</Text> : null}
                                {(m.report.looseTmux ?? []).length > 0 ? (
                                    <>
                                        <Text style={[styles.muted, { marginTop: 8 }]}>Loose tmux servers — nothing owns these. A live one may still have a process inside; a stale socket is just a file.</Text>
                                        {(m.report.looseTmux ?? []).map((l: StorageLooseTmux) => {
                                            const k = tmuxKey(m.machineId, l.label);
                                            const on = selected.has(k);
                                            const inside = l.alive ? (l.panes.length ? l.panes.map((p) => `${p.command}${p.pid ? ` (${p.pid})` : ''}`).join(', ') : 'no panes') : 'stale socket — no server';
                                            return (
                                                <Pressable key={k} onPress={() => toggle(k)} style={[styles.row, on && styles.rowOn]}>
                                                    <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? theme.colors.textLink : theme.colors.textSecondary} style={styles.check} />
                                                    <View style={{ flex: 1 }}>
                                                        <View style={styles.rowTop}>
                                                            <Text style={styles.title} numberOfLines={1}>{l.label}</Text>
                                                            <Text style={[styles.bytes, l.alive && { color: '#FF9500' }]}>{l.alive ? 'live' : 'stale'}</Text>
                                                        </View>
                                                        <Text style={styles.sub} numberOfLines={2}>
                                                            {[l.sessionId ? `session ${l.sessionId}` : null, inside, l.alive ? `${l.windows} window${l.windows === 1 ? '' : 's'}` : null, ageLabel(l.activityAt ?? l.createdAt)].filter(Boolean).join('  ·  ')}
                                                        </Text>
                                                    </View>
                                                </Pressable>
                                            );
                                        })}
                                    </>
                                ) : null}
                                {(m.report.sessions ?? []).map((s: StorageSession) => {
                                    const k = key(m.machineId, s.id);
                                    const on = selected.has(k);
                                    const rr = s.v2SessionId ? relay.get(s.v2SessionId) : undefined;
                                    const relayText = rr ? `relay ${rr.events} events · ${formatBytes(rr.bytes)}` : (s.v2SessionId ? 'relay —' : 'no relay row');
                                    return (
                                        <Pressable key={k} onPress={() => toggle(k)} style={[styles.row, on && styles.rowOn]}>
                                            <Ionicons name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? theme.colors.textLink : theme.colors.textSecondary} style={styles.check} />
                                            <View style={{ flex: 1 }}>
                                                <View style={styles.rowTop}>
                                                    <Text style={styles.title} numberOfLines={1}>{s.title || folderName(s.cwd) || s.id}</Text>
                                                    <Text style={styles.bytes}>{formatBytes(s.bytes)}</Text>
                                                </View>
                                                <Text style={styles.sub} numberOfLines={2}>
                                                    {[s.id, s.kind === 'running' ? '● running' : s.kind === 'detached' ? '○ detached — no agent' : (s.tmux?.alive ? '○ tmux up, no agent' : null), folderName(s.cwd), s.parts.join(' · ') || 'nothing on disk', relayText, ageLabel(s.newestAt ?? rr?.newest ?? null)].filter(Boolean).join('  ·  ')}
                                                </Text>
                                            </View>
                                        </Pressable>
                                    );
                                })}
                            </>
                        ) : null}
                    </View>
                ))}
                <View style={{ height: 96 }} />
            </ScrollView>
            {summary.count + summary.tmux > 0 ? (
                <View style={styles.bar}>
                    <Text style={styles.barText}>{summary.count + summary.tmux} selected · {formatBytes(summary.bytes)}{summary.relayEvents ? ` + ${summary.relayEvents} relay events` : ''}{summary.live ? ` · ${summary.live} running` : ''}{summary.tmux ? ` · ${summary.tmux} tmux` : ''}</Text>
                    <Pressable onPress={() => setSelected(new Set())} hitSlop={8}><Text style={styles.link}>clear</Text></Pressable>
                    <Pressable onPress={() => void nuke()} disabled={!!busy} style={[styles.nukeBtn, busy && { opacity: 0.5 }]}>
                        <Text style={styles.nukeText}>{busy ?? `Delete ${summary.count + summary.tmux}`}</Text>
                    </Pressable>
                </View>
            ) : null}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.groupped.background },
    content: { padding: 16, gap: 12 },
    intro: { fontSize: 13, color: theme.colors.textSecondary, marginBottom: 4, ...Typography.default() },
    machine: { backgroundColor: theme.colors.surface, borderRadius: 12, padding: 12, gap: 6 },
    machineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    machineName: { fontSize: 16, color: theme.colors.text, ...Typography.default('semiBold') },
    link: { fontSize: 13, color: theme.colors.textLink, ...Typography.default() },
    muted: { fontSize: 12, color: theme.colors.textSecondary, ...Typography.default() },
    errorText: { fontSize: 12, color: '#FF3B30', ...Typography.default() },
    row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider },
    rowOn: { backgroundColor: theme.colors.surfaceHigh, marginHorizontal: -12, paddingHorizontal: 12 },
    check: { marginTop: 1 },
    rowTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
    title: { flex: 1, fontSize: 14, color: theme.colors.text, ...Typography.default('semiBold') },
    bytes: { fontSize: 14, color: theme.colors.text, ...Typography.default() },
    sub: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 2, ...Typography.default() },
    bar: { position: 'absolute', left: 12, right: 12, bottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, backgroundColor: theme.colors.surface, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 4 },
    barText: { flex: 1, fontSize: 13, color: theme.colors.text, ...Typography.default() },
    nukeBtn: { backgroundColor: '#FF3B30', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 },
    nukeText: { color: '#fff', fontSize: 14, ...Typography.default('semiBold') },
}));
