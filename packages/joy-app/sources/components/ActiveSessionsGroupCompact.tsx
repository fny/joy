import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { Text } from '@/components/StyledText';
import { Machine } from '@/sync/storageTypes';
import { SessionRowData } from '@/sync/storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import Octicons from '@expo/vector-icons/Octicons';
import { type SessionState, formatPathRelativeToHome, vibingMessages, formatLastSeen, STATUS_PALETTE } from '@/utils/sessionUtils';
import { Avatar } from './Avatar';
import { Typography } from '@/constants/Typography';
import { StatusDot } from './StatusDot';
import { useAllMachines, useSessionGitStatus } from '@/sync/storage';
import { useSessionAvatarSize } from '@/hooks/useSessionAvatarSize';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { useHappyAction } from '@/hooks/useHappyAction';
import { HappyError } from '@/utils/errors';
import { SessionActionsAnchor, SessionActionsPopover } from './SessionActionsPopover';
import { useSessionActionAlert } from '@/hooks/useSessionQuickActions';
import { sessionKill } from '@/sync/ops';
import { isWorktreePath, getRepoPath, getWorktreeName } from '@/utils/worktree';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { useNewSessionRoute } from '@/hooks/useNewSessionRoute';
import { isTouchWeb } from '@/utils/isTouchWeb';
import { useRouter } from 'expo-router';


interface ActiveSessionsGroupProps {
    sessions: SessionRowData[];
    selectedSessionId?: string;
}

// Column geometry shared by the section header and the session rows beneath it.
// The header sits OUTSIDE projectCard, so its offsets must include that card's
// margin. Derived from: projectCard.marginHorizontal (16) + sessionRow
// .paddingHorizontal (14) + leadingIndicatorSlot (width 16, marginRight 8).
const CARD_MARGIN = 16;
const ROW_PADDING = 14;
const INDICATOR_SLOT = 16;
const INDICATOR_GAP = 8;
/** Center of the status-icon column — the header identicon sits on this line. */
const INDICATOR_CENTER_X = CARD_MARGIN + ROW_PADDING + INDICATOR_SLOT / 2;
/** Left edge of the session TITLE text — the header folder name starts here. */
const TITLE_X = CARD_MARGIN + ROW_PADDING + INDICATOR_SLOT + INDICATOR_GAP;

/**
 * Hook to get git display info for a section header:
 * branch name, line changes, and worktree status.
 */
function useSectionGitInfo(sessionId: string) {
    const gitStatus = useSessionGitStatus(sessionId);

    return React.useMemo(() => {
        if (!gitStatus || gitStatus.lastUpdatedAt === 0) {
            return { branch: null, linesAdded: 0, linesRemoved: 0, hasChanges: false };
        }
        return {
            branch: gitStatus.branch,
            linesAdded: gitStatus.unstagedLinesAdded,
            linesRemoved: gitStatus.unstagedLinesRemoved,
            hasChanges: gitStatus.unstagedLinesAdded > 0 || gitStatus.unstagedLinesRemoved > 0,
        };
    }, [gitStatus]);
}

