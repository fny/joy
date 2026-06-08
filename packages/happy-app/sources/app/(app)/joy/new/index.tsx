// New joy-tmux session screen — sister of /new but stripped to Claude only,
// no worktrees, defaults to YOLO mode (joy-tmux server now defaults yolo=true).
//
// Differences from /new:
//   - No agent picker (Claude only)
//   - No worktree picker
//   - No permission-mode UI (always yolo)
//   - Spawn goes through machineRPC('joy-create-session', ...) instead of
//     machineSpawnNewSession; the joy-tmux daemon on the selected machine
//     opens a new tmux window running `claude --dangerously-skip-permissions`.
import React from 'react';
import {
    View,
    Text,
    Platform,
    Pressable,
    Modal as RNModal,
    TextInput,
    ScrollView,
    ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Constants from 'expo-constants';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import {
    MultiTextInput,
    MULTI_TEXT_INPUT_LINE_HEIGHT,
    type KeyPressEvent,
    type MultiTextInputHandle,
} from '@/components/MultiTextInput';
import { useHeaderHeight } from '@/utils/responsive';
import { t } from '@/text';
import { useAllMachines, useSessions, useSetting, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { apiSocket } from '@/sync/apiSocket';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { formatPathRelativeToHome, formatLastSeen } from '@/utils/sessionUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getClaudeModelModes,
    getEffortLevelsForModel,
    getDefaultEffortKeyForModel,
    getDefaultModelKey,
    type ModelMode,
    type EffortLevel,
} from '@/components/modelModeOptions';

const COMPOSER_INPUT_VERTICAL_PADDING = Platform.OS === 'web' ? 10 : 8;
const COMPOSER_INPUT_MAX_HEIGHT = Platform.OS === 'web' ? 480 : 240;
const COMPOSER_SEND_BUTTON_SIZE = 32;
const COMPOSER_SEND_BUTTON_MARGIN_BOTTOM = Math.max(
    0,
    Math.round((MULTI_TEXT_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2),
);

function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'unknown';
}

function trimPathInput(path: string | null | undefined): string {
    return path?.trim() ?? '';
}

type JoyCreateResult = { ok: true; relaySessionId?: string; session: { id: string } } | { error: string };

function NewJoyTmuxSessionScreen() {
    const { theme } = useUnistyles();
    const safeArea = useSafeAreaInsets();
    const headerHeight = useHeaderHeight();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const agentInputEnterToSend = useSetting('agentInputEnterToSend');

    const allMachines = useAllMachines({ includeOffline: true });
    const sessions = useSessions();

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(null);
    const [pathInput, setPathInput] = React.useState<string>('~');
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortIndex, setEffortIndex] = React.useState(0);
    // When true, joy-tmux launches `claude --continue …`, resuming the most
    // recent Claude conversation in this cwd instead of starting fresh.
    const [continueLast, setContinueLast] = React.useState(false);
    const [prompt, setPrompt] = React.useState('');
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [machinePickerOpen, setMachinePickerOpen] = React.useState(false);
    const [pathPickerOpen, setPathPickerOpen] = React.useState(false);

    // Probe online machines for a joy-tmux daemon: ping every online machine
    // with `joy-list-sessions` in parallel and pick the first one that
    // responds within 3s. Mirrors the pattern in settings/joy-sessions.
    // Without this, we'd auto-select the first online machine — which usually
    // doesn't run joy-tmux — and the create RPC would hang silently.
    // The per-probe timeout is critical: apiSocket.machineRPC has no built-in
    // timeout, so a machine without joy-tmux installed never resolves; without
    // racing with a timer, Promise.allSettled would wait forever.
    const probedRef = React.useRef(false);
    React.useEffect(() => {
        if (probedRef.current || selectedMachineId) return;
        const online = allMachines.filter(isMachineOnline);
        if (online.length === 0) {
            if (allMachines.length > 0) setSelectedMachineId(allMachines[0].id);
            return;
        }
        probedRef.current = true;
        let cancelled = false;
        const probeOne = async (machineId: string): Promise<string> => {
            const result = await Promise.race([
                apiSocket.machineRPC(machineId, 'joy-list-sessions', {}).then(() => machineId),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
            ]);
            return result;
        };
        (async () => {
            const results = await Promise.allSettled(online.map(m => probeOne(m.id)));
            if (cancelled) return;
            const found = results.find(r => r.status === 'fulfilled');
            setSelectedMachineId(
                found?.status === 'fulfilled' ? (found.value as string) : online[0].id,
            );
        })();
        return () => { cancelled = true; };
    }, [allMachines.map(m => m.id).join(','), selectedMachineId]);

    const selectedMachine = React.useMemo(
        () => allMachines.find(m => m.id === selectedMachineId) ?? null,
        [allMachines, selectedMachineId],
    );
    const selectedHomeDir = selectedMachine?.metadata?.homeDir;
    const isOffline = selectedMachine ? !isMachineOnline(selectedMachine) : false;

    // Sort: online first, then offline
    const machineList = React.useMemo(() => {
        return [...allMachines].sort((a, b) => (isMachineOnline(a) ? 0 : 1) - (isMachineOnline(b) ? 0 : 1));
    }, [allMachines]);

    // Recent paths from existing sessions on the selected machine
    const pathSuggestions = React.useMemo(() => {
        if (!selectedMachineId || !sessions) return [] as string[];
        const paths = new Set<string>();
        for (const s of sessions) {
            if (typeof s === 'string') continue;
            const session = s as Session;
            if (session.metadata?.machineId === selectedMachineId && session.metadata?.path) {
                paths.add(session.metadata.path);
            }
        }
        return Array.from(paths).sort();
    }, [selectedMachineId, sessions]);

    // Claude models / effort levels (this page is Claude-only)
    const modelModes = React.useMemo<ModelMode[]>(() => getClaudeModelModes(), []);
    const currentModel = modelModes[modelIndex] ?? modelModes[0];
    const currentModelKey = currentModel?.key ?? 'default';
    const effortLevels = React.useMemo<EffortLevel[]>(
        () => getEffortLevelsForModel('claude', currentModelKey),
        [currentModelKey],
    );
    const currentEffort = effortLevels[effortIndex] ?? effortLevels[0];

    // Reset effort to a sensible default when model changes
    React.useEffect(() => {
        const defaultEffort = getDefaultEffortKeyForModel('claude', currentModelKey);
        if (defaultEffort && effortLevels.length > 0) {
            const idx = effortLevels.findIndex(e => e.key === defaultEffort);
            setEffortIndex(idx >= 0 ? idx : effortLevels.length - 1);
        } else {
            setEffortIndex(0);
        }
    }, [currentModelKey, effortLevels]);

    const cycleModel = React.useCallback(() => {
        setModelIndex(i => (i + 1) % modelModes.length);
    }, [modelModes.length]);

    const cycleEffort = React.useCallback(() => {
        if (effortLevels.length === 0) return;
        setEffortIndex(i => (i + 1) % effortLevels.length);
    }, [effortLevels.length]);

    const handleCreate = React.useCallback(async () => {
        if (!selectedMachineId || !selectedMachine) {
            Modal.alert(t('common.error'), 'Select a machine');
            return;
        }
        if (!isMachineOnline(selectedMachine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return;
        }
        const cwd = resolveAbsolutePath(trimPathInput(pathInput) || '~', selectedHomeDir);

        setIsSpawning(true);
        try {
            // Race the RPC against a 30s timeout. machineRPC has no built-in
            // timeout — a machine without joy-tmux would hang the spinner
            // forever. 30s is enough for the slowest legitimate spawn (claude
            // CLI startup + first transcript entry) and short enough to surface
            // misconfigurations.
            const result = await Promise.race<JoyCreateResult>([
                apiSocket.machineRPC<JoyCreateResult, {
                    cwd: string;
                    model?: string;
                    effort?: string;
                    continue?: boolean;
                }>(selectedMachineId, 'joy-create-session', {
                    cwd,
                    model: currentModel && currentModel.key !== 'default' ? currentModel.key : undefined,
                    effort: currentEffort && currentEffort.key !== 'default' ? currentEffort.key : undefined,
                    continue: continueLast || undefined,
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('joy-tmux did not respond within 30s — is the daemon running on the selected machine?')), 30000)),
            ]);

            if ('error' in result) {
                Modal.alert(t('common.error'), result.error);
                return;
            }

            if (!result.relaySessionId) {
                // Relay session wasn't created — joy-tmux may be offline. Refresh
                // the session list and back out; the user can pick it up later.
                await sync.refreshSessions();
                Modal.alert(t('common.error'), 'joy-tmux did not return a relay session ID. Check the daemon is connected to the relay.');
                return;
            }

            await sync.refreshSessions();

            // Send the initial prompt if any. joy-tmux's onMessage handler types
            // it into the tmux pane.
            const trimmedPrompt = prompt.trim();
            if (trimmedPrompt) {
                await sync.sendMessage(result.relaySessionId, trimmedPrompt, { source: 'new_session' });
            }

            router.back();
            navigateToSession(result.relaySessionId);
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to start joy-tmux session';
            Modal.alert(t('common.error'), msg);
        } finally {
            setIsSpawning(false);
        }
    }, [selectedMachineId, selectedMachine, selectedHomeDir, pathInput, currentModel, currentEffort, continueLast, prompt, router, navigateToSession]);

    const canSend = !!selectedMachineId && !!selectedMachine && isMachineOnline(selectedMachine) && !isSpawning;

    const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
        if (Platform.OS === 'web' && event.key === 'Enter' && !event.shiftKey && agentInputEnterToSend) {
            if (canSend) {
                void handleCreate();
                return true;
            }
        }
        return false;
    }, [agentInputEnterToSend, canSend, handleCreate]);

    const composerInputRef = React.useRef<MultiTextInputHandle>(null);
    React.useEffect(() => {
        const timeout = setTimeout(() => composerInputRef.current?.focus(), 100);
        return () => clearTimeout(timeout);
    }, []);

    const machineName = selectedMachine ? getMachineName(selectedMachine) : 'Select machine';
    const displayPath = trimPathInput(pathInput)
        ? formatPathRelativeToHome(trimPathInput(pathInput), selectedHomeDir)
        : '~';

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? Constants.statusBarHeight + headerHeight : 0}
            style={styles.container}
        >
            <View style={styles.inner}>
                <View style={{ maxWidth: layout.maxWidth, width: '100%', alignSelf: 'center', paddingHorizontal: 12, gap: 8, paddingTop: 12 }}>

                    {/* Config box */}
                    <View style={styles.configBox}>
                        {/* Machine row */}
                        <Pressable
                            style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                            onPress={() => setMachinePickerOpen(true)}
                        >
                            <Ionicons name="desktop-outline" size={15} color={theme.colors.textSecondary} />
                            <Text style={styles.configLabel} numberOfLines={1}>{machineName}</Text>
                        </Pressable>

                        {isOffline && (
                            <View style={styles.offlineHelp}>
                                <Ionicons name="cloud-offline-outline" size={14} color={theme.colors.status.disconnected} />
                                <View style={{ flex: 1 }}>
                                    <Text style={[styles.offlineHelpTitle, { color: theme.colors.status.disconnected }]}>
                                        {t('newSession.machineOffline')}
                                    </Text>
                                    <Text style={[styles.offlineHelpText, { color: theme.colors.textSecondary }]}>
                                        {t('machine.offlineHelp')}
                                    </Text>
                                </View>
                            </View>
                        )}

                        <View style={{ opacity: isOffline ? 0.4 : 1 }} pointerEvents={isOffline ? 'none' : 'auto'}>
                            {/* Path row */}
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={() => setPathPickerOpen(true)}
                            >
                                <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>{displayPath}</Text>
                            </Pressable>

                            {/* Claude badge + model + effort */}
                            <View style={styles.configRow}>
                                <Ionicons name="terminal-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>claude code</Text>
                                {modelModes.length > 1 && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleModel} style={(p) => [p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                {currentModel?.name ?? 'default'}
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                                {effortLevels.length > 0 && currentEffort && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleEffort} style={(p) => [p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                {currentEffort.name}
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                            </View>

                            {/* Continue last conversation toggle — when on, joy-tmux passes
                                --continue to claude so it resumes the most recent Claude
                                conversation in this cwd instead of starting fresh. */}
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={() => setContinueLast(v => !v)}
                            >
                                <Ionicons
                                    name={continueLast ? 'checkbox' : 'square-outline'}
                                    size={15}
                                    color={continueLast ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                />
                                <Text style={styles.configLabel} numberOfLines={1}>
                                    --continue
                                </Text>
                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary, fontSize: 12 }]} numberOfLines={1}>
                                    {continueLast ? 'resume last claude conversation' : 'start fresh'}
                                </Text>
                            </Pressable>

                            {/* YOLO indicator — not interactive, just a reminder */}
                            <View style={styles.configRow}>
                                <Ionicons name="play-forward" size={15} color="#F87171" />
                                <Text style={[styles.configLabel, { color: '#F87171' }]} numberOfLines={1}>yolo</Text>
                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary, fontSize: 12 }]} numberOfLines={1}>
                                    permission prompts are skipped
                                </Text>
                            </View>
                        </View>
                    </View>

                    {/* Prompt input */}
                    <View style={styles.inputBox}>
                        <View style={styles.inputField}>
                            <View style={{ flex: 1 }}>
                                <MultiTextInput
                                    ref={composerInputRef}
                                    value={prompt}
                                    onChangeText={setPrompt}
                                    placeholder="initial prompt (optional)"
                                    lineHeight={MULTI_TEXT_INPUT_LINE_HEIGHT}
                                    paddingTop={COMPOSER_INPUT_VERTICAL_PADDING}
                                    paddingBottom={COMPOSER_INPUT_VERTICAL_PADDING}
                                    maxHeight={COMPOSER_INPUT_MAX_HEIGHT}
                                    onKeyPress={handleKeyPress}
                                />
                            </View>
                            <Pressable
                                onPress={() => void handleCreate()}
                                disabled={!canSend}
                                style={[
                                    styles.sendButton,
                                    canSend ? styles.sendButtonActive : styles.sendButtonInactive,
                                ]}
                            >
                                {isSpawning ? (
                                    <ActivityIndicator size="small" color={theme.colors.button.primary.tint} />
                                ) : (
                                    <Ionicons name="arrow-up" size={18} color={theme.colors.button.primary.tint} />
                                )}
                            </Pressable>
                        </View>
                    </View>
                </View>
            </View>

            {/* Machine picker modal */}
            <RNModal visible={machinePickerOpen} transparent animationType="fade" onRequestClose={() => setMachinePickerOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setMachinePickerOpen(false)}>
                    <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation?.()}>
                        <Text style={styles.modalTitle}>Machine</Text>
                        <ScrollView style={{ maxHeight: 360 }}>
                            {machineList.length === 0 && (
                                <Text style={styles.modalEmpty}>no machines</Text>
                            )}
                            {machineList.map(m => (
                                <Pressable
                                    key={m.id}
                                    style={(p) => [styles.modalOption, p.pressed && styles.configRowPressed]}
                                    onPress={() => {
                                        setSelectedMachineId(m.id);
                                        setMachinePickerOpen(false);
                                    }}
                                >
                                    <View style={{ flex: 1 }}>
                                        <Text style={styles.modalOptionLabel} numberOfLines={1}>{getMachineName(m)}</Text>
                                        <Text style={styles.modalOptionSubtitle} numberOfLines={1}>
                                            {isMachineOnline(m) ? t('status.online') : t('status.lastSeen', { time: formatLastSeen(m.activeAt, false) })}
                                        </Text>
                                    </View>
                                    {m.id === selectedMachineId && <Ionicons name="checkmark" size={18} color={theme.colors.text} />}
                                </Pressable>
                            ))}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </RNModal>

            {/* Path picker modal */}
            <RNModal visible={pathPickerOpen} transparent animationType="fade" onRequestClose={() => setPathPickerOpen(false)}>
                <Pressable style={styles.modalBackdrop} onPress={() => setPathPickerOpen(false)}>
                    <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation?.()}>
                        <Text style={styles.modalTitle}>Project path</Text>
                        <TextInput
                            value={pathInput}
                            onChangeText={setPathInput}
                            placeholder="~"
                            placeholderTextColor={theme.colors.textSecondary}
                            style={styles.pathTextInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={() => setPathPickerOpen(false)}
                        />
                        <Text style={styles.modalSubLabel}>Recent</Text>
                        <ScrollView style={{ maxHeight: 280 }}>
                            {pathSuggestions.length === 0 && (
                                <Text style={styles.modalEmpty}>no recent paths</Text>
                            )}
                            {pathSuggestions.map(p => (
                                <Pressable
                                    key={p}
                                    style={(pr) => [styles.modalOption, pr.pressed && styles.configRowPressed]}
                                    onPress={() => {
                                        setPathInput(p);
                                        setPathPickerOpen(false);
                                    }}
                                >
                                    <Text style={styles.modalOptionLabel} numberOfLines={1}>
                                        {formatPathRelativeToHome(p, selectedHomeDir)}
                                    </Text>
                                </Pressable>
                            ))}
                        </ScrollView>
                    </Pressable>
                </Pressable>
            </RNModal>
        </KeyboardAvoidingView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.header.background,
    },
    inner: {
        flex: 1,
    },
    configBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        paddingVertical: 4,
        paddingHorizontal: 4,
        overflow: 'hidden',
    },
    configRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    configRowPressed: {
        opacity: 0.6,
    },
    configLabel: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    offlineHelp: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 12,
    },
    offlineHelpTitle: {
        fontSize: 13,
        ...Typography.default('semiBold'),
        marginBottom: 4,
    },
    offlineHelpText: {
        fontSize: 12,
        lineHeight: 18,
        ...Typography.default(),
    },
    inputBox: {
        backgroundColor: theme.colors.input.background,
        borderRadius: Platform.select({ default: 16, android: 20 }),
        overflow: 'hidden',
        paddingVertical: 2,
        paddingHorizontal: 8,
    },
    inputField: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        paddingLeft: 8,
        paddingRight: 4,
        paddingVertical: 4,
        minHeight: 40,
        gap: 8,
    },
    sendButton: {
        width: COMPOSER_SEND_BUTTON_SIZE,
        height: COMPOSER_SEND_BUTTON_SIZE,
        borderRadius: COMPOSER_SEND_BUTTON_SIZE / 2,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
        marginBottom: COMPOSER_SEND_BUTTON_MARGIN_BOTTOM,
    },
    sendButtonActive: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sendButtonInactive: {
        backgroundColor: theme.colors.button.primary.disabled,
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.45)',
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 16,
    },
    modalCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        padding: 16,
        width: '100%',
        maxWidth: 480,
        gap: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
    },
    modalTitle: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    modalSubLabel: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        paddingTop: 4,
        ...Typography.default('semiBold'),
    },
    modalOption: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 8,
        borderRadius: 10,
    },
    modalOptionLabel: {
        fontSize: 15,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    modalOptionSubtitle: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    modalEmpty: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        paddingVertical: 20,
        ...Typography.default(),
    },
    pathTextInput: {
        fontSize: 16,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...Typography.default(),
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
    },
}));

export default React.memo(NewJoyTmuxSessionScreen);
