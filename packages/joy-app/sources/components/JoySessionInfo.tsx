// Info page for joy-tmux sessions — replaces the stock happy info page for
// sessions with metadata.joy__source === 'joy-tmux' (the route file branches
// here). Built around what a joy session actually is: a tmux window driven
// by the joy-tmux daemon, with a live record fetched over joy-get-session.
// Happy-cli concerns (CLI version warnings, sandbox, worktrees, resume/fork)
// don't apply and don't appear.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { useSessionStatus, formatPathRelativeToHome, getSessionName } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { useHappyAction } from '@/hooks/useHappyAction';
import { sessionDelete, sessionKill } from '@/sync/ops';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { Session } from '@/sync/storageTypes';
import { HappyError } from '@/utils/errors';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';

// Live record from the joy-tmux daemon (snake_case wire shape of
// Session.toJSON()). Relay metadata is static after create; this carries
// what only the daemon knows: claude session id, live status, current model,
// tmux window, pid, launch flags.
type JoySessionRecord = {
    id: string;
    claude_session_id?: string;
    tmux_window?: string;
    cwd?: string;
    pid?: number;
    status?: string;
    current_model?: string;
    effort?: string;
    flags?: string[];
    started_at?: number;
    end_reason?: string;
};

function CopyRow({ title, value, icon, short }: { title: string; value: string; icon: React.ReactNode; short?: boolean }) {
    const [copied, setCopied] = React.useState(false);
    const display = short && value.length > 20
        ? `${value.substring(0, 8)}...${value.substring(value.length - 8)}`
        : value;
    return (
        <Item
            title={title}
            subtitle={display}
            icon={icon}
            showChevron={false}
            rightElement={<Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={18} color={copied ? '#30D158' : '#8E8E93'} />}
            onPress={async () => {
                await Clipboard.setStringAsync(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            }}
        />
    );
}

export const JoySessionInfo = React.memo(({ session }: { session: Session }) => {
    const { theme } = useUnistyles();
    const router = useRouter();
    const sessionStatus = useSessionStatus(session);
    const sessionName = getSessionName(session);
    const machineId = session.metadata?.machineId;
    const joySessionId = session.metadata?.joy__sessionId;
    const {
        canRestart,
        restartSession,
        restarting,
        archiveSession,
        archivingSession,
    } = useSessionQuickActions(session);

    const [live, setLive] = React.useState<JoySessionRecord | null>(null);
    const [liveFailed, setLiveFailed] = React.useState(false);
    React.useEffect(() => {
        if (!joySessionId || !machineId) {
            setLiveFailed(true);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const result = await Promise.race([
                    apiSocket.machineRPC<JoySessionRecord & { error?: string }, { id: string }>(
                        machineId, 'joy-get-session', { id: joySessionId }),
                    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
                ]);
                if (cancelled) return;
                if (result.error) setLiveFailed(true);
                else setLive(result);
            } catch {
                if (!cancelled) setLiveFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, [joySessionId, machineId]);

    const [deletingSession, performDelete] = useHappyAction(async () => {
        router.back();
        router.back();
        if (sessionStatus.isConnected || session.active) {
            await sessionKill(session.id).catch(() => { });
        }
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || 'Failed to delete session', false);
        }
    });

    const handleDelete = React.useCallback(() => {
        Modal.alert('Delete session', 'This permanently deletes the chat history on the relay. The tmux window is killed if still running.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: performDelete },
        ]);
    }, [performDelete]);

    const formatDate = (ts: number) => new Date(ts).toLocaleString();
    const statusColor = live?.status === 'active' ? '#34C759'
        : live?.status === 'starting' ? '#FFCC00'
        : live?.status === 'ended' ? '#8E8E93'
        : sessionStatus.statusDotColor;

    return (
        <ItemList>
            {/* Header — terminal-flavored, no avatar theater */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{
                    backgroundColor: theme.colors.surface,
                    marginHorizontal: 16,
                    marginTop: 16,
                    marginBottom: 8,
                    borderRadius: 12,
                    paddingVertical: 20,
                    alignItems: 'center',
                    gap: 6,
                }}>
                    <Text style={{ fontSize: 24, color: theme.colors.text, ...Typography.mono('semiBold') }}>
                        {'>_'} {sessionName}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor }} />
                        <Text style={{ fontSize: 14, color: theme.colors.textSecondary, ...Typography.mono() }}>
                            {live?.status ?? sessionStatus.statusText}
                            {live?.end_reason ? ` (${live.end_reason})` : ''}
                        </Text>
                    </View>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary, ...Typography.mono() }}>
                        joy-tmux session
                    </Text>
                </View>
            </View>

            {/* Live daemon record */}
            <ItemGroup
                title="Live"
                footer={liveFailed ? 'No live record — the daemon is unreachable or no longer tracks this session. Showing relay metadata only.' : undefined}
            >
                {live?.current_model && (
                    <Item title="Model" detail={live.current_model} icon={<Ionicons name="sparkles-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {live?.effort && (
                    <Item title="Effort" detail={live.effort} icon={<Ionicons name="speedometer-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {live?.tmux_window && (
                    <Item title="tmux Window" detail={live.tmux_window} icon={<Ionicons name="terminal-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {live?.pid != null && (
                    <Item title="PID" detail={String(live.pid)} icon={<Ionicons name="hardware-chip-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
                {!!live?.flags?.length && (
                    <Item title="Launch Flags" subtitle={live.flags.join(' ')} icon={<Ionicons name="options-outline" size={29} color="#FF2D55" />} showChevron={false} />
                )}
            </ItemGroup>

            {/* Actions */}
            <ItemGroup title="Actions">
                {machineId && joySessionId && (
                    <Item
                        title="Open Terminal"
                        subtitle="Live tmux pane with raw key input"
                        icon={<Ionicons name="open-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push(`/joy/pane/${machineId}/${joySessionId}`)}
                    />
                )}
                {canRestart && (
                    <Item
                        title="Restart Session"
                        subtitle="Kill the tmux window, resume this conversation in a fresh one"
                        icon={<Ionicons name="refresh-outline" size={29} color="#007AFF" />}
                        onPress={restartSession}
                        loading={restarting}
                    />
                )}
                <Item
                    title="Usage & Cost"
                    subtitle="Cost for this conversation, computed on the machine"
                    icon={<Ionicons name="flame-outline" size={29} color="#FF6B35" />}
                    onPress={() => router.push(`/session/${session.id}/usage`)}
                />
                {machineId && (
                    <Item
                        title="View Machine"
                        subtitle="Daemon status and other sessions on this machine"
                        icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push(`/machine/${machineId}`)}
                    />
                )}
                <Item
                    title="Kill & Archive"
                    subtitle="End the tmux window and archive this chat"
                    icon={<Ionicons name="archive-outline" size={29} color="#FF3B30" />}
                    onPress={archiveSession}
                    loading={archivingSession}
                />
                <Item
                    title="Delete Session"
                    subtitle="Kill and permanently delete the chat history"
                    icon={<Ionicons name="trash-outline" size={29} color="#FF3B30" />}
                    onPress={handleDelete}
                    loading={deletingSession}
                />
            </ItemGroup>

            {/* IDs */}
            <ItemGroup title="IDs">
                {joySessionId && (
                    <CopyRow
                        title="joy Session ID"
                        value={joySessionId}
                        icon={<Ionicons name="pricetag-outline" size={29} color="#FF2D55" />}
                    />
                )}
                {(live?.claude_session_id || session.metadata?.claudeSessionId) && (
                    <CopyRow
                        title="Claude Session ID"
                        value={(live?.claude_session_id ?? session.metadata?.claudeSessionId)!}
                        icon={<Ionicons name="code-outline" size={29} color="#9C27B0" />}
                        short
                    />
                )}
                <CopyRow
                    title="Relay Session ID"
                    value={session.id}
                    icon={<Ionicons name="finger-print-outline" size={29} color="#007AFF" />}
                    short
                />
            </ItemGroup>

            {/* Details */}
            <ItemGroup title="Details">
                {session.metadata?.host && (
                    <Item title="Host" subtitle={session.metadata.host} icon={<Ionicons name="desktop-outline" size={29} color="#5856D6" />} showChevron={false} />
                )}
                <Item
                    title="Path"
                    subtitle={formatPathRelativeToHome(live?.cwd ?? session.metadata?.path ?? '', session.metadata?.homeDir)}
                    icon={<Ionicons name="folder-outline" size={29} color="#5856D6" />}
                    showChevron={false}
                />
                <Item
                    title="Created"
                    subtitle={formatDate(live?.started_at ?? session.createdAt)}
                    icon={<Ionicons name="calendar-outline" size={29} color="#5856D6" />}
                    showChevron={false}
                />
                <Item
                    title="Last Updated"
                    subtitle={formatDate(session.updatedAt)}
                    icon={<Ionicons name="time-outline" size={29} color="#5856D6" />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
