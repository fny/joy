import * as React from 'react';
import { Pressable, ActivityIndicator, View, ScrollView, Text } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useJoyAction } from '@/hooks/useJoyAction';
import { useJoyRpcSessions } from '@/hooks/useJoyRpcSessions';
import type { JoySession } from '@/joy/types';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { StyleSheet } from 'react-native-unistyles';
import { resources } from '@/sync/resource';
import { joyMachinesSpec, joyStatusSpec } from '@/sync/machineResources';
import { useResource } from '@/hooks/useResource';

const NO_MACHINES = new Set<string>();

export default React.memo(function JoySessionsScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const onlineMachines = machines.filter(isMachineOnline);
    const offlineMachines = machines.filter(m => !isMachineOnline(m));

    // Which online machines run joy-daemon: a RESOURCE keyed by the probed
    // set (sync/machineResources). Survives navigation in the resource cache,
    // so revisits render the machine list instantly while a background
    // re-probe keeps it fresh. A change of the online set is a new key, so a
    // run for the old set can never settle into the new one and the screen
    // cannot sit on Loading forever (#178); with no online machines there is
    // nothing to probe.
    const onlineIds = onlineMachines.map(m => m.id).join(',');
    const probeSpec = React.useMemo(() => joyMachinesSpec(onlineIds ? onlineIds.split(',') : []), [onlineIds]);
    const probe = useResource(probeSpec, { enabled: onlineMachines.length > 0 });
    // null = first-ever probe for this set in flight; afterwards the ids that answered.
    const joyMachineIds: Set<string> | null = onlineMachines.length === 0
        ? NO_MACHINES
        : probe.data ? new Set(probe.data) : null;

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(
        () => resources.peek<string[]>(probeSpec.key).data?.[0] ?? null,
    );
    React.useEffect(() => {
        const found = probe.data;
        if (!found) return;
        setSelectedMachineId(prev => (prev && found.includes(prev)) ? prev : (found[0] ?? null));
    }, [probe.data]);
    // "Probe again": a failed or empty probe can be retried without leaving the screen.
    const probeAgain = React.useCallback(() => { void probe.refresh(); }, [probe.refresh]);

    const handleSelectMachine = React.useCallback((id: string) => {
        setSelectedMachineId(id);
    }, []);

    // Only machines that actually run joy-tmux are listed — an online
    // machine without the daemon can't serve any of the RPCs this page uses.
    const visibleMachines = joyMachineIds === null
        ? []
        : onlineMachines.filter(m => joyMachineIds.has(m.id));
    const probing = joyMachineIds === null && onlineMachines.length > 0;
    const withoutJoyCount = joyMachineIds === null
        ? 0
        : (onlineMachines.length - visibleMachines.length) + offlineMachines.length;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSessions.machines')}>
                {machines.length === 0 ? (
                    <Item title={t('settingsSessions.noMachine')} showChevron={false} />
                ) : probing ? (
                    <Item title={t('settingsSessions.loading')} showChevron={false} rightElement={<ActivityIndicator />} />
                ) : visibleMachines.length === 0 ? (
                    <Item
                        title="No machines running joy-daemon"
                        subtitle={onlineMachines.length > 0 ? 'Tap to probe again' : undefined}
                        onPress={onlineMachines.length > 0 ? probeAgain : undefined}
                        showChevron={false}
                    />
                ) : (
                    <>
                        {visibleMachines.map(machine => {
                            const isOnline = isMachineOnline(machine);
                            const isSelected = machine.id === selectedMachineId;
                            // Before metadata is known (first-ever load, no cache yet) show a short
                            // id rather than a jarring full UUID; the real name fills in on fetch.
                            const name = machine.metadata?.displayName || machine.metadata?.host || machine.id.slice(0, 8);
                            const platform = machine.metadata?.platform || '';
                            const status = isOnline ? t('settingsSessions.statusOnline') : t('settingsSessions.statusOffline');
                            const subtitle = platform ? `${platform} • ${status}` : status;
                            return (
                                <Item
                                    key={machine.id}
                                    title={name}
                                    subtitle={subtitle}
                                    icon={
                                        <Ionicons
                                            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                                            size={29}
                                            color={isOnline ? '#34C759' : '#8E8E93'}
                                        />
                                    }
                                    onPress={() => handleSelectMachine(machine.id)}
                                    showChevron={false}
                                />
                            );
                        })}
                        {withoutJoyCount > 0 && (
                            <Item
                                title={`${withoutJoyCount} machine${withoutJoyCount === 1 ? '' : 's'} without joy-daemon hidden`}
                                showChevron={false}
                            />
                        )}
                    </>
                )}
            </ItemGroup>

            {/* Keyed by machine: selecting another machine REMOUNTS the session
                list, so its RPC hook, poll and pending responses belong to one
                machine for their whole life. A late list from machine A can no
                longer land in B's rows, and every row action (terminal, kill,
                screenshot) is bound to the machine that produced the row (#179). */}
            {selectedMachineId && <MachineSessions key={selectedMachineId} machineId={selectedMachineId} />}
        </ItemList>
    );
});

