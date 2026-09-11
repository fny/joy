import React, { useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { sessionAllow, sessionDeny } from '@/sync/ops';
import { useUnistyles } from 'react-native-unistyles';
import { storage } from '@/sync/storage';
import { t } from '@/text';
import { IDLE, canAct, nextFooterState, submittingAnswer, type AnswerKind, type FooterState } from './permissionFooterState';

interface PermissionFooterProps {
    permission: {
        id: string;
        status: "pending" | "approved" | "denied" | "canceled";
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
    sessionId: string;
    toolName: string;
    toolInput?: any;
    metadata?: any;
}

export const PermissionFooter: React.FC<PermissionFooterProps> = ({ permission, sessionId, toolName, toolInput, metadata }) => {
    const { theme } = useUnistyles();
    // One submission at a time (permissionFooterState.ts): idle, or one
    // answer in flight. Replaces four booleans and the five-clause guard each
    // handler repeated.
    const [footer, setFooter] = useState<FooterState>(IDLE);
    const submitting = submittingAnswer(footer);
    /** Run one answer: refused presses (already submitting, request no longer
     *  pending) are dropped; the state settles when the daemon has answered —
     *  applied or refused (#381: an empty-body 500 is a refusal, and the
     *  request stays pending for another press). */
    const answer = async (kind: AnswerKind, run: () => Promise<void>, label: string) => {
        if (!canAct(footer, permission)) return;
        setFooter((s) => nextFooterState(s, { type: 'press', answer: kind }));
        try {
            await run();
        } catch (error) {
            console.error(`Failed to ${label}:`, error);
        } finally {
            setFooter((s) => nextFooterState(s, { type: 'settled' }));
        }
    };
    
    // Check if this is a Codex session - check both metadata.flavor and tool name prefix
    const isCodex = metadata?.flavor === 'codex' || toolName.startsWith('Codex');

    const handleApprove = () => answer('allow', () => sessionAllow(sessionId, permission.id), 'approve permission');

    const handleApproveAllEdits = () => answer('all_edits', async () => {
        await sessionAllow(sessionId, permission.id, 'acceptEdits');
        // Update the session permission mode to 'acceptEdits' for future permissions
        storage.getState().updateSessionPermissionMode(sessionId, 'acceptEdits');
    }, 'approve all edits');

    const handleBypassPermissions = () => answer('bypass', async () => {
        await sessionAllow(sessionId, permission.id, 'bypassPermissions');
        storage.getState().updateSessionPermissionMode(sessionId, 'bypassPermissions');
    }, 'bypass permissions');

    const handleApproveForSession = () => {
        if (!toolName) return;
        return answer('for_session', () => {
            // Special handling for Bash tool - include exact command
            let toolIdentifier = toolName;
            if (toolName === 'Bash' && toolInput?.command) {
                const command = toolInput.command;
                toolIdentifier = `Bash(${command})`;
            }
            return sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
        }, 'approve for session');
    };

    const handleDeny = () => answer('deny', () => sessionDeny(sessionId, permission.id), 'deny permission');
    
    // Codex-specific handlers
    const handleCodexApprove = () => answer('allow', () => sessionAllow(sessionId, permission.id, undefined, undefined, 'approved'), 'approve permission');
    
    const handleCodexApproveForSession = () => answer('for_session', () => sessionAllow(sessionId, permission.id, undefined, undefined, 'approved_for_session'), 'approve for session');
    
    const handleCodexAbort = () => answer('abort', () => sessionDeny(sessionId, permission.id, undefined, undefined, 'abort'), 'abort permission');

    const isApproved = permission.status === 'approved';
    const isDenied = permission.status === 'denied';
    const isPending = permission.status === 'pending';

    // Helper function to check if tool matches allowed pattern
    const isToolAllowed = (toolName: string, toolInput: any, allowedTools: string[] | undefined): boolean => {
        if (!allowedTools) return false;
        
        // Direct match for non-Bash tools
        if (allowedTools.includes(toolName)) return true;
        
        // For Bash, check exact command match
        if (toolName === 'Bash' && toolInput?.command) {
            const command = toolInput.command;
            return allowedTools.includes(`Bash(${command})`);
        }
        
        return false;
    };

    // Detect which button was used based on mode (for Claude) or decision (for Codex)
    const isApprovedViaAllow = isApproved && permission.mode !== 'acceptEdits' && permission.mode !== 'bypassPermissions' && !isToolAllowed(toolName, toolInput, permission.allowedTools);
    const isApprovedViaAllEdits = isApproved && permission.mode === 'acceptEdits';
    const isApprovedViaBypass = isApproved && permission.mode === 'bypassPermissions';
    const isApprovedForSession = isApproved && isToolAllowed(toolName, toolInput, permission.allowedTools);
    
    // Codex-specific status detection with fallback
    const isCodexApproved = isCodex && isApproved && (permission.decision === 'approved' || !permission.decision);
    const isCodexApprovedForSession = isCodex && isApproved && permission.decision === 'approved_for_session';
    const isCodexAborted = isCodex && isDenied && permission.decision === 'abort';

    const styles = StyleSheet.create({
        container: {
            paddingHorizontal: 4,
            paddingTop: 2,
            paddingBottom: 6,
            justifyContent: 'center',
        },
        buttonContainer: {
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
        },
        button: {
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: 6,
            backgroundColor: 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 28,
            maxWidth: '100%',
            borderWidth: 1,
            borderColor: theme.colors.textSecondary,
            flexShrink: 1,
            opacity: 0.62,
        },
        buttonAllow: {
            borderColor: theme.colors.textSecondary,
        },
        buttonDeny: {
            borderColor: theme.colors.textSecondary,
        },
        buttonAllowAll: {
            borderColor: theme.colors.textSecondary,
        },
        buttonSelected: {
            backgroundColor: 'transparent',
            borderColor: theme.colors.textSecondary,
            opacity: 1,
        },
        buttonInactive: {
            opacity: 0.62,
        },
        buttonContent: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 16,
            minWidth: 0,
        },
        icon: {
            marginRight: 2,
        },
        buttonText: {
            fontSize: 13,
            fontWeight: '400',
            color: theme.colors.text,
        },
        buttonTextAllow: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextDeny: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextAllowAll: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonTextSelected: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        buttonForSession: {
            borderColor: theme.colors.textSecondary,
        },
        buttonTextForSession: {
            color: theme.colors.text,
            fontWeight: '500',
        },
        loadingIndicatorAllow: {
            color: theme.colors.text,
        },
        loadingIndicatorDeny: {
            color: theme.colors.text,
        },
        loadingIndicatorAllowAll: {
            color: theme.colors.text,
        },
        loadingIndicatorForSession: {
            color: theme.colors.text,
        },
        iconApproved: {
            color: theme.colors.text,
        },
        iconDenied: {
            color: theme.colors.text,
        },
    });

    // Render Codex buttons if this is a Codex session
    if (isCodex) {
        return (
            <View style={styles.container}>
                <View style={styles.buttonContainer}>
                    {/* Codex: Yes button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllow,
                            isCodexApproved && styles.buttonSelected,
                            (isCodexAborted || isCodexApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleCodexApprove}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'allow' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllow.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllow,
                                    isCodexApproved && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('common.yes')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Codex: Yes, and don't ask for a session button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isCodexApprovedForSession && styles.buttonSelected,
                            (isCodexAborted || isCodexApproved) && styles.buttonInactive
                        ]}
                        onPress={handleCodexApproveForSession}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'for_session' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isCodexApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('codex.permissions.yesForSession')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* Codex: Stop, and explain what to do button */}
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonDeny,
                            isCodexAborted && styles.buttonSelected,
                            (isCodexApproved || isCodexApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleCodexAbort}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'abort' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorDeny.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextDeny,
                                    isCodexAborted && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('codex.permissions.stopAndExplain')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    // Render Claude buttons (existing behavior)
    return (
        <View style={styles.container}>
            <View style={styles.buttonContainer}>
                <TouchableOpacity
                    style={[
                        styles.button,
                        isPending && styles.buttonAllow,
                        isApprovedViaAllow && styles.buttonSelected,
                        (isDenied || isApprovedViaAllEdits || isApprovedViaBypass || isApprovedForSession) && styles.buttonInactive
                    ]}
                    onPress={handleApprove}
                    disabled={!canAct(footer, permission)}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {submitting === 'allow' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllow.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextAllow,
                                isApprovedViaAllow && styles.buttonTextSelected
                            ]} numberOfLines={1} ellipsizeMode="tail">
                                {t('common.yes')}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>

                {/* Allow All Edits button - only show for Edit and MultiEdit tools */}
                {(toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write' || toolName === 'NotebookEdit' || toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonAllowAll,
                            isApprovedViaAllEdits && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaBypass || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleApproveAllEdits}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'all_edits' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorAllowAll.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextAllowAll,
                                    isApprovedViaAllEdits && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesAllowAllEdits')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Bypass all permissions (yolo mode) - only show for ExitPlanMode */}
                {(toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode') && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedViaBypass && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedForSession) && styles.buttonInactive
                        ]}
                        onPress={handleBypassPermissions}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'bypass' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isApprovedViaBypass && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesAllowEverything')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                {/* Allow for session button - only show for non-edit, non-exit-plan tools */}
                {toolName && toolName !== 'Edit' && toolName !== 'MultiEdit' && toolName !== 'Write' && toolName !== 'NotebookEdit' && toolName !== 'exit_plan_mode' && toolName !== 'ExitPlanMode' && (
                    <TouchableOpacity
                        style={[
                            styles.button,
                            isPending && styles.buttonForSession,
                            isApprovedForSession && styles.buttonSelected,
                            (isDenied || isApprovedViaAllow || isApprovedViaAllEdits || isApprovedViaBypass) && styles.buttonInactive
                        ]}
                        onPress={handleApproveForSession}
                        disabled={!canAct(footer, permission)}
                        activeOpacity={isPending ? 0.7 : 1}
                    >
                        {submitting === 'for_session' && isPending ? (
                            <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                                <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorForSession.color} />
                            </View>
                        ) : (
                            <View style={styles.buttonContent}>
                                <Text style={[
                                    styles.buttonText,
                                    isPending && styles.buttonTextForSession,
                                    isApprovedForSession && styles.buttonTextSelected
                                ]} numberOfLines={1} ellipsizeMode="tail">
                                    {t('claude.permissions.yesForTool')}
                                </Text>
                            </View>
                        )}
                    </TouchableOpacity>
                )}

                <TouchableOpacity
                    style={[
                        styles.button,
                        isPending && styles.buttonDeny,
                        isDenied && styles.buttonSelected,
                        (isApproved) && styles.buttonInactive
                    ]}
                    onPress={handleDeny}
                    disabled={!canAct(footer, permission)}
                    activeOpacity={isPending ? 0.7 : 1}
                >
                    {submitting === 'deny' && isPending ? (
                        <View style={[styles.buttonContent, { width: 40, height: 20, justifyContent: 'center' }]}>
                            <ActivityIndicator size={Platform.OS === 'ios' ? "small" : 14 as any} color={styles.loadingIndicatorDeny.color} />
                        </View>
                    ) : (
                        <View style={styles.buttonContent}>
                            <Text style={[
                                styles.buttonText,
                                isPending && styles.buttonTextDeny,
                                isDenied && styles.buttonTextSelected
                            ]} numberOfLines={1} ellipsizeMode="tail">
                                {t('claude.permissions.noTellClaude')}
                            </Text>
                        </View>
                    )}
                </TouchableOpacity>
            </View>
        </View>
    );
};