// Section header: avatar | path + branch + tree icon + line changes | + button
const SectionHeader = React.memo(({ session, displayPath }: { session: SessionRowData; displayPath: string }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const draft = useNewSessionDraft();

    const sessionPath = session.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;
    const repoDisplayPath = isWorktree
        ? formatPathRelativeToHome(repoPath, session.homeDir ?? undefined)
        : displayPath;
    const repoFolderName = repoPath.split(/[/\\]/).filter(Boolean).pop() || repoDisplayPath;
    const worktreeName = isWorktree ? getWorktreeName(sessionPath) : null;

    const gitInfo = useSectionGitInfo(session.id);
    const branchName = worktreeName || gitInfo.branch;
    const hasBranch = !!branchName;

    const newSessionRoute = useNewSessionRoute();
    const handleAdd = React.useCallback(() => {
        const machineId = session.machineId;
        const pathToSet = formatPathRelativeToHome(repoPath, session.homeDir ?? undefined);
        // /joy/new doesn't read the /new draft store — it takes the prefill
        // as route params instead.
        if (newSessionRoute === '/joy/new') {
            router.navigate({
                pathname: '/joy/new',
                params: { ...(machineId ? { machineId } : {}), path: pathToSet },
            });
            return;
        }
        if (machineId) {
            draft.setMachineId(machineId);
        }
        draft.setPath(pathToSet);
        draft.setSessionType(isWorktree ? 'worktree' : 'simple');
        draft.setWorktreeKey(isWorktree ? sessionPath : null);
        router.navigate('/new');
    }, [session.machineId, session.homeDir, repoPath, isWorktree, sessionPath, draft, router, newSessionRoute]);

    const [isHovered, setIsHovered] = React.useState(false);
    // Identicon size — Appearance → Identicons (clamped on read; default 16).
    const avatarSize = useSessionAvatarSize();
    // The identicon sits on the same column as the session rows' status icon:
    // card margin 16 + row padding 14 + half the 16px indicator slot = 38, so
    // both marks share a center line down the list. Text still starts at the
    // session TITLE x (that slot's full 16 + the 8px gap = 54). An oversized
    // identicon widens its slot rather than overlapping the folder name.
    const avatarLeft = Math.max(0, INDICATOR_CENTER_X - avatarSize / 2);
    const avatarSlotWidth = Math.max(avatarSize, TITLE_X - avatarLeft);

    return (
        <View
            style={[
                hasBranch ? styles.sectionHeader : styles.sectionHeaderSingleLine,
                { paddingLeft: avatarLeft },
            ]}
            // @ts-ignore - Web only events
            onMouseEnter={() => setIsHovered(true)}
            // @ts-ignore - Web only events
            onMouseLeave={() => setIsHovered(false)}
        >
            {/* Avatar — centered on the session rows' status-icon column */}
            <View style={[styles.sectionHeaderAvatar, { width: avatarSlotWidth }]}>
                <Avatar id={session.avatarId} size={avatarSize} flavor={null} />
            </View>

            {/* Path + branch */}
            <View style={styles.sectionHeaderContent}>
                <Text style={styles.sectionHeaderPath} numberOfLines={1}>
                    {repoFolderName}
                </Text>
                {hasBranch && (
                    <View style={styles.branchRow}>
                        <Text style={styles.branchText} numberOfLines={1}>
                            {branchName}
                        </Text>
                        {isWorktree && (
                            <Octicons
                                name="file-submodule"
                                size={11}
                                color={theme.colors.textSecondary}
                                style={styles.worktreeIcon}
                            />
                        )}
                        {gitInfo.linesAdded > 0 && (
                            <Text style={styles.addedText}>+{gitInfo.linesAdded}</Text>
                        )}
                        {gitInfo.linesRemoved > 0 && (
                            <Text style={styles.removedText}>-{gitInfo.linesRemoved}</Text>
                        )}
                    </View>
                )}
            </View>

            {/* + button — vertically centered, large hit area; desktop: hover-only */}
            <Pressable
                onPress={handleAdd}
                hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                style={[styles.addButton, { opacity: Platform.OS !== 'web' || isHovered ? 1 : 0 }]}
            >
                <Ionicons name="add-outline" size={14} color={theme.colors.textSecondary} />
            </Pressable>
        </View>
    );
});

// Full-width separator between machine groups: ——— 🖥 name ———
const MachineSeparator = React.memo(({ machineName, machineId, cpu, ram }: { machineName: string; machineId: string; cpu?: number; ram?: number }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();

    const handlePress = React.useCallback(() => {
        router.navigate(`/machine/${machineId}` as any);
    }, [router, machineId]);

    // Live host load (from the daemon's daemonState): a speedometer before CPU%
    // and a chip before RAM%. Plain secondary-text style — matches the machine
    // name, no risk colouring.
    const showCpu = typeof cpu === 'number';
    const showRam = typeof ram === 'number';

    return (
        <Pressable onPress={handlePress} style={styles.machineSeparator} hitSlop={{ top: 8, bottom: 8 }}>
            <View style={styles.machineSeparatorLine} />
            <Ionicons name="desktop-outline" size={11} color={theme.colors.textSecondary} style={{ marginHorizontal: 6 }} />
            <Text style={styles.machineSeparatorText} numberOfLines={1}>
                {machineName}
            </Text>
            {showCpu && (
                <View style={styles.machineLoadItem}>
                    <Ionicons name="speedometer-outline" size={11} color={theme.colors.textSecondary} style={{ marginRight: 3 }} />
                    <Text style={styles.machineLoadText} numberOfLines={1}>{cpu}%</Text>
                </View>
            )}
            {showRam && (
                <View style={styles.machineLoadItem}>
                    <Ionicons name="hardware-chip-outline" size={11} color={theme.colors.textSecondary} style={{ marginRight: 3 }} />
                    <Text style={styles.machineLoadText} numberOfLines={1}>{ram}%</Text>
                </View>
            )}
            <View style={styles.machineSeparatorLine} />
        </Pressable>
    );
});

