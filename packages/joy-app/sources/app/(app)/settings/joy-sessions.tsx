import * as React from 'react';
import { Pressable, ActivityIndicator, View, ScrollView, Text } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useJoyRpcSessions } from '@/hooks/useJoyRpcSessions';
import type { JoySession } from '@/joy/types';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { apiSocket } from '@/sync/apiSocket';
import { StyleSheet } from 'react-native-unistyles';

// Survives navigation: which machines answered the joy-tmux probe last time.
// Lets revisits render the machine list instantly while a background
// re-probe keeps it fresh.
let cachedJoyMachineIds: Set<string> | null = null;

export default React.memo(function JoySessionsScreen() {
    const machines = useAllMachines({ includeOffline: true });
    const onlineMachines = machines.filter(isMachineOnline);
    const offlineMachines = machines.filter(m => !isMachineOnline(m));

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(
        () => cachedJoyMachineIds?.values().next().value ?? null,
    );
    // null = first-ever probe in flight; afterwards the set of machine ids
    // that answered a joy-list-sessions probe within 3s. Online machines
    // without joy-tmux never respond (machineRPC has no timeout), hence the
    // per-probe race. Results are cached module-level: the happy machine
    // list renders instantly from synced storage, and without the cache this
    // page ate a 3s live-probe on every visit. Cached results render
    // immediately; a background re-probe refreshes them.
    const [joyMachineIds, setJoyMachineIds] = React.useState<Set<string> | null>(cachedJoyMachineIds);
    const probedRef = React.useRef(false);

    React.useEffect(() => {
        if (probedRef.current || onlineMachines.length === 0) return;
        probedRef.current = true;
        let cancelled = false;
        (async () => {
            const probeOne = (id: string) => Promise.race([
                apiSocket.machineRPC(id, 'joy-list-sessions', {}).then(() => id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
            ]);
            const results = await Promise.allSettled(onlineMachines.map(m => probeOne(m.id)));
            if (cancelled) return;
            const found = new Set(
                results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value),
            );
            cachedJoyMachineIds = found;
            setJoyMachineIds(found);
            setSelectedMachineId(prev => prev ?? (found.values().next().value ?? null));
        })();
        return () => { cancelled = true; };
    }, [onlineMachines.map(m => m.id).join(',')]);

    const handleSelectMachine = React.useCallback((id: string) => {
        probedRef.current = true;
        setSelectedMachineId(id);
    }, []);

    const { sessions, loading, error, createSession, killSession, fetchPane } = useJoyRpcSessions(selectedMachineId);

    // Daemon card: one-shot joy-status fetch per machine selection.
    type JoyStatus = { ok: boolean; version?: string; uptimeMs?: number; claude?: { available: boolean; version: string | null } };
    const [daemonStatus, setDaemonStatus] = React.useState<JoyStatus | null>(null);
    React.useEffect(() => {
        setDaemonStatus(null);
        if (!selectedMachineId) return;
        let cancelled = false;
        Promise.race([
            apiSocket.machineRPC<JoyStatus, {}>(selectedMachineId, 'joy-status', {}),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]).then(s => { if (!cancelled) setDaemonStatus(s); }).catch(() => { /* card stays hidden */ });
        return () => { cancelled = true; };
    }, [selectedMachineId]);

    const killingIdRef = React.useRef<string | null>(null);
    const screenshotIdRef = React.useRef<string | null>(null);

    const [createLoading, doCreate] = useHappyAction(React.useCallback(async () => {
        const cwd = await Modal.prompt(
            t('settingsSessions.newSession'),
            t('settingsSessions.workingDirectory'),
            { placeholder: t('settingsSessions.workingDirectoryPlaceholder') },
        );
        if (!cwd?.trim()) return;
        await createSession(cwd.trim());
    }, [createSession]));

    const [, doKill] = useHappyAction(React.useCallback(async () => {
        const id = killingIdRef.current;
        if (!id) return;
        await killSession(id);
    }, [killSession]));

    const [screenshotLoading, doScreenshot] = useHappyAction(React.useCallback(async () => {
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
        if (!selectedMachineId) return;
        router.push(`/joy/pane/${encodeURIComponent(selectedMachineId)}/${encodeURIComponent(session.id)}`);
    }, [selectedMachineId]);

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

    // Only machines that actually run joy-tmux are listed — an online happy
    // machine without the daemon can't serve any of the RPCs this page uses.
    const visibleMachines = joyMachineIds === null
        ? []
        : onlineMachines.filter(m => joyMachineIds.has(m.id));
    const probing = joyMachineIds === null && onlineMachines.length > 0;
    const withoutJoyCount = joyMachineIds === null
        ? 0
        : (onlineMachines.length - visibleMachines.length) + offlineMachines.length;
    const activeSessions = sessions.filter(s => s.status !== 'ended');
    // Ended sessions the daemon still remembers (in-memory — clears when the
    // daemon restarts). Chat history survives on the relay regardless.
    const endedSessions = sessions.filter(s => s.status === 'ended');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSessions.machines')}>
                {machines.length === 0 ? (
                    <Item title={t('settingsSessions.noMachine')} showChevron={false} />
                ) : probing ? (
                    <Item title={t('settingsSessions.loading')} showChevron={false} rightElement={<ActivityIndicator />} />
                ) : visibleMachines.length === 0 ? (
                    <Item title="No machines running joy-tmux" showChevron={false} />
                ) : (
                    <>
                        {visibleMachines.map(machine => {
                            const isOnline = isMachineOnline(machine);
                            const isSelected = machine.id === selectedMachineId;
                            const name = machine.metadata?.displayName || machine.metadata?.host || machine.id;
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
                                title={`${withoutJoyCount} machine${withoutJoyCount === 1 ? '' : 's'} without joy-tmux hidden`}
                                showChevron={false}
                            />
                        )}
                    </>
                )}
            </ItemGroup>

            {selectedMachineId && (
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
                        activeSessions.map(session => (
                            <Item
                                key={session.id}
                                title={session.cwd.split('/').pop() ?? session.cwd}
                                subtitle={`${statusLabel(session.status)} · ${session.cwd}`}
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
            )}

            {selectedMachineId && daemonStatus?.ok && (
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

            {selectedMachineId && endedSessions.length > 0 && (
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
        </ItemList>
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
