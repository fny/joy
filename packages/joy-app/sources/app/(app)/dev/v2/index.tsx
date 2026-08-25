// Dev screen (no i18n): Relay v2 Mode home — every session driven purely by
// the native /joy/v2 surface, no happy socket involved. See sync/v2/api.ts.
import * as React from 'react';
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { ItemList } from '@/components/ItemList';
import { ItemGroup } from '@/components/ItemGroup';
import { Item } from '@/components/Item';
import { Modal } from '@/modal';
import { useAuth } from '@/auth/AuthContext';
import { getV2BaseUrl, setV2BaseUrl, isV2UrlOverridden, v2, V2ApiError } from '@/sync/v2/api';
import { useV2Sessions } from '@/sync/v2/useV2';

export default React.memo(function V2ModeScreen() {
    const router = useRouter();
    const { isAuthenticated } = useAuth();
    const { sessions, error, refresh } = useV2Sessions();
    const [, bump] = React.useReducer(x => x + 1, 0);

    const editBaseUrl = async () => {
        const url = await Modal.prompt('v2 base URL', 'Relay origin running the v2 server (empty = main server URL)', {
            defaultValue: getV2BaseUrl(), placeholder: 'http://127.0.0.1:3105',
        });
        if (url !== null) {
            setV2BaseUrl(url);
            bump();
            void refresh();
        }
    };

    const createSession = async () => {
        const machineId = await Modal.prompt('Create v2 session', 'Machine id (must have held a lease under this account)');
        if (!machineId) return;
        try {
            const r = await v2.createSession(machineId.trim());
            Modal.alert('Created', `session ${r.sessionId} (${r.state ?? 'queued for spawn'})`);
            void refresh();
        } catch (e) {
            Modal.alert('Create failed', e instanceof V2ApiError ? `${e.status} ${e.code}` : String(e));
        }
    };

    return (
        <ItemList>
            <ItemGroup title="Mode" footer="Everything on this screen tree speaks the native /joy/v2 surface directly — sessions, messages with delivery states, events, SSE, attachments. The happy socket is not involved.">
                <Item title="v2 base URL" subtitle={getV2BaseUrl() + (isV2UrlOverridden() ? ' (override)' : ' (main server URL)')} onPress={editBaseUrl} />
                <Item title="Auth" detail={isAuthenticated ? 'bearer token present' : 'NOT LOGGED IN'} />
                {error ? <Item title="Last error" subtitle={error} titleStyle={styles.errorText as any} /> : null}
            </ItemGroup>
            <ItemGroup title={`Sessions${sessions ? ` (${sessions.length})` : ''}`}>
                {sessions === null ? (
                    <Item title="Loading…" />
                ) : sessions.length === 0 ? (
                    <Item title="No v2 sessions" subtitle="Create one below, or run a daemon lane against this relay" />
                ) : (
                    sessions.map(s => (
                        <Item
                            key={s.sessionId}
                            title={`${s.sessionId.slice(0, 8)} · ${s.state}`}
                            subtitle={`machine ${s.daemonId} · head ${s.headSeq} · ${s.queuedTurns} queued`}
                            onPress={() => router.push(`/dev/v2/${s.sessionId}` as any)}
                        />
                    ))
                )}
                <Item title="＋ Create session (spawn)" onPress={createSession} />
                <Item title="Refresh" onPress={() => void refresh()} />
            </ItemGroup>
            <View style={styles.footerPad} />
        </ItemList>
    );
});

const styles = StyleSheet.create(() => ({
    errorText: { color: '#c0392b' },
    footerPad: { height: 32 },
}));
const _unusedText = Text; // keep RN Text import stable for future inline use
