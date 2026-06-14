// Info page for joy-tmux sessions — replaces the stock happy info page for
// sessions with metadata.joy__source === 'joy-tmux' (the route file branches
// here). Built around what a joy session actually is: a tmux window driven
// by the joy-tmux daemon, with a live record fetched over joy-get-session.
// Happy-cli concerns (CLI version warnings, sandbox, worktrees, resume/fork)
// don't apply and don't appear.
//
// Personal-build dev page — plain strings, no i18n (matches the /joy pages).
import * as React from 'react';
import { View, Text, Animated, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { Avatar } from '@/components/Avatar';
import { useSessionStatus, formatPathRelativeToHome, getSessionName, getSessionAvatarId, getResumeCommand } from '@/utils/sessionUtils';
import { useSessionQuickActions } from '@/hooks/useSessionQuickActions';
import { useHappyAction } from '@/hooks/useHappyAction';
import { sessionDelete, sessionKill } from '@/sync/ops';
import { apiSocket } from '@/sync/apiSocket';
import { Modal } from '@/modal';
import { Session } from '@/sync/storageTypes';
import { HappyError } from '@/utils/errors';
import { useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import type { JoySessionRecord } from '@/joy/types';

// Same animated status dot as the stock info page header.
function StatusDot({ color, isPulsing, size = 8 }: { color: string; isPulsing?: boolean; size?: number }) {
    const pulseAnim = React.useRef(new Animated.Value(1)).current;

    React.useEffect(() => {
        if (isPulsing) {
            Animated.loop(
                Animated.sequence([
                    Animated.timing(pulseAnim, { toValue: 0.3, duration: 1000, useNativeDriver: true }),
                    Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
                ])
            ).start();
        } else {
            pulseAnim.setValue(1);
        }
    }, [isPulsing, pulseAnim]);

    return (
        <Animated.View
            style={{
                width: size,
                height: size,
                borderRadius: size / 2,
                backgroundColor: color,
                opacity: pulseAnim,
                marginRight: 4,
            }}
        />
    );
}

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

    // Download the transcript JSONL via joy-session-log. Web-only: native
    // file saving isn't wired up and this is a debugging affordance.
    const [downloadingLog, performDownloadLog] = useHappyAction(async () => {
        if (!machineId || !joySessionId) throw new HappyError('No machine or joy session id on this session', false);
        if (Platform.OS !== 'web') throw new HappyError('Download is web-only for now', false);
        type LogResult = { ok?: boolean; filename?: string; contentBase64?: string; error?: string };
        const result = await Promise.race([
            apiSocket.machineRPC<LogResult, { id: string }>(machineId, 'joy-session-log', { id: joySessionId }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond')), 60000)),
        ]);
        if (!result.ok || !result.contentBase64) {
            throw new HappyError(result.error || 'Failed to fetch session log', false);
        }
        const bytes = Uint8Array.from(atob(result.contentBase64), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/x-ndjson' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || 'session.jsonl';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    });

    const handleDelete = React.useCallback(() => {
        Modal.alert('Delete session', 'This permanently deletes the chat history on the relay. The tmux window is killed if still running.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: performDelete },
        ]);
    }, [performDelete]);

    const formatDate = (ts: number) => new Date(ts).toLocaleString();

    // Resume command — stock builder when metadata has the claude session
    // id, otherwise assembled from the daemon's live record.
    const claudeSessionId = live?.claude_session_id ?? session.metadata?.claudeSessionId;
    const sessionPath = live?.cwd ?? session.metadata?.path;
    const resumeCommand = getResumeCommand(session)
        ?? (claudeSessionId && sessionPath ? `cd '${sessionPath}' && happy claude --resume ${claudeSessionId}` : null);

    return (
        <ItemList>
            {/* Session Header — same as the stock info page */}
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <View style={{ alignItems: 'center', paddingVertical: 24, backgroundColor: theme.colors.surface, marginBottom: 8, borderRadius: 12, marginHorizontal: 16, marginTop: 16 }}>
                    <Avatar id={getSessionAvatarId(session)} size={80} monochrome={!sessionStatus.isConnected} flavor={session.metadata?.flavor} />
                    <Text style={{
                        fontSize: 20,
                        fontWeight: '600',
                        marginTop: 12,
                        textAlign: 'center',
                        color: theme.colors.text,
                        ...Typography.default('semiBold')
                    }}>
                        {sessionName}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
                        <StatusDot color={sessionStatus.statusDotColor} isPulsing={sessionStatus.isPulsing} size={10} />
                        <Text style={{
                            fontSize: 15,
                            color: sessionStatus.statusColor,
                            fontWeight: '500',
                            ...Typography.default()
                        }}>
                            {sessionStatus.statusText}
                        </Text>
                    </View>
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
                        subtitle="joy-tmux daemon: version, PID, OS"
                        icon={<Ionicons name="server-outline" size={29} color="#007AFF" />}
                        onPress={() => router.push(`/machine/${machineId}`)}
                    />
                )}
                <Item
                    title="Download Session Log"
                    subtitle="The raw transcript .jsonl from the machine"
                    icon={<Ionicons name="download-outline" size={29} color="#007AFF" />}
                    onPress={performDownloadLog}
                    loading={downloadingLog}
                />
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
                {resumeCommand && (
                    <CopyRow
                        title="Resume Command"
                        value={resumeCommand}
                        icon={<Ionicons name="play-circle-outline" size={29} color="#30D158" />}
                    />
                )}
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