export function ActiveSessionsGroupCompact({ sessions, selectedSessionId }: ActiveSessionsGroupProps) {
    const styles = stylesheet;
    const machines = useAllMachines();

    const machinesMap = React.useMemo(() => {
        const map: Record<string, Machine> = {};
        machines.forEach(machine => {
            map[machine.id] = machine;
        });
        return map;
    }, [machines]);

    // Group sessions by machine, then by project within each machine
    const { machineGroups } = React.useMemo(() => {
        const unknownText = t('status.unknown');
        const byMachine = new Map<string, {
            machineId: string;
            machineName: string;
            cpu?: number;
            ram?: number;
            projects: Map<string, {
                displayPath: string;
                sessions: SessionRowData[];
            }>;
        }>();

        sessions.forEach(session => {
            const machineId = session.machineId || unknownText;
            const machine = machineId !== unknownText ? machinesMap[machineId] : null;
            const machineName = machine?.metadata?.displayName ||
                machine?.metadata?.host ||
                (machineId !== unknownText ? machineId : `<${unknownText}>`);
            // Live host load from the daemon's encrypted daemonState (cpu/ram %).
            const ds = machine?.daemonState as { cpu?: number; ram?: number } | null | undefined;
            const cpu = typeof ds?.cpu === 'number' ? ds.cpu : undefined;
            const ram = typeof ds?.ram === 'number' ? ds.ram : undefined;

            let machineGroup = byMachine.get(machineId);
            if (!machineGroup) {
                machineGroup = { machineId, machineName, cpu, ram, projects: new Map() };
                byMachine.set(machineId, machineGroup);
            }

            const projectPath = session.path || '';
            let projectGroup = machineGroup.projects.get(projectPath);
            if (!projectGroup) {
                const displayPath = formatPathRelativeToHome(projectPath, session.homeDir ?? undefined);
                projectGroup = { displayPath, sessions: [] };
                machineGroup.projects.set(projectPath, projectGroup);
            }

            projectGroup.sessions.push(session);
        });

        // Sort sessions within each project group
        byMachine.forEach(mg => {
            mg.projects.forEach(pg => {
                pg.sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
            });
        });

        const sorted = Array.from(byMachine.values()).sort((a, b) =>
            a.machineName.localeCompare(b.machineName)
        );

        return { machineGroups: sorted, hasMultipleMachines: byMachine.size > 1 };
    }, [sessions, machinesMap]);

    return (
        <View style={styles.container}>
            {machineGroups.map(machineGroup => {
                const sortedProjects = Array.from(machineGroup.projects.entries()).sort(
                    ([, a], [, b]) => a.displayPath.localeCompare(b.displayPath)
                );

                return (
                    <React.Fragment key={machineGroup.machineId}>
                        {/* joy: always label the machine, even with a single
                            active machine (upstream hid it unless 2+). */}
                        <MachineSeparator
                            machineName={machineGroup.machineName}
                            machineId={machineGroup.machineId}
                            cpu={machineGroup.cpu}
                            ram={machineGroup.ram}
                        />
                        {sortedProjects.map(([projectPath, projectGroup]) => {
                            const firstSession = projectGroup.sessions[0];
                            if (!firstSession) return null;

                            return (
                                <View key={projectPath}>
                                    <SectionHeader
                                        session={firstSession}
                                        displayPath={projectGroup.displayPath}
                                    />
                                    <View style={styles.projectCard}>
                                        {projectGroup.sessions.map((session, index) => (
                                            <CompactSessionRow
                                                key={session.id}
                                                session={session}
                                                selected={selectedSessionId === session.id}
                                                showBorder={index < projectGroup.sessions.length - 1}
                                            />
                                        ))}
                                    </View>
                                </View>
                            );
                        })}
                    </React.Fragment>
                );
            })}
        </View>
    );
}

