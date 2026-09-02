// Machine view for joy-tmux: the daemon's live status (version, PID, uptime,
// OS, claude CLI) fetched over joy-status, plus links into the joy surfaces
// for this machine. This IS the /machine/[id] page now — the joy build has no
// separate stock machine view.
//
// Personal-build dev page — mostly plain strings (matches the /joy pages);
// shared bits (System group, copy toast) go through i18n.
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useMachine, storage } from '@/sync/storage';
import { useMachineOnline } from '@/hooks/useMachineOnline';
import { formatOSPlatform } from '@/utils/sessionUtils';
import { isJoyDaemonSource } from '@/sync/storageTypes';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { useJoyAction } from '@/hooks/useJoyAction';
import { machineEnvList, machineEnvSet, machineEnvUnset } from '@/sync/v2/machine';
import { Modal } from '@/modal';
import { t } from '@/text';
import * as Clipboard from 'expo-clipboard';
import { joyKillAllSessions, joyRestartDaemon, sessionDelete, machineUpdateMetadata } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { machineStatusOnly, machineSlashCommandsAll } from '@/sync/v2/machine';

// Bytes → "X.X GB" for the system readouts.
const gb = (bytes: number) => `${(bytes / (1024 ** 3)).toFixed(1)} GB`;

type JoyStatus = {
    ok?: boolean;
    version?: string;
    uptimeMs?: number;
    sessions?: number;
    messages?: number;
    clients?: number;
    pid?: number;
    os?: { platform?: string; release?: string; arch?: string; hostname?: string };
    claude?: { available: boolean; version: string | null };
};

