import * as React from 'react';
import { useHappyAction } from '@/hooks/useHappyAction';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { machineResumeSession, sessionArchive, sessionDelete, sessionKill, forkAndSpawn, type ForkSource } from '@/sync/ops';
import { maybeCleanupWorktree } from '@/hooks/useWorktreeCleanup';
import { storage, useLocalSetting, useMachine, useSetting } from '@/sync/storage';
import { apiSocket } from '@/sync/apiSocket';
import { Machine, Session } from '@/sync/storageTypes';
import { sync } from '@/sync/sync';
import { resolveMessageModeMeta } from '@/sync/messageMeta';
import { t } from '@/text';
import { HappyError } from '@/utils/errors';
import { copySessionMetadataToClipboard, copySessionMetadataAndLogsToClipboard } from '@/utils/copySessionMetadataToClipboard';
import { useSessionStatus } from '@/utils/sessionUtils';
import { isMachineOnline } from '@/utils/machineUtils';
import { useRouter } from 'expo-router';
import { useSession } from '@/sync/storage';
import { DuplicateSheet } from '@/components/DuplicateSheet';

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

type ResumeAvailability = {
    canResume: boolean;
    canShowResume: boolean;
    subtitle: string;
    message: string;
};

function getResumeAvailability(session: Session, machine: Machine | null | undefined, isConnected: boolean): ResumeAvailability {
    if (isConnected) {
        return {
            canResume: false,
            canShowResume: false,
            subtitle: '',
            message: '',
        };
    }

    const machineId = session.metadata?.machineId;
    if (!machineId) {
        const message = t('sessionInfo.resumeSessionMissingMachine');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    const hasBackendResumeId = Boolean(session.metadata?.claudeSessionId || session.metadata?.codexThreadId);
    if (!hasBackendResumeId) {
        const message = t('sessionInfo.resumeSessionMissingBackendId');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!machine) {
        const message = t('sessionInfo.resumeSessionSameMachineOnly');
        return {
            canResume: false,
            canShowResume: true,
            subtitle: message,
            message,
        };
    }

    if (!isMachineOnline(machine)) {
        return {
            canResume: false,
            canShowResume: true,
            subtitle: t('sessionInfo.resumeSessionMachineOffline'),
            message: t('sessionInfo.resumeSessionMachineOffline'),
        };
    }

    return {
        canResume: true,
        canShowResume: true,
        subtitle: t('sessionInfo.resumeSessionSubtitle'),
        message: t('sessionInfo.resumeSessionSubtitle'),
    };
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
    const expResumeSession = useSetting('expResumeSession');

    // joy-tmux sessions get their own restart flow (below) instead of the
    // happy-cli resume/fork paths, which spawn through the happy daemon and
    // don't exist for joy sessions.
    const isJoy = session.metadata?.joy__source === 'joy-tmux';
    const joySessionId = session.metadata?.joy__sessionId;

    const resumeAvailability = React.useMemo(
        () => (expResumeSession && !isJoy) ? getResumeAvailability(session, machine, sessionStatus.isConnected) : { canResume: false, canShowResume: false, subtitle: '', message: '' },
        [machine, session, sessionStatus.isConnected, expResumeSession, isJoy],
    );

    // Fork eligibility — separate from resume because fork works on both
    // active AND inactive Claude sessions (the on-disk JSONL exists either
    // way; copyFile is atomic). The user-facing toggle is the same
    // expResumeSession experiment so all three flows (resume / fork /
    // duplicate) ride a single switch on settings/features.
    const claudeFlavor = !session.metadata?.flavor || session.metadata.flavor === 'claude';
    const claudeSessionId = session.metadata?.claudeSessionId;
    const canFork = Boolean(
        expResumeSession
        && !isJoy
        && claudeFlavor
        && claudeSessionId
        && machineId
        && machine
        && isMachineOnline(machine),
    );

    const canRestart = Boolean(isJoy && joySessionId && machineId && machine && isMachineOnline(machine));

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

    const [resumingSession, performResume] = useHappyAction(async () => {
        if (!resumeAvailability.canResume) {
            throw new HappyError(resumeAvailability.message, false);
        }

        if (!machineId) {
            throw new HappyError(t('sessionInfo.resumeSessionMissingMachine'), false);
        }

        const modeMeta = resolveMessageModeMeta(session, storage.getState().settings);
        const result = await machineResumeSession({
            machineId,
            sessionId: session.id,
            model: modeMeta.model ?? undefined,
            permissionMode: modeMeta.permissionMode,
        });

        switch (result.type) {
            case 'success': {
                // Session reconnects to the same ID, so messages are preserved.
                // Refresh to pick up the updated session state.
                await sync.refreshSessions();

                if (session.permissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, session.permissionMode);
                }
                if (session.modelMode) {
                    storage.getState().updateSessionModelMode(result.sessionId, session.modelMode);
                }

                navigateToSession(result.sessionId);
                return;
            }
            case 'requestToApproveDirectoryCreation':
                throw new HappyError(t('sessionInfo.resumeSessionUnexpectedDirectoryPrompt'), false);
            case 'error':
                throw new HappyError(result.errorMessage, false);
        }
    });

    const [archivingSession, performArchive] = useHappyAction(async () => {
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);

        // Try to kill the CLI process; if it's already dead, force-archive via server
        const killResult = await sessionKill(session.id);
        if (!killResult.success) {
            await sessionArchive(session.id);
        }
        onAfterArchive?.();
    });

    const archiveSession = React.useCallback(() => {
        performArchive();
    }, [performArchive]);

    // Permanent hard-delete (vs archive, which just deactivates and lingers in
    // history). Confirms first; ends the live session so the daemon/CLI doesn't
    // re-create the record, then DELETEs it server-side.
    const [deletingSession, performDelete] = useHappyAction(async () => {
        const ok = await Modal.confirm(
            'Delete session?',
            'Permanently deletes this session and its messages. This cannot be undone.',
            { confirmText: 'Delete', destructive: true },
        );
        if (!ok) return;
        await maybeCleanupWorktree(session.id, session.metadata?.path, session.metadata?.machineId);
        await sessionKill(session.id).catch(() => { });
        const result = await sessionDelete(session.id);
        if (!result.success) {
            throw new HappyError(result.message || 'Failed to delete session', false);
        }
        onAfterDelete?.();
    });

    const deleteSession = React.useCallback(() => {
        performDelete();
    }, [performDelete]);

    const resumeSession = React.useCallback(() => {
        performResume();
    }, [performResume]);

    // Fork the session (no truncation) — copies the on-disk Claude JSONL
    // and spawns a fresh Happy session on the same machine. Works for
    // both active and inactive sessions; the source row stays untouched.
    const [forking, performFork] = useHappyAction(async () => {
        if (!canFork) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const directory = session.metadata?.path;
        if (!machineId || !directory || !claudeSessionId) {
            throw new HappyError(t('session.forkErrorMissingMetadata'), false);
        }
        const source: ForkSource = { sessionId: session.id, machineId, directory, claudeSessionId };
        const result = await forkAndSpawn(source);
        if (result.type !== 'success') {
            throw new HappyError(result.type === 'error' ? result.errorMessage : t('session.forkErrorGeneric'), false);
        }
        navigateToSession(result.sessionId);
    });

    const forkSession = React.useCallback(() => {
        performFork();
    }, [performFork]);

    // Restart a joy-tmux session: the daemon kills the tmux window and starts
    // a fresh claude in the same cwd resuming the same conversation. A new
    // relay session comes back — navigate there.
    const [restarting, performRestart] = useHappyAction(async () => {
        if (!canRestart) {
            throw new HappyError('joy-tmux machine is offline', false);
        }
        type RestartResult = { ok?: boolean; relaySessionId?: string; error?: string };
        const result = await Promise.race([
            apiSocket.machineRPC<RestartResult, { id: string; cwd?: string }>(machineId, 'joy-restart-session', {
                id: joySessionId!,
                cwd: session.metadata?.path,
            }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond within 30s')), 30000)),
        ]);
        if (!result.ok || !result.relaySessionId) {
            throw new HappyError(result.error || 'Failed to restart session', false);
        }
        await sync.refreshSessions();
        navigateToSession(result.relaySessionId);
    });

    const restartSession = React.useCallback(() => {
        performRestart();
    }, [performRestart]);

    const openDuplicateSheet = React.useCallback(() => {
        if (!canFork) return;
        Modal.show({
            component: DuplicateSheet,
            props: { sessionId: session.id },
        } as any);
    }, [canFork, session.id]);

    const canCopySessionMetadata = __DEV__ || devModeEnabled;

    const actionItems = React.useMemo<SessionActionItem[]>(() => {
        const items: SessionActionItem[] = [
            { id: 'details', icon: 'information-circle-outline', label: t('profile.details'), onPress: openDetails },
        ];

        if (canRestart) {
            items.push({ id: 'restart', icon: 'refresh-outline', label: 'Restart session', onPress: restartSession });
        }

        if (resumeAvailability.canShowResume) {
            items.push({ id: 'resume', icon: 'play-circle-outline', label: t('sessionInfo.resumeSession'), onPress: resumeSession });
        }

        if (canFork) {
            items.push({ id: 'fork', icon: 'git-branch-outline', label: t('session.forkAction'), onPress: forkSession });
            items.push({ id: 'duplicate', icon: 'time-outline', label: t('session.duplicateAction'), onPress: openDuplicateSheet });
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
        canRestart,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        openDetails,
        openDuplicateSheet,
        restartSession,
        resumeAvailability.canShowResume,
        resumeSession,
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
        canResume: resumeAvailability.canResume,
        canShowResume: resumeAvailability.canShowResume,
        canFork,
        canRestart,
        copySessionMetadata,
        copySessionMetadataAndLogs,
        forkSession,
        forking,
        isJoy,
        openDetails,
        openDuplicateSheet,
        restartSession,
        restarting,
        resumeSession,
        resumeSessionSubtitle: resumeAvailability.subtitle,
        resumingSession,
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
