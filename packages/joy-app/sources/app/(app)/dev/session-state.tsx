import * as React from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useShallow } from 'zustand/react/shallow';
import * as Clipboard from 'expo-clipboard';
import { storage } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { useSessionStatus, getSessionName } from '@/utils/sessionUtils';
import { Modal } from '@/modal';

// Dev-only inspector: shows what the APP currently holds for each session —
// the raw metadata (presence / thinking / joy__state / joy__tasks / longRunning /
// permission requests / queue) alongside the status the app COMPUTES from it.
// Purpose: tell a render/state bug apart from a propagation bug when a session's
// header disagrees with reality — e.g. a session showing active while the daemon
// is idle. If the fields here are already stale/wrong, it's propagation; if they
// look right but the computed status is wrong, it's a render bug. Dev page — no i18n.

const mono = { fontFamily: 'monospace' as const };

function StatusSwatch({ color }: { color: string }) {
    return <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: color, marginRight: 8 }} />;
}

function SessionStateRow({ session }: { session: Session }) {
    const status = useSessionStatus(session);
    const m = session.metadata;
    const tasks = m?.joy__tasks;
    // The specific stale case we care about: a task batch present but fully done
    // (done >= total). The daemon clears joy__tasks to null when nothing is
    // outstanding, so seeing done>=total here means the clear never arrived.
    const staleTasks = !!tasks && tasks.total > 0 && tasks.done >= tasks.total;
    const perms = session.agentState?.requests ? Object.keys(session.agentState.requests).length : 0;
    const queue = m?.joy__queue?.queue?.length ?? 0;
    const online = session.presence === 'online';
    const lastSeen = typeof session.presence === 'number'
        ? `${Math.round((Date.now() - session.presence) / 1000)}s ago`
        : 'online';

    return (
        <View style={{ paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: '#2a2a2a' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <StatusSwatch color={status.statusColor} />
                <Text style={[mono, { color: '#fff', fontSize: 13, fontWeight: '600' }]} numberOfLines={1}>
                    {session.id.slice(0, 8)}  {status.state}  ·  {status.statusText}
                </Text>
            </View>
            <Text style={[mono, { color: '#aaa', fontSize: 11, marginTop: 3 }]}>
                presence={online ? 'online' : lastSeen}  thinking={String(session.thinking)}  joy__state={m?.joy__state ?? '—'}
            </Text>
            <Text style={[mono, { color: staleTasks ? '#FF9500' : '#aaa', fontSize: 11, marginTop: 1 }]}>
                joy__tasks={tasks ? `${tasks.done}/${tasks.total}${staleTasks ? '  ⚠ DONE-BUT-PRESENT' : ''}` : '—'}
                {'  '}longRunning={m?.joy__longRunning ?? 0}  perms={perms}  queue={queue}
            </Text>
            <Text style={[mono, { color: '#666', fontSize: 10, marginTop: 1 }]} numberOfLines={1}>
                {getSessionName(session)}
            </Text>
        </View>
    );
}

export default function SessionStateScreen() {
    const sessions = storage(useShallow((state) => state.sessions));
    const list = React.useMemo(
        () => Object.values(sessions).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
        [sessions],
    );

    const copyAll = React.useCallback(() => {
        const dump = list.map((s) => ({
            id: s.id,
            thinking: s.thinking,
            presence: s.presence,
            joy__state: s.metadata?.joy__state,
            joy__tasks: s.metadata?.joy__tasks,
            joy__longRunning: s.metadata?.joy__longRunning,
            permissionRequests: s.agentState?.requests ? Object.keys(s.agentState.requests).length : 0,
            queue: s.metadata?.joy__queue?.queue?.length ?? 0,
        }));
        void Clipboard.setStringAsync(JSON.stringify(dump, null, 2));
        Modal.alert('Copied', `${list.length} sessions copied to clipboard`);
    }, [list]);

    return (
        <View style={{ flex: 1, backgroundColor: '#121212' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 12 }}>
                <Text style={[mono, { color: '#fff', fontSize: 13 }]}>{list.length} sessions</Text>
                <Pressable onPress={copyAll} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="copy-outline" size={18} color="#007AFF" />
                    <Text style={{ color: '#007AFF', fontSize: 13, marginLeft: 4 }}>Copy JSON</Text>
                </Pressable>
            </View>
            <ScrollView>
                {list.map((s) => <SessionStateRow key={s.id} session={s} />)}
                {list.length === 0 && (
                    <Text style={[mono, { color: '#666', fontSize: 12, padding: 12 }]}>no sessions in store</Text>
                )}
            </ScrollView>
        </View>
    );
}
