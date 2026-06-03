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
import { useJoyRpcSessions, type JoySession } from '@/hooks/useJoyRpcSessions';
import { useAllMachines, useIsDataReady } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { apiSocket } from '@/sync/apiSocket';
import { StyleSheet } from 'react-native-unistyles';

export default React.memo(function JoySessionsScreen() {
    const isDataReady = useIsDataReady();
    const machines = useAllMachines({ includeOffline: true });
    const onlineMachines = machines.filter(isMachineOnline);
    const offlineMachines = machines.filter(m => !isMachineOnline(m));

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [showOffline, setShowOffline] = React.useState(false);
    const probedRef = React.useRef(false);

    // Probe all online machines in parallel; pick first one with joy-tmux.
    // Uses a 5s timeout per machine so the page doesn't hang.
    React.useEffect(() => {
        if (probedRef.current || onlineMachines.length === 0) return;
        probedRef.current = true;
        let cancelled = false;
        const withTimeout = (promise: Promise<string>) =>
            Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))]);
        (async () => {
            const results = await Promise.allSettled(
                onlineMachines.map(m =>
                    withTimeout(apiSocket.machineRPC(m.id, 'joy-list-sessions', {}).then(() => m.id))
                )
            );
            if (cancelled) return;
            const found = results.find(r => r.status === 'fulfilled');
            if (found?.status === 'fulfilled') setSelectedMachineId(found.value as string);
        })();
        return () => { cancelled = true; };
    }, [onlineMachines.map(m => m.id).join(',')]);

    const handleSelectMachine = React.useCallback((id: string) => {
        probedRef.current = true;
        setSelectedMachineId(id);
    }, []);

    const { sessions, loading, error, createSession, killSession, fetchPane } = useJoyRpcSessions(selectedMachineId);

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

    const visibleMachines = showOffline ? machines : onlineMachines;
    const activeSessions = sessions.filter(s => s.status !== 'ended');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup title={t('settingsSessions.machines')}>
                {!isDataReady ? (
                    <Item title={t('settingsSessions.loading')} showChevron={false} rightElement={<ActivityIndicator />} />
                ) : machines.length === 0 ? (
                    <Item title={t('settingsSessions.noMachine')} showChevron={false} />
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
                        {offlineMachines.length > 0 && (
                            <Item
                                title={showOffline
                                    ? t('settingsSessions.hideOfflineMachines')
                                    : t('settingsSessions.showOfflineMachines', { count: offlineMachines.length })}
                                showChevron={false}
                                onPress={() => setShowOffline(v => !v)}
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
                                            onPress={() => handleScreenshot(session)}
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
