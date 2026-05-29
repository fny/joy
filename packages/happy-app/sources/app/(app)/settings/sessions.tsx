import * as React from 'react';
import { Pressable, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSettingMutable } from '@/sync/storage';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useJoyTmuxSessions, type JoySession } from '@/hooks/useJoyTmuxSessions';
import { StyleSheet } from 'react-native-unistyles';

const DEFAULT_SERVER_URL = 'http://localhost:4997';

export default React.memo(function JoySessionsScreen() {
    const [serverUrl, setServerUrl] = useSettingMutable('joy__tmuxServerUrl');
    const url = (serverUrl as string | null) ?? DEFAULT_SERVER_URL;
    const { sessions, loading, error, createSession, killSession } = useJoyTmuxSessions(url);

    // Ref holds the target id so the stable kill callback can read it synchronously.
    const killingIdRef = React.useRef<string | null>(null);

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
                                <Pressable
                                    onPress={() => handleKill(session)}
                                    style={styles.trashButton}
                                    hitSlop={8}
                                >
                                    <Ionicons name="trash-outline" size={20} color="#FF3B30" />
                                </Pressable>
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

function statusLabel(status: JoySession['status']): string {
    if (status === 'starting') return t('settingsSessions.statusStarting');
    if (status === 'active') return t('settingsSessions.statusActive');
    return t('settingsSessions.statusEnded');
}

const styles = StyleSheet.create({
    trashButton: {
        padding: 8,
    },
});