// Compact session row with status dot indicator
const CompactSessionRow = React.memo(({ session, selected, showBorder }: { session: SessionRowData; selected?: boolean; showBorder?: boolean }) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const baseStatus = STATUS_PALETTE[session.state];
    // Mod 11: use the same green (#34C759) as the rest of the app for unread results,
    // not the iOS blue that overlaps with the `thinking` state.
    const status = session.hasUnread
        ? { ...baseStatus, color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: baseStatus.isConnected }
        : baseStatus;
    const navigateToSession = useNavigateToSession();
    const swipeableRef = React.useRef<Swipeable | null>(null);
    const swipeEnabled = Platform.OS !== 'web';
    const [actionsAnchor, setActionsAnchor] = React.useState<SessionActionsAnchor | null>(null);

    const [archivingSession, performArchive] = useHappyAction(async () => {
        const result = await sessionKill(session.id);
        if (!result.success) {
            throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
        }
    });

    const handleArchive = React.useCallback(() => {
        swipeableRef.current?.close();
        performArchive();
    }, [performArchive]);

    const handlePress = React.useCallback(() => {
        navigateToSession(session.id);
    }, [navigateToSession, session.id]);

    const handleContextMenu = React.useCallback((event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        setActionsAnchor({
            type: 'point',
            x: event.nativeEvent.clientX ?? event.nativeEvent.pageX ?? 0,
            y: event.nativeEvent.clientY ?? event.nativeEvent.pageY ?? 0,
        });
    }, []);

    const showActionAlert = useSessionActionAlert(session.id);
    // Desktop web: right-click anchored menu. Touch web: iOS Safari never
    // fires contextmenu for a touch long-press, so attach onLongPress there
    // too (same action sheet as native). Desktop keeps click-and-hold free
    // for text-y interactions by not attaching it when the pointer is fine.
    const menuProps = Platform.OS === 'web' ? {
        onContextMenu: handleContextMenu,
        ...(isTouchWeb ? { onLongPress: showActionAlert, delayLongPress: 450 } : {}),
    } as any : {
        onLongPress: showActionAlert,
    };

    const renderLeadingIndicator = () => {
        let indicator: React.ReactNode = null;

        if (session.hasUnread) {
            indicator = <StatusDot color={status.dotColor} isPulsing={false} />;
        } else if (session.state === 'waiting' && session.hasDraft) {
            indicator = (
                <Ionicons
                    name="pencil"
                    size={14}
                    color={theme.colors.textSecondary}
                />
            );
        } else if (session.state === 'waiting') {
            indicator = <StatusDot color={theme.colors.textSecondary} isPulsing={false} />;
        } else {
            // Every other state (thinking=blue, tasks=orange, compacting=purple,
            // retrying/permission=orange, detached=red, …) shows its configured
            // STATUS_PALETTE color. Previously only thinking/permission got a dot,
            // so background-task and compaction sessions showed NO indicator.
            indicator = <StatusDot color={status.dotColor} isPulsing={status.isPulsing} />;
        }

        return (
            <View style={styles.leadingIndicatorSlot}>
                {indicator}
            </View>
        );
    };

    const itemContent = (
        <Pressable
            style={[
                styles.sessionRow,
                showBorder && styles.sessionRowWithBorder,
                selected && styles.sessionRowSelected
            ]}
            onPress={handlePress}
            {...menuProps}
        >
            <View style={styles.sessionContent}>
                <View style={styles.sessionTitleRow}>
                    {renderLeadingIndicator()}

                    <Text
                        style={[
                            styles.sessionTitle,
                            status.isConnected ? styles.sessionTitleConnected : styles.sessionTitleDisconnected
                        ]}
                        numberOfLines={2}
                    >
                        {session.name}
                    </Text>
                </View>
            </View>
        </Pressable>
    );

    if (!swipeEnabled) {
        return (
            <>
                {itemContent}
                <SessionActionsPopover
                    anchor={actionsAnchor}
                    onClose={() => setActionsAnchor(null)}
                    sessionId={session.id}
                    visible={!!actionsAnchor}
                />
            </>
        );
    }

    const renderRightActions = () => (
        <Pressable
            style={styles.swipeAction}
            onPress={handleArchive}
            disabled={archivingSession}
        >
            <Ionicons name="archive-outline" size={20} color="#FFFFFF" />
            <Text style={styles.swipeActionText} numberOfLines={2}>
                {t('sessionInfo.archiveSession')}
            </Text>
        </Pressable>
    );

    return (
        <Swipeable
            ref={swipeableRef}
            renderRightActions={renderRightActions}
            overshootRight={false}
            enabled={!archivingSession}
        >
            {itemContent}
        </Swipeable>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 8,
    },
    // Section header styles
    sectionHeader: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        // paddingLeft is set inline (it tracks the identicon size so the mark
        // stays centered on the rows' status-icon column — see SectionHeader).
        paddingRight: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderSingleLine: {
        paddingTop: 12,
        paddingBottom: Platform.select({ ios: 6, default: 8 }),
        // paddingLeft is set inline (it tracks the identicon size so the mark
        // stays centered on the rows' status-icon column — see SectionHeader).
        paddingRight: Platform.select({ ios: 32, default: 24 }),
        flexDirection: 'row',
        alignItems: 'center',
    },
    sectionHeaderAvatar: {
        alignItems: 'flex-start',
        justifyContent: 'center',
    },
    sectionHeaderContent: {
        flex: 1,
        justifyContent: 'center',
        minWidth: 0,
    },
    // Folder name beside the identicon: same color as connected session
    // titles (theme.colors.text, not the dim section-title grey) and bold, so
    // the project reads as the row's anchor.
    sectionHeaderPath: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: Platform.select({ ios: 13, default: 14 }),
        lineHeight: Platform.select({ ios: 18, default: 20 }),
        letterSpacing: Platform.select({ ios: -0.08, default: 0.1 }),
        fontWeight: '700',
        flexShrink: 1,
    },
    branchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginTop: 1,
    },
    branchText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        flexShrink: 1,
    },
    worktreeIcon: {
        marginLeft: 4,
    },
    addedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
        marginLeft: 6,
    },
    removedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
        marginLeft: 3,
    },
    addButton: {
        marginLeft: 4,
        padding: 8,
    },
    // Machine separator styles
    machineSeparator: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: Platform.select({ ios: 32, default: 24 }),
        paddingTop: 8,
        paddingBottom: 0,
    },
    machineSeparatorLine: {
        flex: 1,
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
    },
    machineSeparatorText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
        marginRight: 4,
    },
    machineLoadItem: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 4,
    },
    machineLoadText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default('regular'),
    },
    // Project card styles
    projectCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: 8,
        marginHorizontal: 16,
        borderRadius: 10,
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 0.33 },
        shadowOpacity: theme.colors.shadow.opacity,
        shadowRadius: 0,
        elevation: 1,
    },
    // Session row styles — padding-driven to match the new-session button
    // (paddingVertical 10 / paddingHorizontal 14) instead of a fixed 56px row.
    sessionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 14,
        backgroundColor: theme.colors.surface,
    },
    sessionRowWithBorder: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    sessionRowSelected: {
        backgroundColor: theme.colors.surfaceSelected,
    },
    sessionContent: {
        flex: 1,
        justifyContent: 'center',
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    sessionTitle: {
        fontSize: 15,
        flex: 1,
        ...Typography.default('regular'),
    },
    joyBadge: {
        fontSize: 10,
        opacity: 0.45,
        ...Typography.default(),
    },
    sessionTitleConnected: {
        color: theme.colors.text,
    },
    sessionTitleDisconnected: {
        color: theme.colors.textSecondary,
    },
    leadingIndicatorSlot: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        marginRight: 8,
    },
    swipeAction: {
        width: 112,
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.status.error,
    },
    swipeActionText: {
        marginTop: 4,
        fontSize: 12,
        color: '#FFFFFF',
        textAlign: 'center',
        ...Typography.default('semiBold'),
    },
}));