const MachineSessions = React.memo(function MachineSessions({ machineId }: { machineId: string }) {
    const { sessions, loading, error, createSession, killSession, fetchPane } = useJoyRpcSessions(machineId);

    // Daemon card: the machine's joy-status resource (4s probe, keyed by
    // machine — another machine's answer can never fill this card).
    const daemonStatus = useResource(React.useMemo(() => joyStatusSpec(machineId), [machineId])).data ?? null;

    const killingIdRef = React.useRef<string | null>(null);
    const screenshotIdRef = React.useRef<string | null>(null);

    const [createLoading, doCreate] = useJoyAction(React.useCallback(async () => {
        const cwd = await Modal.prompt(
            t('settingsSessions.newSession'),
            t('settingsSessions.workingDirectory'),
            { placeholder: t('settingsSessions.workingDirectoryPlaceholder') },
        );
        if (!cwd?.trim()) return;
        await createSession(cwd.trim());
    }, [createSession]));

    const [, doKill] = useJoyAction(React.useCallback(async () => {
        const id = killingIdRef.current;
        if (!id) return;
        await killSession(id);
    }, [killSession]));

    const [screenshotLoading, doScreenshot] = useJoyAction(React.useCallback(async () => {
        const id = screenshotIdRef.current;
        if (!id) return;
        const text = await fetchPane(id);
        Modal.show({ component: PaneViewModal, props: { text } });
    }, [fetchPane]));

    const handleScreenshot = React.useCallback((session: JoySession) => {
        screenshotIdRef.current = session.id;
        doScreenshot();
    }, [doScreenshot]);

    const handleOpenTerminal = React.useCallback((session: JoySession) => {
        router.push(`/joy/pane/${encodeURIComponent(machineId)}/${encodeURIComponent(session.id)}`);
    }, [machineId]);

    const handleKill = React.useCallback((session: JoySession) => {
        Modal.alert(
            t('settingsSessions.confirmKill'),
            session.cwd,
            [
                { text: t('common.cancel'), style: 'cancel' },
                {
                    text: t('settingsSessions.killSession'),
                    style: 'destructive',
                    onPress: () => { killingIdRef.current = session.id; doKill(); },
                },
            ],
        );
    }, [doKill]);

    const activeSessions = sessions.filter(s => s.status !== 'ended');
    // Ended sessions the daemon still remembers (in-memory — clears when the
    // daemon restarts). Chat history survives on the relay regardless.
    const endedSessions = sessions.filter(s => s.status === 'ended');

    return (
        <>
            <ItemGroup
                title={t('settingsSessions.sessions')}
                footer={error ?? undefined}
            >
                {loading && activeSessions.length === 0 ? (
                    <Item
                        title={t('settingsSessions.loading')}
                        showChevron={false}
                        rightElement={<ActivityIndicator />}
                    />
                ) : activeSessions.length === 0 ? (
                    <Item
                        title={t('settingsSessions.noSessions')}
                        showChevron={false}
                    />
                ) : (
                    [...activeSessions].sort((a, b) => ((a as any).agent ?? 'claude').localeCompare((b as any).agent ?? 'claude')).map(session => (
                        <Item
                            key={session.id}
                            title={session.cwd.split('/').pop() ?? session.cwd}
                            subtitle={`${(session as any).agent ?? 'claude'} · ${statusLabel(session.status)} · ${session.cwd}`}
                            onPress={session.relay_session_id ? () => router.push(`/session/${encodeURIComponent(session.relay_session_id!)}`) : undefined}
                            showChevron={!!session.relay_session_id}
                            rightElement={
                                <View style={styles.sessionActions}>
                                    <Pressable
                                        onPress={() => handleOpenTerminal(session)}
                                        onLongPress={() => handleScreenshot(session)}
                                        style={styles.actionButton}
                                        hitSlop={8}
                                    >
                                        {screenshotLoading && screenshotIdRef.current === session.id
                                            ? <ActivityIndicator size="small" />
                                            : <Ionicons name="terminal-outline" size={20} color="#8E8E93" />
                                        }
                                    </Pressable>
                                    <Pressable
                                        onPress={() => handleKill(session)}
                                        style={styles.actionButton}
                                        hitSlop={8}
                                    >
                                        <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                                    </Pressable>
                                </View>
                            }
                        />
                    ))
                )}
                <Item
                    title={t('settingsSessions.newSession')}
                    icon={<Ionicons name="add-circle-outline" size={29} color="#34C759" />}
                    onPress={doCreate}
                    showChevron={false}
                    rightElement={createLoading ? <ActivityIndicator /> : undefined}
                />
            </ItemGroup>

            {daemonStatus?.ok && (
                <ItemGroup title="Daemon">
                    <Item
                        title="joy-tmux"
                        subtitle={`${daemonStatus.version ?? ''}${daemonStatus.uptimeMs != null ? ` · up ${formatUptime(daemonStatus.uptimeMs)}` : ''}`}
                        icon={<Ionicons name="pulse-outline" size={29} color="#34C759" />}
                        showChevron={false}
                    />
                    <Item
                        title="claude"
                        subtitle={daemonStatus.claude?.available ? (daemonStatus.claude.version ?? 'available') : 'not found on PATH'}
                        icon={<Ionicons
                            name={daemonStatus.claude?.available ? 'checkmark-circle-outline' : 'close-circle-outline'}
                            size={29}
                            color={daemonStatus.claude?.available ? '#34C759' : '#FF3B30'}
                        />}
                        showChevron={false}
                    />
                </ItemGroup>
            )}

            {endedSessions.length > 0 && (
                <ItemGroup title="Previous sessions" footer="Held in daemon memory — clears on joy-tmux restart. Chat history stays on the relay.">
                    {endedSessions.map(session => (
                        <Item
                            key={session.id}
                            title={session.cwd.split('/').pop() ?? session.cwd}
                            subtitle={`${session.end_reason ?? 'ended'} · ${session.cwd}`}
                            onPress={session.relay_session_id ? () => router.push(`/session/${encodeURIComponent(session.relay_session_id!)}`) : undefined}
                            showChevron={!!session.relay_session_id}
                        />
                    ))}
                </ItemGroup>
            )}
        </>
    );
});

