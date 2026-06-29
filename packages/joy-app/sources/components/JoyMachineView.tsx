// Machine view for joy-tmux: the daemon's live status (version, PID, uptime,
// OS, claude CLI) fetched over joy-status, plus links into the joy surfaces
// for this machine. This IS the /machine/[id] page now — the joy build has no
// separate happy-daemon machine view.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useMachine, storage } from '@/sync/storage';
import { useMachineOnline } from '@/hooks/useMachineOnline';
import { formatOSPlatform } from '@/utils/sessionUtils';
import { apiSocket } from '@/sync/apiSocket';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';
import { useHappyAction } from '@/hooks/useHappyAction';
import { Modal } from '@/modal';
import { joyKillAllSessions, joyRestartDaemon, sessionDelete } from '@/sync/ops';

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

    const [status, setStatus] = React.useState<JoyStatus | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        if (!machineId || !online) {
            setFailed(!online);
            return;
        }
        let cancelled = false;
        Promise.race([
            apiSocket.machineRPC<JoyStatus, {}>(machineId, 'joy-status', {}),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
        ]).then(s => { if (!cancelled) setStatus(s); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [machineId, online]);

    const machineName = machine?.metadata?.displayName || machine?.metadata?.host || 'machine';

    const [restarting, doRestartDaemon] = useHappyAction(React.useCallback(async () => {
        await joyRestartDaemon(machineId);
    }, [machineId]));

    const [killing, doKillAll] = useHappyAction(React.useCallback(async () => {
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
    const [purging, doPurgeAll] = useHappyAction(React.useCallback(async () => {
        const ok = await Modal.confirm(
            'Purge all sessions?',
            'Permanently DELETES every joy-tmux session record for this machine — they vanish from history and cannot be recovered. (Unlike "Kill all", which only ends them.) Live sessions are killed first.',
            { confirmText: 'Purge all', destructive: true },
        );
        if (!ok) return;
        // Best-effort: end live sessions so the daemon doesn't re-create records.
        await joyKillAllSessions(machineId).catch(() => { });
        const targets = Object.values(storage.getState().sessions).filter(
            (s) => s.metadata?.joy__source === 'joy-tmux' && s.metadata?.machineId === machineId,
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
    const [refreshingCommands, doRefreshCommands] = useHappyAction(React.useCallback(async () => {
        await apiSocket.machineRPC(machineId, 'joy-refresh-commands', {});
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
                    <Item title="Host" subtitle={machine.metadata.host} icon={<Ionicons name="server-outline" size={29} color="#5856D6" />} showChevron={false} />
                    <Item title="Home" subtitle={machine.metadata.homeDir} icon={<Ionicons name="home-outline" size={29} color="#5856D6" />} showChevron={false} />
                </ItemGroup>
            )}

            <ItemGroup title="Slash commands" footer="Commands & skills joy-tmux found on this machine — personal, plugins, and every project it has scanned. They appear in the composer's / menu.">
                <Item
                    title="Available"
                    detail={String((machine?.metadata?.slashCommands ?? []).length)}
                    subtitle="Shown in the composer's / autocomplete"
                    icon={<Ionicons name="terminal-outline" size={29} color="#34C759" />}
                    showChevron={false}
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
