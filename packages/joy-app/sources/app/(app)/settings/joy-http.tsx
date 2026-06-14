import * as React from 'react';
import { Pressable, ActivityIndicator, View, ScrollView, Text } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useJoyTmuxSessions } from '@/hooks/useJoyTmuxSessions';
import type { JoySession } from '@/joy/types';
import { StyleSheet } from 'react-native-unistyles';

const DEFAULT_SERVER_URL = 'http://localhost:4997';

export default React.memo(function JoyHttpScreen() {
    const [serverUrl, setServerUrl] = useSettingMutable('joy__tmuxServerUrl');
    const url = (serverUrl as string | null) ?? DEFAULT_SERVER_URL;
    const { sessions, loading, error, createSession, killSession, fetchPane } = useJoyTmuxSessions(url);

    const killingIdRef = React.useRef<string | null>(null);
    const screenshotIdRef = React.useRef<string | null>(null);

    const handleConfigureUrl = React.useCallback(async () => {
        const value = await Modal.prompt(
            t('settingsSessions.serverUrl'),
            t('settingsSessions.serverUrlFooter'),
            { defaultValue: url, placeholder: DEFAULT_SERVER_URL },
        );
        if (value?.trim()) setServerUrl(value.trim());
    }, [url, setServerUrl]);

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
                    onPress: () => {
                        killingIdRef.current = session.id;
                        doKill();
                    },
                },
            ],
        );
    }, [doKill]);

    const activeSessions = sessions.filter(s => s.status !== 'ended');

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <ItemGroup
                title={t('settingsSessions.serverUrl')}
                footer={t('settingsSessions.serverUrlFooter')}
            >
                <Item
                    title={url}
                    icon={<Ionicons name="server-outline" size={29} color="#8E8E93" />}
                    onPress={handleConfigureUrl}
                />
            </ItemGroup>

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
