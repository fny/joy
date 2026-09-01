// New joy-tmux session screen — sister of /new but stripped to Claude only,
// no worktrees, yolo by default.
//
// Differences from /new:
//   - No agent picker (Claude only)
//   - No worktree picker
//   - Full claude CLI surface: permission mode, fallback model, continue,
//     fork, plus a free-form extra-arguments string
//   - Spawn is v2-only: v2.createSession() puts a durable spawn command on the
//     relay queue and the daemon's nucleus lane launches the agent. There is no
//     v1 RPC fallback — a broken spawn must surface, not silently reroute.
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
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Typography } from '@/constants/Typography';
import { layout } from '@/components/layout';
import {
    MultiTextInput,
    MULTI_TEXT_INPUT_FONT_SIZE,
    MULTI_TEXT_INPUT_LINE_HEIGHT,
    type KeyPressEvent,
    type MultiTextInputHandle,
} from '@/components/MultiTextInput';
import { useChatFontScale } from '@/hooks/useChatFontScale';
import { t } from '@/text';
import { useAllMachines, useSessions, useSetting, useSettingMutable, storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { machineStatusOnly, machineHarnessModels, machineHistoryLogs, machineOpencodeSessions } from '@/sync/v2/machine';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { formatPathRelativeToHome, formatLastSeen } from '@/utils/sessionUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { v2SpawnAndWait } from '@/sync/v2/spawn';
import type { Machine, Session } from '@/sync/storageTypes';
import {
    getEffortLevelsForModel,
    getDefaultEffortKeyForModel,
    type ModelMode,
    type EffortLevel,
} from '@/components/modelModeOptions';
import { JOY_CLAUDE_MODELS, JOY_CLAUDE_PERMISSION_MODES, JOY_CODEX_PERMISSION_MODES } from '@/sync/joyModels';

const COMPOSER_INPUT_VERTICAL_PADDING = Platform.OS === 'web' ? 10 : 8;
const COMPOSER_INPUT_MAX_HEIGHT = Platform.OS === 'web' ? 480 : 240;
const COMPOSER_SEND_BUTTON_SIZE = 32;
const COMPOSER_SEND_BUTTON_MARGIN_BOTTOM = Math.max(
    0,
    Math.round((MULTI_TEXT_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2),
);

// Chat-font-scaled composer metrics. The send button hugs the input's LAST
// LINE (alignItems flex-end + a margin that centers it against one line), so
// the margin must be recomputed from the SCALED line height or the button
// drifts off-center when the chat font scale changes.
function scaledComposerMetrics(scale: number) {
    const lineHeight = Math.round(MULTI_TEXT_INPUT_LINE_HEIGHT * scale);
    return {
        fontSize: MULTI_TEXT_INPUT_FONT_SIZE * scale,
        lineHeight,
        maxHeight: Math.round(COMPOSER_INPUT_MAX_HEIGHT * scale),
        sendButtonMarginBottom: Math.max(
            0,
            Math.round((lineHeight + COMPOSER_INPUT_VERTICAL_PADDING * 2 - COMPOSER_SEND_BUTTON_SIZE) / 2),
        ),
    };
}

function getMachineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || 'unknown';
}

function trimPathInput(path: string | null | undefined): string {
    return path?.trim() ?? '';
}

// Git/GitHub URL in the path field → clone-and-spawn. Full URLs only
// (https/git@/ssh) so plain relative paths can't be misread.
const GIT_URL_RE = /^(https?:\/\/\S+|git@\S+:\S+|ssh:\/\/\S+)$/;
function parseGitUrl(input: string): { url: string; repoName: string } | null {
    const v = input.trim();
    if (!GIT_URL_RE.test(v)) return null;
    const tail = v.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
    const repoName = tail.replace(/\.git$/i, '');
    if (!repoName) return null;
    return { url: v, repoName };
}

function NewJoyTmuxSessionScreen() {
    const { theme } = useUnistyles();
    // See scaledComposerMetrics: keeps the send button centered on the
    // input's (scaled) last line.
    const composerMetrics = scaledComposerMetrics(useChatFontScale());
    const safeArea = useSafeAreaInsets();
    const router = useRouter();
    const navigateToSession = useNavigateToSession();
    const agentInputEnterToSend = useSetting('agentInputEnterToSend');

    const allMachines = useAllMachines({ includeOffline: true });
    // Remembered machine+path pairs (most-recent first) — pre-selects the last
    // machine/folder on a fresh new-session page.
    const [recentMachinePaths, setRecentMachinePaths] = useSettingMutable('recentMachinePaths');
    const sessions = useSessions();

    // Optional prefill (e.g. the per-repo "+" in the session list passes the
    // repo's machine + path when this page is the default New session).
    const params = useLocalSearchParams<{ machineId?: string; path?: string; resumeId?: string; mode?: string }>();
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(params.machineId ?? null);
    const [selectedAgent, setSelectedAgent] = React.useState<'claude' | 'codex' | 'opencode' | 'pi'>('claude');
    const [pathInput, setPathInput] = React.useState<string>(params.path || '~/');
    const [modelIndex, setModelIndex] = React.useState(0);
    const [effortIndex, setEffortIndex] = React.useState(0);
    // Permission mode, cycled by tapping the row. Index 0 = yolo
    // (bypassPermissions) — the joy-tmux default, since the app drives the
    // session and answering permission prompts through tmux is fragile.
    const [modeIndex, setModeIndex] = React.useState(0);
    // Fallback model (--fallback-model) — index 0 = none.
    const [fallbackIndex, setFallbackIndex] = React.useState(0);
    // When true, joy-tmux launches `claude --continue …`, resuming the most
    // recent Claude conversation in this cwd instead of starting fresh.
    // Prefilled ON when arriving with a resumeId (fork/continue deep links):
    // resumeId takes precedence at dispatch, but the checked row makes the
    // resume mode VISIBLE instead of implied.
    const [continueLast, setContinueLast] = React.useState(!!params.resumeId);
    // --fork-session: resume the conversation but mint a new session id.
    // Claude only accepts it alongside --continue/--resume, so the row is
    // disabled until continue is on. mode=fork deep link (session info's Fork
    // action) arrives pre-checked.
    const [forkSession, setForkSession] = React.useState(params.mode === 'fork');
    // --resume <id>: resume a specific Claude conversation by session id.
    // Takes precedence over `continue` (which resumes the most recent one).
    const [resumeId, setResumeId] = React.useState(params.resumeId ?? '');
    // How much history (MB) to backfill on --resume. Big transcripts are mostly
    // tool calls; 2 MB ≈ the recent conversation. 0 = full history.
    const [resumeMb, setResumeMb] = React.useState('1');
    // Free-form extra CLI arguments appended verbatim to the claude command.
    const [extraArgs, setExtraArgs] = React.useState('');
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
        // Prefer the last-used machine when it's online; pre-fill its folder too
        // (unless a path was passed in via params).
        const recentId = recentMachinePaths[0]?.machineId;
        const recent = recentId ? allMachines.find(m => m.id === recentId) : undefined;
        if (recent && isMachineOnline(recent)) {
            setSelectedMachineId(recent.id);
            if (!params.path && recentMachinePaths[0]?.path) setPathInput(recentMachinePaths[0].path);
            return;
        }
        const online = allMachines.filter(isMachineOnline);
        if (online.length === 0) {
            if (allMachines.length > 0) setSelectedMachineId(allMachines[0].id);
            return;
        }
        probedRef.current = true;
        let cancelled = false;
        const probeOne = async (machineId: string): Promise<string> => {
            const octx = sync.machineOnlyCtx(machineId);
            if (!octx) throw new Error('no machine context');
            const result = await Promise.race([
                machineStatusOnly(octx).then(() => machineId),
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
    }, [allMachines.map(m => m.id).join(','), selectedMachineId, recentMachinePaths]);

    const selectedMachine = React.useMemo(
        () => allMachines.find(m => m.id === selectedMachineId) ?? null,
        [allMachines, selectedMachineId],
    );
    const selectedHomeDir = selectedMachine?.metadata?.homeDir;
    const isOffline = selectedMachine ? !isMachineOnline(selectedMachine) : false;

    // Once the selected machine's home dir is known, collapse an absolute
    // under-home path (e.g. a deep-link `params.path` or a legacy absolute recent)
    // to the portable tilde form so the field shows "~/…", not "/home/xyz/…".
    React.useEffect(() => {
        if (!selectedHomeDir) return;
        setPathInput(prev => {
            const p = trimPathInput(prev);
            return p.startsWith(selectedHomeDir) ? formatPathRelativeToHome(p, selectedHomeDir) : prev;
        });
    }, [selectedHomeDir]);

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

    // Claude models / effort levels
    const modelModes = React.useMemo<ModelMode[]>(() => JOY_CLAUDE_MODELS, []);
    const currentModel = modelModes[modelIndex] ?? modelModes[0];
    const currentModelKey = currentModel?.key ?? 'default';
    const effortLevels = React.useMemo<EffortLevel[]>(
        () => getEffortLevelsForModel('claude', currentModelKey),
        [currentModelKey],
    );
    const currentEffort = effortLevels[effortIndex] ?? effortLevels[0];

    // Codex model catalog (model/list), fetched from the daemon when codex is
    // selected. Independent index state so switching agents doesn't clobber the
    // claude picker.
    const [codexModels, setCodexModels] = React.useState<{ model: string; displayName: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string | null; isDefault?: boolean }[]>([]);
    const [codexModelIndex, setCodexModelIndex] = React.useState(0);
    const [codexEffortIndex, setCodexEffortIndex] = React.useState(0);
    React.useEffect(() => {
        if (selectedAgent !== 'codex' || !selectedMachineId) return;
        let cancelled = false;
        const cctx = sync.machineOnlyCtx(selectedMachineId);
        if (!cctx) return;
        machineHarnessModels(cctx, 'codex').then(r => ({ ok: r.data?.ok, models: r.data?.models as typeof codexModels | undefined }))
            .then((res) => {
                if (cancelled || !res.models?.length) return;
                setCodexModels(res.models);
                const def = res.models.findIndex((m) => m.isDefault);
                setCodexModelIndex(def >= 0 ? def : 0);
            })
            .catch(() => { /* codex not present / offline — picker stays empty */ });
        return () => { cancelled = true; };
    }, [selectedAgent, selectedMachineId]);
    // Opencode model catalog: static curated allowlist from the daemon
    // (joy-opencode-models — kimi-k3 default + glm-5p2 in v1).
    const [ocModels, setOcModels] = React.useState<{ id: string; providerID: string; displayName: string; isDefault?: boolean }[]>([]);
    const [ocModelIndex, setOcModelIndex] = React.useState(0);
    React.useEffect(() => {
        if (selectedAgent !== 'opencode' || !selectedMachineId) return;
        let cancelled = false;
        const octx2 = sync.machineOnlyCtx(selectedMachineId);
        if (!octx2) return;
        machineHarnessModels(octx2, 'opencode').then(r => ({ ok: r.data?.ok, models: r.data?.models as typeof ocModels | undefined }))
            .then((res) => {
                if (cancelled || !res.models?.length) return;
                setOcModels(res.models);
                const def = res.models.findIndex((m) => m.isDefault);
                setOcModelIndex(def >= 0 ? def : 0);
            })
            .catch(() => { /* opencode op absent (old daemon) — chip stays empty */ });
        return () => { cancelled = true; };
    }, [selectedAgent, selectedMachineId]);
    const ocModel = ocModels[ocModelIndex];
    const cycleOcModel = React.useCallback(() => { setOcModelIndex(i => ocModels.length ? (i + 1) % ocModels.length : 0); }, [ocModels.length]);
    // Past-sessions picker: on-demand list of opencode sessions recorded for
    // the chosen directory (daemon boots a short-lived server, so first load
    // takes a few seconds).
    const [ocPastOpen, setOcPastOpen] = React.useState(false);
    const [ocPastLoading, setOcPastLoading] = React.useState(false);
    const [ocPast, setOcPast] = React.useState<{ id: string; title: string; updatedAt: number }[]>([]);
    const toggleOcPast = React.useCallback(() => {
        if (ocPastOpen) { setOcPastOpen(false); return; }
        setOcPastOpen(true);
        if (!selectedMachineId) return;
        setOcPastLoading(true);
        const cwd = resolveAbsolutePath(trimPathInput(pathInput) || '~', selectedMachine?.metadata?.homeDir);
        const sctx = sync.machineOnlyCtx(selectedMachineId);
        if (!sctx) return;
        machineOpencodeSessions(sctx, cwd).then(r => ({ ok: r.data?.ok, sessions: r.data?.sessions as typeof ocPast | undefined }))
            .then((res) => { setOcPast(res.sessions ?? []); })
            .catch(() => { setOcPast([]); })
            .finally(() => setOcPastLoading(false));
    }, [ocPastOpen, selectedMachineId, pathInput, selectedMachine?.metadata?.homeDir]);
    // Claude: past conversations in this directory — the transcript JSONLs the
    // daemon can resume (joy-list-logs is stat-only, so this is instant).
    const [ccPastOpen, setCcPastOpen] = React.useState(false);
    const [ccPastLoading, setCcPastLoading] = React.useState(false);
    const [ccPast, setCcPast] = React.useState<{ sessionId: string; sizeBytes: number; mtimeMs: number }[]>([]);
    const toggleCcPast = React.useCallback(() => {
        if (ccPastOpen) { setCcPastOpen(false); return; }
        setCcPastOpen(true);
        if (!selectedMachineId) return;
        setCcPastLoading(true);
        const cwd = resolveAbsolutePath(trimPathInput(pathInput) || '~', selectedMachine?.metadata?.homeDir);
        const lctx = sync.machineOnlyCtx(selectedMachineId);
        if (!lctx) return;
        machineHistoryLogs(lctx, cwd).then(r => ({ ok: r.data?.ok, logs: r.data?.logs as typeof ccPast | undefined }))
            .then((res) => { setCcPast((res.logs ?? []).slice().sort((a, b) => b.mtimeMs - a.mtimeMs)); })
            .catch(() => { setCcPast([]); })
            .finally(() => setCcPastLoading(false));
    }, [ccPastOpen, selectedMachineId, pathInput, selectedMachine?.metadata?.homeDir]);

    const ocAge = (ts: number): string => {
        const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 48) return `${h}h ago`;
        return `${Math.round(h / 24)}d ago`;
    };

    // Switching agents swaps the permission-mode list (claude vs codex) — reset
    // the index so a stale claude index can't select the wrong codex mode.
    React.useEffect(() => { setModeIndex(0); }, [selectedAgent]);
    const codexModel = codexModels[codexModelIndex];
    const codexEfforts = codexModel?.supportedReasoningEfforts ?? [];
    const codexEffort = codexEfforts[codexEffortIndex];
    const cycleCodexModel = React.useCallback(() => { setCodexModelIndex(i => codexModels.length ? (i + 1) % codexModels.length : 0); }, [codexModels.length]);
    const cycleCodexEffort = React.useCallback(() => { setCodexEffortIndex(i => codexEfforts.length ? (i + 1) % codexEfforts.length : 0); }, [codexEfforts.length]);
    // Seed the effort picker to the model's OWN default (finding #8): an
    // untouched index-0 pick would otherwise override codex's defaultReasoning-
    // Effort on every new turn. Re-runs whenever the selected model changes.
    React.useEffect(() => {
        if (!codexModel) return;
        const def = codexModel.defaultReasoningEffort;
        const idx = def ? (codexModel.supportedReasoningEfforts ?? []).indexOf(def) : -1;
        setCodexEffortIndex(idx >= 0 ? idx : 0);
    }, [codexModelIndex, codexModels]);

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

    // Codex uses its OWN permission modes — the claude modes silently escalate
    // when mapped onto codex (finding #1). Pick the list by selected agent.
    const permissionModes = selectedAgent === 'codex' ? JOY_CODEX_PERMISSION_MODES : JOY_CLAUDE_PERMISSION_MODES;
    const currentMode = permissionModes[modeIndex] ?? permissionModes[0];
    const isYolo = currentMode.key === 'bypassPermissions' || currentMode.key === 'yolo';
    const cycleMode = React.useCallback(() => {
        setModeIndex(i => (i + 1) % permissionModes.length);
    }, [permissionModes.length]);

    // 'none' plus the model catalog — claude falls back when the primary
    // model is overloaded.
    const fallbackOptions = React.useMemo(
        () => [{ key: null as string | null, name: 'none' }, ...JOY_CLAUDE_MODELS],
        [],
    );
    const currentFallback = fallbackOptions[fallbackIndex] ?? fallbackOptions[0];
    const cycleFallback = React.useCallback(() => {
        setFallbackIndex(i => (i + 1) % fallbackOptions.length);
    }, [fallbackOptions.length]);

    const handleCreate = React.useCallback(async (): Promise<void> => {
        if (!selectedMachineId || !selectedMachine) {
            Modal.alert(t('common.error'), 'Select a machine');
            return;
        }
        if (!isMachineOnline(selectedMachine)) {
            Modal.alert(t('common.error'), 'Machine is offline');
            return;
        }
        const gitClone = parseGitUrl(pathInput);
        // A git URL clones into ~/Workspace/<repo> (or reuses an existing
        // clone there) and the session launches inside it.
        const cwd = gitClone
            ? resolveAbsolutePath(`~/Workspace/${gitClone.repoName}`, selectedHomeDir)
            : resolveAbsolutePath(trimPathInput(pathInput) || '~', selectedHomeDir);
        setIsSpawning(true);
        try {
            // Spawn is v2-only: a durable command lands on the relay queue,
            // the daemon's nucleus lane executes it, and the session card
            // arrives via normal sync stamped with its v2 link. We wait for
            // that card so we can navigate straight into the session.
            const happySessionId = await v2SpawnAndWait(selectedMachineId, {
                cwd,
                agent: selectedAgent,
                // Codex/opencode carry their own model ids from their catalogs;
                // claude sends its key. Effort is claude/codex only.
                model: selectedAgent === 'codex' ? codexModel?.model : selectedAgent === 'opencode' ? ocModel?.id : selectedAgent === 'pi' ? undefined : currentModel?.key,
                effort: selectedAgent === 'codex' ? codexEffort : selectedAgent === 'claude' && currentEffort && currentEffort.key !== 'default' ? currentEffort.key : undefined,
                // resume by id wins over --continue (most recent); never both.
                resume_id: resumeId.trim() || undefined,
                continue: (continueLast && !resumeId.trim()) || undefined,
                resumeLimitMb: selectedAgent === 'claude' && (resumeId.trim() || continueLast) ? (Number(resumeMb) >= 0 ? Number(resumeMb) : 1) : undefined,
                permissionMode: selectedAgent !== 'opencode' && selectedAgent !== 'pi' ? currentMode.key : undefined,
                fallbackModel: selectedAgent === 'claude' ? (currentFallback.key ?? undefined) : undefined,
                forkSession: (selectedAgent === 'claude' && (continueLast || resumeId.trim()) && forkSession) || undefined,
                extraArgs: selectedAgent !== 'opencode' && selectedAgent !== 'pi' ? (extraArgs.trim() || undefined) : undefined,
            });
            if (!happySessionId) return; // user declined the directory prompt

            // Remember this machine+folder so the next new-session pre-selects it.
            // Store the tilde-relative form (~/…) so it stays portable across machines.
            const usedPath = formatPathRelativeToHome(trimPathInput(pathInput) || '~/', selectedHomeDir);
            setRecentMachinePaths([
                { machineId: selectedMachineId, path: usedPath },
                ...recentMachinePaths.filter(r => !(r.machineId === selectedMachineId && r.path === usedPath)),
            ].slice(0, 10));

            const trimmedPrompt = prompt.trim();
            if (trimmedPrompt) {
                const sendRes = await sync.sendMessage(happySessionId, trimmedPrompt, { source: 'new_session' });
                // A failed initial send must be VISIBLE — it was silently eaten
                // once (the bind race) and read as "messages go into the void".
                if (!sendRes.ok) Modal.alert(t('common.error'), `Initial message not sent: ${sendRes.reason ?? 'unknown'}`);
            }
            router.back();
            setTimeout(() => router.push(`/session/${happySessionId}` as never), 100);
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to start joy-tmux session';
            Modal.alert(t('common.error'), msg);
        } finally {
            setIsSpawning(false);
        }
    }, [selectedMachineId, selectedMachine, selectedHomeDir, pathInput, currentModel, currentEffort, currentMode, currentFallback, continueLast, forkSession, resumeId, resumeMb, extraArgs, prompt, router, navigateToSession, recentMachinePaths, setRecentMachinePaths]);

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

    const machineName = selectedMachine ? getMachineName(selectedMachine) : 'Select machine';
    const displayPath = trimPathInput(pathInput)
        ? formatPathRelativeToHome(trimPathInput(pathInput), selectedHomeDir)
        : '~/';

    return (
        <View style={styles.container}>
            <KeyboardAwareScrollView
                style={styles.inner}
                contentContainerStyle={[styles.scrollContent, { paddingBottom: safeArea.bottom + 24 }]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                bottomOffset={16}
                showsVerticalScrollIndicator={false}
            >
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
                                accessibilityRole="button"
                                testID="joy-new-path-picker"
                            >
                                <Ionicons name="folder-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>{displayPath}</Text>
                            </Pressable>

                            {/* Agent badge (tap to toggle claude ↔ codex) + model + effort */}
                            <View style={styles.configRow}>
                                <Ionicons name="terminal-outline" size={15} color={theme.colors.textSecondary} />
                                <Pressable onPress={() => setSelectedAgent(a => a === 'claude' ? 'codex' : a === 'codex' ? 'opencode' : a === 'opencode' ? 'pi' : 'claude')} style={(p) => [p.pressed && styles.configRowPressed]}>
                                    <Text style={styles.configLabel} numberOfLines={1}>{selectedAgent === 'codex' ? 'codex' : selectedAgent === 'opencode' ? 'opencode' : selectedAgent === 'pi' ? 'pi' : 'claude code'}</Text>
                                </Pressable>
                                {selectedAgent === 'codex' && codexModel && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleCodexModel} style={(p) => [p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>{codexModel.displayName}</Text>
                                        </Pressable>
                                        {codexEfforts.length > 0 && (
                                            <>
                                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                                <Pressable onPress={cycleCodexEffort} style={(p) => [p.pressed && styles.configRowPressed]}>
                                                    <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>{codexEffort}</Text>
                                                </Pressable>
                                            </>
                                        )}
                                    </>
                                )}
                                {selectedAgent === 'opencode' && ocModel && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleOcModel} style={(p) => [p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>{ocModel.displayName}</Text>
                                        </Pressable>
                                    </>
                                )}
                                {selectedAgent === 'claude' && modelModes.length > 1 && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleModel} style={(p) => [p.pressed && styles.configRowPressed]}>
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                                {currentModel?.name ?? 'default'}
                                            </Text>
                                        </Pressable>
                                    </>
                                )}
                                {/* Claude effort — codex has its own effort item above. */}
                                {selectedAgent === 'claude' && effortLevels.length > 0 && currentEffort && (
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

                            {/* Permission mode — tap to cycle through the same order as
                                claude's Shift+Tab. yolo (bypassPermissions) is the default.
                                Hidden for opencode: v1 has no permission surface (approvals
                                land as chat prompts). */}
                            {selectedAgent !== 'opencode' && selectedAgent !== 'pi' && (
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={cycleMode}
                            >
                                <Ionicons
                                    name={isYolo ? 'play-forward' : 'shield-outline'}
                                    size={15}
                                    color={isYolo ? '#F87171' : theme.colors.textSecondary}
                                />
                                <Text style={[styles.configLabel, isYolo && { color: '#F87171' }]} numberOfLines={1}>
                                    {currentMode.name}
                                </Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {isYolo ? 'permission prompts are skipped' : 'permission mode'}
                                </Text>
                            </Pressable>
                            )}

                            {/* Claude-only: fallback model (--fallback-model). */}
                            {selectedAgent === 'claude' && (<>
                            {/* Fallback model — tap to cycle. */}
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={cycleFallback}
                            >
                                <Ionicons name="swap-horizontal-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>fallback</Text>
                                <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                    {currentFallback.name}
                                </Text>
                                {currentFallback.key != null && (
                                    <Text style={styles.configHint} numberOfLines={1}>
                                        when {currentModel?.name ?? 'the model'} is overloaded
                                    </Text>
                                )}
                            </Pressable>

                            </>)}

                            {/* Continue — resume the most recent conversation in this
                                cwd (claude: --continue; codex: newest thread whose
                                rollout ran here; opencode: newest session in this
                                directory). */}
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={() => setContinueLast(v => !v)}
                                accessibilityRole="button"
                                accessibilityState={{ checked: continueLast }}
                                testID="joy-new-continue-toggle"
                            >
                                <Ionicons
                                    name={continueLast ? 'checkbox' : 'square-outline'}
                                    size={15}
                                    color={continueLast ? theme.colors.textLink : theme.colors.textSecondary}
                                />
                                <Text style={styles.configLabel} numberOfLines={1}>continue</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {continueLast ? (selectedAgent === 'claude' ? 'resume last claude conversation' : `resume last ${selectedAgent} conversation`) : 'start fresh'}
                                </Text>
                            </Pressable>

                            {/* Fork — claude-only; only meaningful with continue (claude
                                rejects --fork-session on a fresh session). */}
                            {selectedAgent === 'claude' && (<>
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed, !continueLast && { opacity: 0.4 }]}
                                onPress={() => setForkSession(v => !v)}
                                disabled={!continueLast}
                            >
                                <Ionicons
                                    name={continueLast && forkSession ? 'checkbox' : 'square-outline'}
                                    size={15}
                                    color={continueLast && forkSession ? theme.colors.textLink : theme.colors.textSecondary}
                                />
                                <Text style={styles.configLabel} numberOfLines={1}>fork</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {continueLast ? 'continue under a new session id' : 'requires continue'}
                                </Text>
                            </Pressable>
                            </>)}

                            {/* Resume a specific conversation by id (claude session id,
                                or codex thread id). Overrides continue when set. */}
                            <View style={styles.configRow}>
                                <Ionicons name="refresh-outline" size={15} color={theme.colors.textSecondary} />
                                <TextInput
                                    value={resumeId}
                                    onChangeText={setResumeId}
                                    placeholder="resume session id"
                                    testID="joy-new-resume-id-input"
                                    placeholderTextColor={theme.colors.textSecondary}
                                    style={styles.argsInput}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    autoComplete="off"
                                />
                            </View>

                            {/* Claude: past conversations in this directory — tap one to
                                fill the resume field. */}
                            {selectedAgent === 'claude' && (<>
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={toggleCcPast}
                            >
                                <Ionicons name={ccPastOpen ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>past sessions</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {ccPastLoading ? 'loading…' : ccPastOpen && !ccPast.length ? 'none in this directory' : 'resume an earlier conversation'}
                                </Text>
                            </Pressable>
                            {ccPastOpen && !ccPastLoading && ccPast.slice(0, 8).map((ps) => (
                                <Pressable
                                    key={ps.sessionId}
                                    style={(p) => [styles.configRow, { paddingLeft: 34 }, p.pressed && styles.configRowPressed]}
                                    onPress={() => { setResumeId(ps.sessionId); setContinueLast(true); setCcPastOpen(false); }}
                                >
                                    <Ionicons
                                        name={resumeId === ps.sessionId ? 'radio-button-on' : 'radio-button-off'}
                                        size={13}
                                        color={resumeId === ps.sessionId ? theme.colors.textLink : theme.colors.textSecondary}
                                    />
                                    <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                        {ps.sessionId.slice(0, 18)}…
                                    </Text>
                                    <Text style={styles.configHint} numberOfLines={1}>{ocAge(ps.mtimeMs)} · {Math.max(1, Math.round(ps.sizeBytes / 1024))}KB</Text>
                                </Pressable>
                            ))}
                            </>)}

                            {/* Opencode: past sessions in this directory — tap one to
                                fill the resume field. */}
                            {selectedAgent === 'opencode' && (<>
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={toggleOcPast}
                            >
                                <Ionicons name={ocPastOpen ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>past sessions</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {ocPastLoading ? 'loading…' : ocPastOpen && !ocPast.length ? 'none in this directory' : 'resume an earlier conversation'}
                                </Text>
                            </Pressable>
                            {ocPastOpen && !ocPastLoading && ocPast.slice(0, 8).map((ps) => (
                                <Pressable
                                    key={ps.id}
                                    style={(p) => [styles.configRow, { paddingLeft: 34 }, p.pressed && styles.configRowPressed]}
                                    onPress={() => { setResumeId(ps.id); setContinueLast(true); setOcPastOpen(false); }}
                                >
                                    <Ionicons
                                        name={resumeId === ps.id ? 'radio-button-on' : 'radio-button-off'}
                                        size={13}
                                        color={resumeId === ps.id ? theme.colors.button.primary.background : theme.colors.textSecondary}
                                    />
                                    <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                                        {ps.title?.startsWith('New session') ? ps.id.slice(0, 16) + '…' : (ps.title || ps.id)}
                                    </Text>
                                    <Text style={styles.configHint} numberOfLines={1}>{ocAge(ps.updatedAt)}</Text>
                                </Pressable>
                            ))}
                            </>)}

                            {/* History to backfill (MB). Relevant when resuming by
                                id OR continuing the last conversation. 0 = full.
                                Claude-only: codex resume replays via thread/read. */}
                            {selectedAgent === 'claude' && (resumeId.trim() || continueLast) ? (
                                <View style={styles.configRow}>
                                    <Ionicons name="time-outline" size={15} color={theme.colors.textSecondary} />
                                    <TextInput
                                        value={resumeMb}
                                        onChangeText={setResumeMb}
                                        placeholder="2"
                                        placeholderTextColor={theme.colors.textSecondary}
                                        style={styles.argsInput}
                                        keyboardType="numeric"
                                        autoCapitalize="none"
                                        autoCorrect={false}
                                    />
                                    <Text style={styles.configHint} numberOfLines={1}>MB of history (0 = all)</Text>
                                </View>
                            ) : null}


                            {/* Extra arguments — claude: CLI args appended verbatim;
                                codex: -c config overrides (key=value …). opencode has
                                no extra-args surface. */}
                            {selectedAgent !== 'opencode' && selectedAgent !== 'pi' && (
                            <View style={styles.configRow}>
                                <Ionicons name="options-outline" size={15} color={theme.colors.textSecondary} />
                                <TextInput
                                    value={extraArgs}
                                    onChangeText={setExtraArgs}
                                    placeholder={selectedAgent === 'codex' ? 'config overrides (key=value …)' : 'extra arguments'}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    style={styles.argsInput}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                />
                            </View>
                            )}
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
                                    fontSize={composerMetrics.fontSize}
                                    lineHeight={composerMetrics.lineHeight}
                                    paddingTop={COMPOSER_INPUT_VERTICAL_PADDING}
                                    paddingBottom={COMPOSER_INPUT_VERTICAL_PADDING}
                                    maxHeight={composerMetrics.maxHeight}
                                    onKeyPress={handleKeyPress}
                                />
                            </View>
                            <Pressable
                                onPress={() => void handleCreate()}
                                disabled={!canSend}
                                accessibilityRole="button"
                                testID="joy-new-create-button"
                                style={[
                                    styles.sendButton,
                                    { marginBottom: composerMetrics.sendButtonMarginBottom },
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
            </KeyboardAwareScrollView>

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
                            placeholder="~/"
                            testID="joy-new-path-input"
                            placeholderTextColor={theme.colors.textSecondary}
                            style={styles.pathTextInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoFocus
                            returnKeyType="done"
                            onSubmitEditing={() => setPathPickerOpen(false)}
                        />
                        {parseGitUrl(pathInput) && (
                            <Text style={[styles.modalSubLabel, { color: theme.colors.textLink }]}>
                                {`Clones into ~/Workspace/${parseGitUrl(pathInput)!.repoName} and starts the session there`}
                            </Text>
                        )}
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
                                        // Keep the portable tilde form (~/…), not the
                                        // machine-specific absolute path, so it stays
                                        // valid when switching machines.
                                        setPathInput(formatPathRelativeToHome(p, selectedHomeDir));
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
        </View>
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
    scrollContent: {
        flexGrow: 1,
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
    configHint: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
        ...Platform.select({ web: { userSelect: 'none' } as any, default: {} }),
    },
    argsInput: {
        flex: 1,
        fontSize: 14,
        color: theme.colors.text,
        padding: 0,
        ...Typography.mono(),
        ...Platform.select({ web: { outlineStyle: 'none' } as any, default: {} }),
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
