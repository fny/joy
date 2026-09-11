// Relay: the box the relay runs on, as it reports itself — cpu, memory,
// disk under / and under the data dir, the database's size and counts, leases
// and SSE clients, uptime and version. The same rows the machine page shows
// for every daemon, pointed at the relay. Read on open and every 15 s while
// this screen is up; a failed read keeps the last good one and says how old.
//
// The one thing it cannot report is whether the disk is encrypted at rest —
// that is an AWS fact invisible from inside the guest.
//
// Personal-build dev surface — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ScrollView, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { v2, type RelayStatus } from '@/sync/v2/api';
import { getV2BaseUrl } from '@/sync/v2/api';
import { useActiveInterval } from '@/hooks/useActiveInterval';
import { formatBytes, ageLabel } from '@/utils/storageFormat';

const HOT = 90;

function uptime(s: number): string {
    const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function RelayScreen() {
    const { theme } = useUnistyles();
    const [status, setStatus] = React.useState<RelayStatus | null>(null);
    const [readAt, setReadAt] = React.useState<number | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const load = React.useCallback(async () => {
        try { setStatus(await v2.relayStatus()); setReadAt(Date.now()); setError(null); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    }, []);
    useActiveInterval(() => { void load(); }, 15_000);

    const s = status;
    const cpuHot = !!s && s.host.cpuPercent >= HOT;
    const memHot = !!s && s.host.memUsedPercent >= HOT;
    const rootHot = !!s && (s.disk.root.usedPercent ?? 0) >= HOT;
    const dataHot = !!s?.disk.data && (s.disk.data.usedPercent ?? 0) >= HOT;
    const warn = { color: '#FF3B30', fontWeight: '600' as const };

    return (
        <>
            <Stack.Screen options={{ headerTitle: 'Relay' }} />
            <ItemList>
                {!s && !error ? <ActivityIndicator style={{ marginTop: 24 }} /> : null}
                {error ? (
                    <ItemGroup footer={s ? `Showing the last good read, ${ageLabel(readAt)}.` : undefined}>
                        <Item title="Unreachable" subtitle={error} icon={<Ionicons name="cloud-offline-outline" size={29} color="#FF3B30" />} showChevron={false} />
                    </ItemGroup>
                ) : null}
                {s ? (
                    <>
                        <ItemGroup title="Relay" footer={`${getV2BaseUrl()} · read ${ageLabel(readAt)}`}>
                            <Item title="Version" detail={`${s.version ?? '—'} · node ${s.node}`} icon={<Ionicons name="git-branch-outline" size={29} color={theme.colors.accents.blue} />} showChevron={false} />
                            <Item title="Uptime" detail={uptime(s.uptimeSeconds)} subtitle={s.host.hostname} icon={<Ionicons name="time-outline" size={29} color="#34C759" />} showChevron={false} />
                        </ItemGroup>
                        <ItemGroup title="System" footer="Same rows as a machine page, for the relay itself. Red at 90%.">
                            <Item title={cpuHot ? 'CPU ⚠' : 'CPU'} detail={`${s.host.cpuPercent}%`} detailStyle={cpuHot ? warn : undefined}
                                subtitle={[s.host.cpuModel, `${s.host.cpuCount} cores`, `load ${s.host.load1}`].filter(Boolean).join(' · ')}
                                icon={<Ionicons name="speedometer-outline" size={29} color={cpuHot ? '#FF3B30' : '#FF9500'} />} showChevron={false} />
                            <Item title={memHot ? 'Memory ⚠' : 'Memory'} detail={`${s.host.memUsedPercent}%`} detailStyle={memHot ? warn : undefined}
                                subtitle={`${formatBytes(s.host.memTotalBytes - s.host.memAvailableBytes)} / ${formatBytes(s.host.memTotalBytes)} · relay process ${formatBytes(s.host.processRssBytes)}`}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color={memHot ? '#FF3B30' : '#34C759'} />} showChevron={false} />
                            <Item title={rootHot ? 'Disk ⚠' : 'Disk'} detail={s.disk.root.usedPercent != null ? `${s.disk.root.usedPercent}%` : '—'} detailStyle={rootHot ? warn : undefined}
                                subtitle={s.disk.root.totalBytes != null ? `${formatBytes(s.disk.root.freeBytes)} free of ${formatBytes(s.disk.root.totalBytes)} on /` : undefined}
                                icon={<Ionicons name="save-outline" size={29} color={rootHot ? '#FF3B30' : '#5856D6'} />} showChevron={false} />
                            {s.disk.data && s.disk.data.path !== '/' && s.disk.data.totalBytes !== s.disk.root.totalBytes ? (
                                <Item title={dataHot ? 'Data disk ⚠' : 'Data disk'} detail={s.disk.data.usedPercent != null ? `${s.disk.data.usedPercent}%` : '—'} detailStyle={dataHot ? warn : undefined}
                                    subtitle={`${formatBytes(s.disk.data.freeBytes)} free of ${formatBytes(s.disk.data.totalBytes)} under ${s.disk.data.path}`}
                                    icon={<Ionicons name="save-outline" size={29} color={dataHot ? '#FF3B30' : '#5856D6'} />} showChevron={false} />
                            ) : null}
                        </ItemGroup>
                        <ItemGroup title="Database" footer={s.db.dataDir ? `Embedded Postgres under ${s.db.dataDir}.` : undefined}>
                            <Item title="Size" detail={formatBytes(s.db.dataDirBytes ?? s.db.sizeBytes)} subtitle={s.db.sizeBytes != null && s.db.dataDirBytes != null ? `database ${formatBytes(s.db.sizeBytes)} · on disk ${formatBytes(s.db.dataDirBytes)}` : undefined}
                                icon={<Ionicons name="server-outline" size={29} color={theme.colors.accents.blue} />} showChevron={false} />
                            <Item title="Sessions" detail={`${s.db.sessions ?? '—'}`} subtitle={s.db.sessionsLive != null ? `${s.db.sessionsLive} live` : undefined} icon={<Ionicons name="chatbubbles-outline" size={29} color={theme.colors.textSecondary} />} showChevron={false} />
                            <Item title="Events" detail={`${s.db.events ?? '—'}`} subtitle="rows across every session — Settings → Machines → Storage shows them per session" icon={<Ionicons name="list-outline" size={29} color={theme.colors.textSecondary} />} showChevron={false} />
                            <Item title="Accounts · machines" detail={`${s.db.accounts ?? '—'} · ${s.db.machines ?? '—'}`} icon={<Ionicons name="people-outline" size={29} color={theme.colors.textSecondary} />} showChevron={false} />
                        </ItemGroup>
                        <ItemGroup title="Live">
                            <Item title="Daemons connected" detail={`${s.live.daemonLeases ?? '—'}`} subtitle="unexpired leases" icon={<Ionicons name="hardware-chip-outline" size={29} color="#34C759" />} showChevron={false} />
                            <Item title="Apps streaming" detail={`${s.live.sseClients ?? '—'}`} subtitle={s.live.sseAccounts != null ? `${s.live.sseAccounts} account${s.live.sseAccounts === 1 ? '' : 's'}` : undefined} icon={<Ionicons name="radio-outline" size={29} color={theme.colors.accents.blue} />} showChevron={false} />
                        </ItemGroup>
                        <View style={{ height: 24 }} />
                    </>
                ) : null}
            </ItemList>
        </>
    );
}