function formatUptime(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const JoyMachineView = React.memo(({ machineId }: { machineId: string }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const machine = useMachine(machineId ?? '');
    const online = useMachineOnline(machine);
    // Slash-command count — plugins are always excluded.
    const slashCommandCount = React.useMemo(() => {
        const all = machine?.metadata?.slashCommands ?? [];
        const plugins = new Set(machine?.metadata?.pluginSlashCommands ?? []);
        return all.filter((c) => !plugins.has(c)).length;
    }, [machine?.metadata?.slashCommands, machine?.metadata?.pluginSlashCommands]);

    const copyMachineId = React.useCallback(async () => {
        await Clipboard.setStringAsync(machineId);
        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: t('machine.machineId') }));
    }, [machineId]);

    // Tap the command count to see the full list the daemon reported — plugins
    // marked "(plugin — hidden)". Diagnoses the two failure modes directly: if a
    // plugin command still shows in the composer but ISN'T marked here, the
    // daemon didn't report it in pluginSlashCommands (so the app can't filter it);
    // an empty list means the machine metadata hasn't reached the app at all.
    const showCommandList = React.useCallback(() => {
        const all = [...(machine?.metadata?.slashCommands ?? [])].sort();
        const plugins = new Set(machine?.metadata?.pluginSlashCommands ?? []);
        if (all.length === 0) {
            Modal.alert('Slash commands', 'None in this machine\'s metadata yet — the daemon hasn\'t reported any (or the update hasn\'t reached the app).');
            return;
        }
        const body = all.map((c) => (plugins.has(c) ? `${c}  (plugin — hidden)` : c)).join('\n');
        Modal.alert(`${all.length} commands · ${plugins.size} plugins`, body);
    }, [machine?.metadata?.slashCommands, machine?.metadata?.pluginSlashCommands]);

    const [status, setStatus] = React.useState<JoyStatus | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        if (!machineId || !online) {
            setFailed(!online);
            return;
        }
        let cancelled = false;
        let retry: ReturnType<typeof setTimeout> | null = null;
        // The machine record can come from the local cache (so `online` is
        // already true) before fetchMachines has decrypted this machine's data
        // key — machineOnlyCtx is null for that window. Wait for the key rather
        // than latching "unreachable" for the life of the page.
        const attempt = (triesLeft: number) => {
            if (cancelled) return;
            const sctx = sync.machineOnlyCtx(machineId);
            if (!sctx) {
                if (triesLeft > 0) retry = setTimeout(() => attempt(triesLeft - 1), 500);
                else setFailed(true);
                return;
            }
            Promise.race([
                machineStatusOnly(sctx).then(r => r.data as unknown as JoyStatus),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
            ]).then(s => { if (!cancelled) { setStatus(s); setFailed(false); } })
                .catch(() => { if (!cancelled) setFailed(true); });
        };
        attempt(20);
        return () => { cancelled = true; if (retry) clearTimeout(retry); };
    }, [machineId, online]);

    const machineName = machine?.metadata?.displayName || machine?.metadata?.host || 'machine';

    const renameMachine = React.useCallback(async () => {
        if (!machine?.metadata) return;
        const current = machine.metadata.displayName || '';
        const next = await Modal.prompt(t('machine.renameTitle'), t('machine.renameMessage', { host: machine.metadata.host }), { defaultValue: current });
        if (next == null) return; // cancelled
        const trimmed = next.trim();
        try {
            await machineUpdateMetadata(machine.id, {
                ...machine.metadata,
                // Empty input clears the custom name → UI falls back to the host.
                displayName: trimmed.length > 0 ? trimmed : undefined,
            }, machine.metadataVersion);
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : String(e));
        }
    }, [machine]);

    const [restarting, doRestartDaemon] = useJoyAction(React.useCallback(async () => {
        await joyRestartDaemon(machineId);
    }, [machineId]));

    const [killing, doKillAll] = useJoyAction(React.useCallback(async () => {
        const ok = await Modal.confirm(
            'Kill all sessions?',
            'Closes every session and the tmux session on this machine. Running Claude sessions are terminated.',
            { confirmText: 'Kill all', destructive: true },
        );
        if (!ok) return;
        await joyKillAllSessions(machineId);
    }, [machineId]));

    // Purge: permanently DELETE every joy session record for this machine (not
    // just deactivate, which "Kill all" does — those linger in history). Kill
    // live ones first so their tmux windows aren't re-adopted and re-created
    // after deletion. Works even on orphaned records the daemon no longer tracks,
    // since we delete from the app's own synced session list.
    const [purging, doPurgeAll] = useJoyAction(React.useCallback(async () => {
        const ok = await Modal.confirm(
            'Purge all sessions?',
            'Permanently DELETES every joy-tmux session record for this machine — they vanish from history and cannot be recovered. (Unlike "Kill all", which only ends them.) Live sessions are killed first.',
            { confirmText: 'Purge all', destructive: true },
        );
        if (!ok) return;
        // Best-effort: end live sessions so the daemon doesn't re-create records.
        await joyKillAllSessions(machineId).catch(() => { });
        const targets = Object.values(storage.getState().sessions).filter(
            (s) => isJoyDaemonSource(s.metadata?.joy__source) && s.metadata?.machineId === machineId,
        );
        let deleted = 0;
        for (const s of targets) {
            const r = await sessionDelete(s.id);
            if (r.success) deleted++;
        }
        Modal.alert('Purged', `Deleted ${deleted} session record${deleted === 1 ? '' : 's'} for this machine.`, [{ text: 'OK' }]);
    }, [machineId]));

    // Force the daemon to re-scan commands/skills/plugins now. It pushes the
    // refreshed list into machine metadata, so machine.metadata.slashCommands
    // updates without a separate fetch.
    const [refreshingCommands, doRefreshCommands] = useJoyAction(React.useCallback(async () => {
        const c0 = sync.machineOnlyCtx(machineId);
        if (!c0) throw new Error('no machine context');
        await machineSlashCommandsAll(c0, true);
    }, [machineId]));

    if (!status && !failed) {
        return (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                <ActivityIndicator />
                <Text style={{ color: theme.colors.textSecondary, fontSize: 14, ...Typography.default() }}>
                    asking the joy-tmux daemon…
                </Text>
            </View>
        );
    }

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={machineName}
                footer={failed ? (online ? 'The joy-tmux daemon did not respond on this machine.' : 'Machine is offline.') : undefined}
            >
                <Item
                    title="Daemon"
                    detail={status?.ok ? 'running' : 'unreachable'}
                    icon={<Ionicons name="pulse-outline" size={29} color={status?.ok ? '#34C759' : '#FF3B30'} />}
                    showChevron={false}
                />
                {status?.version && (
                    <Item title="joy-tmux Version" detail={status.version} icon={<Ionicons name="pricetag-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.pid != null && (
                    <Item title="Process ID" detail={String(status.pid)} icon={<Ionicons name="hardware-chip-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.uptimeMs != null && (
                    <Item title="Uptime" detail={formatUptime(status.uptimeMs)} icon={<Ionicons name="time-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {status?.os && (
                    <Item
                        title="Operating System"
                        subtitle={`${formatOSPlatform(status.os.platform ?? '')} ${status.os.release ?? ''} (${status.os.arch ?? '?'})`}
                        icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />}
                        showChevron={false}
                    />
                )}
                {status?.claude && (
                    <Item
                        title="Claude CLI"
                        detail={status.claude.available ? (status.claude.version ?? 'available') : 'not found'}
                        icon={<Ionicons name="sparkles-outline" size={29} color={status.claude.available ? '#9C27B0' : '#FF3B30'} />}
                        showChevron={false}
                    />
                )}
                {status?.sessions != null && (
                    <Item title="Active Sessions" detail={String(status.sessions)} icon={<Ionicons name="layers-outline" size={29} color="#007AFF" />} showChevron={false} />
                )}
            </ItemGroup>

            {machine?.metadata?.homeDir && (
                <ItemGroup title="Machine">
                    {/* Rename: sets metadata.displayName (CAS-merged; the daemon
                        deliberately carries an app-set name forward on every
                        upsert). Clearing the field falls back to the live host —
                        this is how a stale label (a Mac renamed at the OS level
                        after registration, e.g. beast-mini → boite) gets fixed. */}
                    <Item
                        title={t('machine.name')}
                        subtitle={machine.metadata.displayName || machine.metadata.host}
                        icon={<Ionicons name="pencil-outline" size={29} color="#5856D6" />}
                        onPress={renameMachine}
                    />
                    <Item title="Host" subtitle={machine.metadata.host} icon={<Ionicons name="server-outline" size={29} color="#5856D6" />} showChevron={false} />
                    <Item title="Home" subtitle={machine.metadata.homeDir} icon={<Ionicons name="home-outline" size={29} color="#5856D6" />} showChevron={false} />
                    {machine.metadata.joyDaemonVersion && (
                        <Item title="Daemon" subtitle={machine.metadata.joyDaemonVersion} icon={<Ionicons name="cube-outline" size={29} color="#5856D6" />} showChevron={false} />
                    )}
                    {machine.metadata.joyHomeDir && (
                        <Item title="Joy Home" subtitle={machine.metadata.joyHomeDir} icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />} showChevron={false} />
                    )}
                    <Item
                        title="Machine ID"
                        subtitle={machineId}
                        subtitleLines={1}
                        icon={<Ionicons name="finger-print-outline" size={29} color="#5856D6" />}
                        onPress={copyMachineId}
                    />
                </ItemGroup>
            )}

            {(() => {
                const ds = machine?.daemonState as {
                        cpu?: number; ram?: number; cpuCount?: number; cpuModel?: string; load?: number;
                        memFree?: number; memTotal?: number; diskFree?: number; diskTotal?: number;
                    } | null;
                    if (!ds) return null;
                    const memUsed = ds.memTotal != null && ds.memFree != null ? ds.memTotal - ds.memFree : null;
                    // Disk as a used-% like RAM; ≥90% on either is the "your
                    // queueing/stray-text weirdness may be resource pressure"
                    // threshold — flag it loudly.
                    const diskPct = ds.diskTotal && ds.diskFree != null
                        ? Math.max(0, Math.min(100, Math.round((1 - ds.diskFree / ds.diskTotal) * 100)))
                        : null;
                    const ramHot = ds.ram != null && ds.ram >= 90;
                    const diskHot = diskPct != null && diskPct >= 90;
                    return (
                        <ItemGroup title={t('machine.system')} footer={t('machine.systemFooter')}>
                            <Item
                                title="CPU"
                                detail={ds.cpu != null ? `${ds.cpu}%` : '—'}
                                subtitle={[ds.cpuModel, ds.cpuCount != null ? t('machine.cpuCores', { count: ds.cpuCount }) : null, ds.load != null ? t('machine.loadAverage', { load: ds.load.toFixed(2) }) : null].filter(Boolean).join(' · ') || undefined}
                                icon={<Ionicons name="speedometer-outline" size={29} color="#FF9500" />}
                                showChevron={false}
                            />
                            <Item
                                title={ramHot ? 'Memory ⚠' : 'Memory'}
                                detail={ds.ram != null ? `${ds.ram}%` : '—'}
                                detailStyle={ramHot ? { color: '#FF3B30', fontWeight: '600' } : undefined}
                                subtitle={ds.memTotal != null && memUsed != null ? `${gb(memUsed)} / ${gb(ds.memTotal)}` : undefined}
                                icon={<Ionicons name="hardware-chip-outline" size={29} color={ramHot ? '#FF3B30' : '#34C759'} />}
                                showChevron={false}
                            />
                            <Item
                                title={diskHot ? 'Disk ⚠' : 'Disk'}
                                detail={diskPct != null ? `${diskPct}%` : '—'}
                                detailStyle={diskHot ? { color: '#FF3B30', fontWeight: '600' } : undefined}
                                subtitle={ds.diskTotal ? t('machine.diskFree', { free: gb(ds.diskFree ?? 0), total: gb(ds.diskTotal) }) : undefined}
                                icon={<Ionicons name="save-outline" size={29} color={diskHot ? '#FF3B30' : '#5856D6'} />}
                                showChevron={false}
                            />
                        </ItemGroup>
                    );
                })()}

            <EnvironmentSection machineId={machineId} online={online} />
            <ItemGroup title="Slash commands" footer="Commands & skills joy-tmux found on this machine — personal, plugins, and every project it has scanned. They appear in the composer's / menu.">
                <Item
                    title="Available"
                    detail={String(slashCommandCount)}
                    subtitle="Tap to list every command the daemon reported"
                    icon={<Ionicons name="terminal-outline" size={29} color="#34C759" />}
                    onPress={showCommandList}
                />
                <Item
                    title="Refresh"
                    subtitle="Re-scan commands, skills & plugins now"
                    icon={refreshingCommands
                        ? <ActivityIndicator />
                        : <Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                    onPress={doRefreshCommands}
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title="Go to">
                <Item
                    title="Sessions"
                    subtitle="Browse this machine's projects & session logs"
                    icon={<Ionicons name="folder-outline" size={29} color="#34C759" />}
                    onPress={() => router.push(`/machine/${machineId}/projects` as any)}
                />
                <Item
                    title="Sessions"
                    subtitle="Manage joy-tmux sessions on this machine"
                    icon={<Ionicons name="terminal-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push('/settings/joy-sessions')}
                />
                <Item
                    title="New Session"
                    icon={<Ionicons name="add-circle-outline" size={29} color="#007AFF" />}
                    onPress={() => router.push({ pathname: '/joy/new', params: machineId ? { machineId } : {} })}
                />
                <Item
                    title="Usage & Cost"
                    subtitle="Token usage and cost for this machine"
                    icon={<Ionicons name="flame-outline" size={29} color="#FF6B35" />}
                    onPress={() => router.push(`/settings/usage/${machineId}` as any)}
                />
            </ItemGroup>

            <ItemGroup title="Daemon actions" footer="Restart re-execs joy-tmux (running sessions survive). Kill all ends every session + the tmux session (they stay in history). Purge permanently deletes every joy session record for this machine.">
                <Item
                    title="Restart Daemon"
                    subtitle="Re-exec joy-tmux; running sessions survive"
                    icon={restarting
                        ? <ActivityIndicator />
                        : <Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                    onPress={doRestartDaemon}
                    showChevron={false}
                />
                <Item
                    title="Kill all Sessions"
                    subtitle="Close every session + the tmux session"
                    icon={killing
                        ? <ActivityIndicator />
                        : <Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                    onPress={doKillAll}
                    showChevron={false}
                />
                <Item
                    title="Purge and kill all Sessions"
                    subtitle="Kill every live session, then permanently delete all records for this machine"
                    icon={purging
                        ? <ActivityIndicator />
                        : <Ionicons name="nuclear-outline" size={29} color="#FF3B30" />}
                    onPress={doPurgeAll}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});

/**
 * The daemon's sealed environment store (provider keys every new session
 * inherits). Names only travel to the app; values go DOWN the sealed tunnel
 * once, when set. Applies to sessions spawned from now on.
 */
const EnvironmentSection = React.memo(({ machineId, online }: { machineId: string; online: boolean }) => {
    const [names, setNames] = React.useState<string[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const reload = React.useCallback(async () => {
        const ctx = sync.machineOnlyCtx(machineId);
        if (!ctx) { setError('no_ctx'); return; }
        const r = await machineEnvList(ctx);
        if (r.data?.ok) { setNames(r.data.names ?? []); setError(null); }
        else setError(r.data?.error ?? `http_${r.status}`);
    }, [machineId]);
    React.useEffect(() => { if (online) void reload(); }, [online, reload]);
    const [adding, doAdd] = useJoyAction(React.useCallback(async () => {
        const ctx = sync.machineOnlyCtx(machineId);
        if (!ctx) return;
        const name = (await Modal.prompt(t('machine.environmentAdd'), t('machine.environmentNamePrompt'), { placeholder: 'FIREWORKS_API_KEY' }))?.trim();
        if (!name) return;
        const value = await Modal.prompt(name, t('machine.environmentValuePrompt', { name }), { inputType: 'secure-text' });
        if (value == null) return;
        const r = await machineEnvSet(ctx, name, value);
        if (!r.data?.ok) { Modal.alert(t('common.error'), r.data?.error ?? `http_${r.status}`); return; }
        await reload();
    }, [machineId, reload]));
    const remove = React.useCallback((name: string) => {
        Modal.alert(t('machine.environmentRemoveTitle'), t('machine.environmentRemoveMessage', { name }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => {
                void (async () => {
                    const ctx = sync.machineOnlyCtx(machineId);
                    if (!ctx) return;
                    await machineEnvUnset(ctx, name);
                    await reload();
                })();
            } },
        ]);
    }, [machineId, reload]);
    if (!online) return null;
    return (
        <ItemGroup title={t('machine.environment')} footer={t('machine.environmentFooter')}>
            {error === 'no_machine_key' && (
                <Item title={t('machine.environmentUnavailable')} icon={<Ionicons name="lock-closed-outline" size={29} color="#FF9500" />} showChevron={false} />
            )}
            {names?.map((n) => (
                <Item key={n} title={n} detail="••••••" icon={<Ionicons name="key-outline" size={29} color="#5856D6" />} onPress={() => remove(n)} showChevron={false} />
            ))}
            {names && names.length === 0 && !error && (
                <Item title={t('machine.environmentNone')} icon={<Ionicons name="key-outline" size={29} color="#8E8E93" />} showChevron={false} />
            )}
            <Item
                title={t('machine.environmentAdd')}
                subtitle={t('machine.environmentAddSubtitle')}
                icon={adding ? <ActivityIndicator /> : <Ionicons name="add-circle-outline" size={29} color="#007AFF" />}
                onPress={doAdd}
                showChevron={false}
            />
        </ItemGroup>
    );
});