function PaneViewModal({ text, onClose }: { text: string; onClose: () => void }) {
    return (
        <View style={paneStyles.container}>
            <View style={paneStyles.header}>
                <Text style={paneStyles.headerTitle}>{t('settingsSessions.screenshot')}</Text>
                <Pressable onPress={onClose} hitSlop={8}>
                    <Ionicons name="close" size={22} color="#fff" />
                </Pressable>
            </View>
            <ScrollView style={paneStyles.scroll} contentContainerStyle={paneStyles.content}>
                <Text style={paneStyles.text} selectable>{text}</Text>
            </ScrollView>
        </View>
    );
}

function formatUptime(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d`;
}

function statusLabel(status: JoySession['status']): string {
    if (status === 'starting') return t('settingsSessions.statusStarting');
    if (status === 'active') return t('settingsSessions.statusActive');
    return t('settingsSessions.statusEnded');
}

const styles = StyleSheet.create({
    sessionActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    actionButton: {
        padding: 8,
    },
});

const paneStyles = StyleSheet.create((_, runtime) => ({
    container: {
        width: runtime.screen.width * 0.92,
        maxHeight: runtime.screen.height * 0.75,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: '#1c1c1e',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: '#2c2c2e',
    },
    headerTitle: {
        color: '#ffffff',
        fontSize: 15,
        fontWeight: '600',
    },
    scroll: {
        flex: 1,
    },
    content: {
        padding: 12,
    },
    text: {
        color: '#d4d4d4',
        fontSize: 11,
        fontFamily: 'monospace',
        lineHeight: 16,
    },
}));
