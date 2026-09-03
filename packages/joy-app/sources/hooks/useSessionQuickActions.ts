import * as React from 'react';
import { useJoyAction } from '@/hooks/useJoyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { sessionDelete, sessionKill } from '@/sync/ops';
import { useLocalSetting, useMachine } from '@/sync/storage';
import { Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { waitForLocalSession } from '@/sync/v2/spawn';
import { machineRestartSessionFor, machineForkSession } from '@/sync/v2/machine';
import { t } from '@/text';
import { JoyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';

export interface SessionActionItem {
    id: string;
    label: string;
    icon: string;
    onPress: () => void;
    destructive?: boolean;
}

interface UseSessionQuickActionsOptions {
    onAfterArchive?: () => void;
    onAfterDelete?: () => void;
    onAfterCopySessionMetadata?: () => void;
}

export function useSessionQuickActions(
    session: Session,
    options: UseSessionQuickActionsOptions = {},
) {
    const {
        onAfterArchive,
        onAfterDelete,
        onAfterCopySessionMetadata,
    } = options;
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const sessionStatus = useSessionStatus(session);
    const machineId = session.metadata?.machineId ?? '';
    const machine = useMachine(machineId);
    const devModeEnabled = useLocalSetting('devModeEnabled');
    const joySessionId = session.metadata?.joy__sessionId;
    const machineOnline = Boolean(machineId && machine && isMachineOnline(machine));

    // Fork: any claude session with a known conversation id on an online
    // machine. Works on active AND inactive sessions — the daemon launches
    // `claude --resume <id> --fork-session`, no transcript copy needed.
    const claudeSessionId = session.metadata?.claudeSessionId;
    const canFork = Boolean(
        (!session.metadata?.flavor || session.metadata.flavor === 'claude')
        && claudeSessionId
        && machineOnline,
    );

    // Restart: the daemon kills the tmux window and starts a fresh agent in
    // the same cwd resuming the same conversation. This is also how a
    // disconnected session gets resumed.
    const canRestart = Boolean(joySessionId && machineOnline);
    const canResume = canRestart && !sessionStatus.isConnected;

    const openDetails = React.useCallback(() => {
        router.push(`/session/${session.id}/info`);
    }, [router, session.id]);

    const copySessionMetadata = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    const copySessionMetadataAndLogs = React.useCallback(() => {
        void (async () => {
            const copied = await copySessionMetadataAndLogsToClipboard(session);
            if (copied) {
                onAfterCopySessionMetadata?.();
            }
        })();
    }, [onAfterCopySessionMetadata, session]);

    // Archive = end the live agent; the daemon marks the session ended and
    // the relay keeps the record (it lingers in history).
    const [archivingSession, performArchive] = useJoyAction(async () => {
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            throw new JoyError(killResult.message || 'Failed to end session', false);
        }
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    // Permanent hard-delete (vs archive, which just deactivates and lingers in
    // history). Confirms first; ends the live session so the daemon/CLI doesn't
    // re-create the record, then DELETEs it server-side.
    const [deletingSession, performDelete] = useJoyAction(async () => {
        const ok = await Modal.confirm(
            'Delete session?',
            'Permanently deletes this session and its messages. This cannot be undone.',
            { confirmText: 'Delete', destructive: true },
        );
        if (!ok) return;
        await sessionKill(session.id).catch(() => { });
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new JoyError(result.message || 'Failed to delete session', false);
        }
        onAfterDelete?.();
    });

    const deleteSession = React.useCallback(() => {
        performDelete();
    }, [performDelete]);

    // Fork: the daemon's create op with resume_id + forkSession launches
    // `claude --resume <id> --fork-session` — the conversation continues
    // under a NEW session id (works on LIVE sessions too; the daemon's
    // resume-collision guard exempts forks).
    const [forking, performFork] = useJoyAction(async () => {
        if (!canFork || !machineId || !joySessionId) {
            throw new JoyError(t('session.forkErrorMissingMetadata'), false);
        }
        // One tap: the daemon forks from the last message (claude: --resume
        // <id> --fork-session) and we follow the new card as soon as it binds.
        const fctx = sync.machineOnlyCtx(machineId);
        if (!fctx) throw new JoyError('No machine context for this session', false);
        const r = await machineForkSession(fctx, joySessionId);
        if (!r.data?.ok || !r.data.localSessionId) throw new JoyError(r.data?.error || 'Failed to fork session', false);
        const forked = await waitForLocalSession(r.data.localSessionId);
        if (!forked) throw new JoyError('The forked session did not appear within a minute', false);
        navigateToSession(forked);
    });

    // Teleport: continue this conversation on ANOTHER machine, in a folder
    // there. Files are not copied (assume synced); the new-session page hosts
    // the machine + folder pickers and runs the export → import.
    const canTeleport = Boolean(joySessionId && machineOnline && session.metadata?.flavor !== 'codex' && session.metadata?.flavor !== 'opencode' && session.metadata?.flavor !== 'pi' && session.metadata?.flavor !== 'agy');
    const teleportSession = React.useCallback(() => {
        const path = session.metadata?.path ?? '';
        router.push(`/joy/new?teleportFrom=${encodeURIComponent(session.id)}&path=${encodeURIComponent(path)}` as never);
    }, [router, session.id, session.metadata?.path]);

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    // Restart: the daemon kills the tmux window and starts a fresh agent in
    // the same cwd resuming the same conversation.
    const [restarting, performRestart] = useJoyAction(async () => {
        if (!canRestart) {
            throw new JoyError(t('sessionInfo.resumeSessionMachineOffline'), false);
        }
        type RestartResult = { ok?: boolean; relaySessionId?: string; error?: string };
        const rctx = sync.machineOnlyCtx(machineId!);
        if (!rctx) throw new JoyError('No machine context for this session', false);
        const result = await Promise.race([
            machineRestartSessionFor(rctx, joySessionId!, { cwd: session.metadata?.path }).then(r => r.data as unknown as RestartResult),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The daemon did not respond within 30s')), 30000)),
        ]);
        if (!result?.ok) {
            throw new JoyError(result?.error || 'Failed to restart session', false);
        }
        // The restarted session keeps its v2 identity (the window record's
        // binding survives restart), so the card we're on stays correct.
        await sync.refreshSessions();
        navigateToSession(session.id);
    });

    const restartSession = React.useCallback(() => {
        performRestart();
    }, [performRestart]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (canResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: restartSession });
        } else if (canRestart) {
            items.push({ id: 'restart', icon: 'refresh-outline', label: 'Restart session', onPress: restartSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
        }
        if (canTeleport) {
            items.push({ id: 'teleport', icon: 'planet-outline', label: t('session.teleportAction'), onPress: teleportSession });
        }

        if (canCopySessionMetadata) {
            items.push({ id: 'copy-metadata', icon: 'bug-outline', label: t('sessionInfo.copyMetadata'), onPress: copySessionMetadata });
            items.push({ id: 'copy-metadata-and-logs', icon: 'document-text-outline', label: t('sessionInfo.copyMetadata') + ' & Client Logs', onPress: copySessionMetadataAndLogs });
        }

        items.push({ id: 'delete', icon: 'trash-outline', label: 'Delete', onPress: deleteSession, destructive: true });
        items.push({ id: 'archive', icon: 'archive-outline', label: 'Archive', onPress: archiveSession });

        return items;
    }, [
        archiveSession,
        deleteSession,
        canCopySessionMetadata,
        canFork,
        canTeleport,
        canRestart,
        canResume,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        openDetails,
        restartSession,
        teleportSession,
    ]);

    const showActionAlert = React.useCallback(() => {
        const buttons: Array<{ text: string; onPress?: () => void; style?: 'cancel' | 'destructive' | 'default' }> = actionItems.map(item => ({
            text: item.label,
            onPress: item.onPress,
            style: item.destructive ? 'destructive' as const : undefined,
        }));
        buttons.push({ text: t('common.cancel'), style: 'cancel' });
        Modal.alert('Session', undefined, buttons);
    }, [actionItems]);

    return {
        actionItems,
        showActionAlert,
        archiveSession,
        archivingSession,
        deleteSession,
        deletingSession,
        canArchive: true,
        canCopySessionMetadata,
        canResume,
        canFork,
        canRestart,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        teleportSession,
        canTeleport,
        openDetails,
        restartSession,
        restarting,
    };
}

/**
 * Lightweight hook for list items that only have a sessionId.
 * Returns a long-press handler that shows the action alert on mobile.
 */
export function useSessionActionAlert(sessionId: string) {
    const session = useSession(sessionId);
    const { showActionAlert } = useSessionQuickActions(session!, {});
    return session ? showActionAlert : undefined;
}
