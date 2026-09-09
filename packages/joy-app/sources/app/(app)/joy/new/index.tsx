// New joy session screen: machine, folder, harness, and every option the
// harness's daemon reports it can take (sync/harnessCapabilities) — model,
// effort, permission mode, continue / fork / resume by id / past sessions,
// fallback model, history backfill, extra arguments. No worktrees.
//
// Every row is keyed off the capability table for the SELECTED machine and
// harness, never off `selectedAgent === 'codex'` chains: a harness that
// gains an option on the daemon gains its row here without an app change,
// and an older daemon (no table) keeps exactly the rows it honours.
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
import { machineTeleportExport, machineTeleportImport } from '@/sync/v2/machine';
import { isMachineOnline } from '@/utils/machineUtils';
import { resolveAbsolutePath } from '@/utils/pathUtils';
import { pastSessionsContextKey } from '@/utils/pastSessionsContext';
import { harnessModelsSpec, joyMachinesSpec, modelKeyOf, pastSessionsSpec, type HarnessModel, type PastSessionRow } from '@/sync/machineResources';
import { useHarnessCapabilities } from '@/hooks/useHarnessCapabilities';
import { enabledModels } from '@/sync/modelAllowlist';
import { buildSpawnSpec } from './spawnSpec';
import type { HarnessId } from '@/sync/harnessCapabilities';
import { useResource } from '@/hooks/useResource';
import { onlineMachineIds, planMachineAutoSelect } from './machineAutoSelect';
import { formatPathRelativeToHome, formatLastSeen } from '@/utils/sessionUtils';
import { useNavigateToSession } from '@/hooks/useNavigateToSession';
import { Modal } from '@/modal';
import { v2SpawnInteractive, waitForLocalSession, type V2SpawnSpec } from '@/sync/v2/spawn';
import type { Machine, Session } from '@/sync/storageTypes';
import { getDefaultEffortKeyForModel } from '@/components/modelModeOptions';
import { JOY_CLAUDE_MODELS } from '@/sync/joyModels';

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

const NO_MODELS: HarnessModel[] = [];
const NO_PAST: PastSessionRow[] = [];
const NO_MODES: { key: string; name: string; description: string }[] = [];
/** One entry of the model picker: a key the daemon's create takes, its label, and the catalog entry behind it (live catalogs). */
type PickerModel = { key: string; name: string; entry?: HarnessModel; isDefault?: boolean; recommended?: boolean };
const HARNESS_LABELS: Record<HarnessId, string> = { claude: 'claude code', codex: 'codex', opencode: 'opencode', pi: 'pi', agy: 'antigravity' };
const HARNESS_ORDER: HarnessId[] = ['claude', 'codex', 'opencode', 'pi', 'agy'];

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
    const params = useLocalSearchParams<{ machineId?: string; path?: string; resumeId?: string; mode?: string; teleportFrom?: string }>();
    // Teleport: this page is only the machine + folder picker; on Create the
    // source daemon exports the conversation and the chosen machine imports
    // and resumes it. Files are never copied — the folder is assumed synced.
    const teleportFrom = params.teleportFrom ?? null;
    const teleportSource = teleportFrom ? (storage.getState().sessions[teleportFrom] ?? null) : null;
    // A teleport is Claude-only (the transcript is resumed with --fork-session)
    // and the import applies exactly two options: model and permission mode.
    // The form shows only what is sent (#152): agent locked, the rows the
    // import cannot apply hidden, and the two pickers pre-set from the source
    // session so an untouched form carries the source's settings over.
    const isTeleport = !!teleportFrom;
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(params.machineId ?? null);
    const [selectedAgent, setSelectedAgent] = React.useState<HarnessId>('claude');
    const [pathInput, setPathInput] = React.useState<string>(params.path || '~/');
    // The picks are KEYS, not indexes into a list: the lists come from the
    // machine's catalog and the Models allowlist and change under the page
    // (a catalog answering, a machine switch), and an index into the old list
    // pointed at a different model in the new one. An unknown key resolves to
    // the harness default. A teleport pre-sets both from the source session.
    const teleportModelKey = teleportSource?.modelMode ?? teleportSource?.metadata?.currentModelCode ?? null;
    const teleportModeKey = teleportSource?.permissionMode ?? teleportSource?.metadata?.currentOperatingModeCode ?? null;
    const [modelKey, setModelKey] = React.useState<string | null>(teleportModelKey);
    const [effortKey, setEffortKey] = React.useState<string | null>(null);
    const [modeKey, setModeKey] = React.useState<string | null>(teleportModeKey);
    // Switching harness forgets the picks: a claude model key means nothing
    // to codex, and a stale key would silently resolve to the default anyway.
    const prevAgentRef = React.useRef(selectedAgent);
    React.useEffect(() => {
        if (prevAgentRef.current === selectedAgent) return;
        prevAgentRef.current = selectedAgent;
        setModelKey(null); setEffortKey(null); setModeKey(null);
    }, [selectedAgent]);
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

    // Probe online machines for a joy-tmux daemon (the joy-machines RESOURCE
    // shared with settings/joy-sessions: every online machine is pinged in
    // parallel, 3s each) and pick the first one that answered — the decision
    // is planMachineAutoSelect over the entry of the CURRENT online set. The
    // spec key IS the set (#178 shape), so a set that changes mid-probe is a
    // new key: the old run settles into the old key and can neither select
    // for, nor block, the new one — the former "probed once" latch did
    // exactly that (E4 sweep residual). A recent probe in the cache is
    // reused instead of waiting 3s again. Discovery is only owed while
    // nothing is selected and no online last-used machine short-circuits it.
    const onlineIds = onlineMachineIds(allMachines, isMachineOnline).join(',');
    const discoverySpec = React.useMemo(() => joyMachinesSpec(onlineIds ? onlineIds.split(',') : []), [onlineIds]);
    const recentMachinePath = recentMachinePaths[0];
    const recentOnline = React.useMemo(() => {
        const m = recentMachinePath ? allMachines.find(x => x.id === recentMachinePath.machineId) : undefined;
        return !!m && isMachineOnline(m);
    }, [allMachines, recentMachinePath]);
    const discovery = useResource(discoverySpec, { enabled: !selectedMachineId && !!onlineIds && !recentOnline });
    React.useEffect(() => {
        const decision = planMachineAutoSelect({
            selectedMachineId,
            allMachines,
            isOnline: isMachineOnline,
            recent: recentMachinePath,
            keepPath: !!params.path,
            discovery: {
                data: discovery.data,
                failed: !discovery.fetching && !discovery.hasData && (discovery.error !== null || discovery.unavailable !== null),
            },
        });
        if (decision.kind !== 'select') return;
        setSelectedMachineId(decision.machineId);
        if (decision.path) setPathInput(decision.path);
    }, [selectedMachineId, allMachines, recentMachinePath, params.path, discovery]);

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

    // ── Options, from the harness's capability table ──────────────────────
    // What this machine's daemon says the harness takes (an older daemon:
    // the fallback table). Rows below render from `caps`; nothing else.
    const caps = useHarnessCapabilities(selectedMachineId, selectedAgent);
    const harnessAllowlists = useSetting('harnessModels');

    // Model catalog: the app's own list for claude, the machine's live
    // catalog otherwise — a RESOURCE per MACHINE and harness
    // (sync/machineResources), so machine A's list can never be selected —
    // or its model id sent — for machine B. Create waits until this
    // machine's catalog answered; no machine context yet is `unavailable`,
    // which does not leave Create disabled (#86). Then trimmed to what
    // Settings → Models enables (modelAllowlist.ts), the default always kept.
    const liveCatalog = useResource(caps.models.pick && caps.models.source === 'live' && selectedMachineId ? harnessModelsSpec(selectedMachineId, selectedAgent) : null);
    const catalogReady = caps.models.source !== 'live' || liveCatalog.hasData || !!liveCatalog.error || !!liveCatalog.unavailable;
    const catalogModels: HarnessModel[] = liveCatalog.data ?? NO_MODELS;
    const modelOptions = React.useMemo<PickerModel[]>(() => {
        if (!caps.models.pick) return [];
        const allow = harnessAllowlists[selectedAgent];
        if (caps.models.source === 'static') {
            const rows = JOY_CLAUDE_MODELS.map((m, i) => ({ key: m.key, name: m.name, recommended: true, isDefault: i === 0 }));
            return enabledModels(rows, allow, teleportModelKey);
        }
        const rows = catalogModels
            .map((e) => ({ key: modelKeyOf(e), name: e.displayName || modelKeyOf(e), entry: e, isDefault: e.isDefault === true, recommended: e.recommended === true }))
            .filter((r) => r.key);
        return enabledModels(rows, allow);
    }, [caps.models.pick, caps.models.source, harnessAllowlists, selectedAgent, catalogModels, teleportModelKey]);
    const currentModel = modelOptions.find((m) => m.key === modelKey) ?? modelOptions.find((m) => m.isDefault) ?? modelOptions[0];
    const cycleModel = React.useCallback(() => {
        if (modelOptions.length === 0) return;
        const i = modelOptions.findIndex((m) => m.key === (currentModel?.key ?? ''));
        setModelKey(modelOptions[(Math.max(i, 0) + 1) % modelOptions.length].key);
    }, [modelOptions, currentModel?.key]);

    // Effort: the harness's fixed levels, or the picked model's own
    // (codex `supportedReasoningEfforts`, opencode `variants`). A harness
    // with no fixed default leaves it to the model — 'default' sends nothing.
    const effortOptions = React.useMemo<string[]>(() => {
        if (!caps.effort) return [];
        const e = currentModel?.entry;
        const levels = caps.effort.perModel
            ? (e?.supportedReasoningEfforts?.length ? e.supportedReasoningEfforts : e?.variants?.length ? e.variants : caps.effort.levels)
            : caps.effort.levels;
        if (levels.length === 0) return [];
        return caps.effort.default === null && selectedAgent !== 'claude' ? ['default', ...levels] : levels;
    }, [caps.effort, currentModel?.entry, selectedAgent]);
    const effortDefault = React.useMemo<string | null>(() => {
        if (!caps.effort || effortOptions.length === 0) return null;
        const e = currentModel?.entry;
        // The model's OWN default (codex finding #8): an untouched pick must
        // not override defaultReasoningEffort on every turn.
        if (e?.defaultReasoningEffort && effortOptions.includes(e.defaultReasoningEffort)) return e.defaultReasoningEffort;
        if (selectedAgent === 'claude') {
            const d = getDefaultEffortKeyForModel('claude', currentModel?.key ?? 'default');
            return d && effortOptions.includes(d) ? d : effortOptions[effortOptions.length - 1];
        }
        return caps.effort.default && effortOptions.includes(caps.effort.default) ? caps.effort.default : effortOptions[0];
    }, [caps.effort, effortOptions, currentModel?.entry, currentModel?.key, selectedAgent]);
    const currentEffort = effortKey && effortOptions.includes(effortKey) ? effortKey : effortDefault;
    const cycleEffort = React.useCallback(() => {
        if (effortOptions.length === 0) return;
        const i = effortOptions.indexOf(currentEffort ?? '');
        setEffortKey(effortOptions[(Math.max(i, 0) + 1) % effortOptions.length]);
    }, [effortOptions, currentEffort]);

    // Permission mode — the harness's OWN modes (claude's on codex silently
    // escalate, finding #1), in the daemon's cycle order; the daemon's
    // default is the seed.
    const permissionModes = caps.permissions?.modes ?? NO_MODES;
    const currentMode = permissionModes.find((m) => m.key === modeKey)
        ?? permissionModes.find((m) => m.key === caps.permissions?.default)
        ?? permissionModes[0];
    const isYolo = currentMode?.key === 'bypassPermissions' || currentMode?.key === 'yolo';
    const cycleMode = React.useCallback(() => {
        if (permissionModes.length === 0) return;
        const i = permissionModes.findIndex((m) => m.key === (currentMode?.key ?? ''));
        setModeKey(permissionModes[(Math.max(i, 0) + 1) % permissionModes.length].key);
    }, [permissionModes, currentMode?.key]);
    // Past-sessions picker (any harness the daemon lists): a RESOURCE of ONE machine +
    // directory + harness (#153). A change of any of them is another key, so
    // a row fetched for project A can never be listed — or submitted as a
    // resume id — under project B, and A's slow response lands in A's cache
    // only. The picker closes on a context change; the list is read on open
    // (opencode boots a short-lived server, so its first load takes a few
    // seconds; joy-list-logs is stat-only, so claude's is instant).
    const pastCwd = resolveAbsolutePath(trimPathInput(pathInput) || '~', selectedMachine?.metadata?.homeDir);
    const pastContextKey = pastSessionsContextKey({ machineId: selectedMachineId, cwd: pastCwd, agent: selectedAgent });
    const [pastOpen, setPastOpen] = React.useState(false);
    React.useEffect(() => { setPastOpen(false); }, [pastContextKey]);
    const past = useResource(
        selectedMachineId && caps.resume.pastList ? pastSessionsSpec(selectedMachineId, pastCwd, selectedAgent) : null,
        { enabled: pastOpen },
    );
    const pastRows = pastOpen ? (past.data ?? NO_PAST) : NO_PAST;
    const pastLoading = pastOpen && past.isLoading;
    const pastError = pastOpen ? (past.error ?? past.unavailable) : null;
    const pastHint = pastLoading ? 'loading…'
        : pastOpen && pastError ? `could not list: ${pastError}`
            : pastOpen && !pastRows.length ? 'none in this directory'
                : 'resume an earlier conversation';
    const togglePast = React.useCallback(() => { setPastOpen((o) => !o); }, []);

    const ocAge = (ts: number): string => {
        const m = Math.max(1, Math.round((Date.now() - ts) / 60000));
        if (m < 60) return `${m}m ago`;
        const h = Math.round(m / 60);
        if (h < 48) return `${h}h ago`;
        return `${Math.round(h / 24)}d ago`;
    };


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
            if (teleportFrom) {
                const srcMachineId = teleportSource?.metadata?.machineId;
                const srcLocalId = teleportSource?.metadata?.joy__sessionId;
                if (!srcMachineId || !srcLocalId) throw new Error('The source session has no machine context');
                const sctx = sync.machineOnlyCtx(srcMachineId);
                const dctx = sync.machineOnlyCtx(selectedMachineId);
                if (!sctx || !dctx) throw new Error('Both machines must be online to teleport');
                const exp = await machineTeleportExport(sctx, srcLocalId);
                if (!exp.data?.ok || !exp.data.claudeSessionId || !exp.data.transcriptBase64) throw new Error(exp.data?.error || 'Export failed');
                // The destination gets what the form SHOWS — the picked model
                // and permission mode — not the source's exported values, which
                // silently overrode an explicit choice (#152: Plan selected,
                // bypassPermissions applied).
                const imp = await machineTeleportImport(dctx, {
                    cwd, claudeSessionId: exp.data.claudeSessionId, transcriptBase64: exp.data.transcriptBase64,
                    model: currentModel?.key ?? exp.data.model, permissionMode: currentMode?.key ?? 'bypassPermissions', createDir: true,
                });
                if (!imp.data?.ok || !imp.data.localSessionId) throw new Error(imp.data?.error || 'Import failed');
                const landed = await waitForLocalSession(imp.data.localSessionId);
                if (!landed) throw new Error('The teleported session did not appear within a minute');
                // The prompt box is shown, so it must do something: deliver it
                // to the landed session like a fresh spawn does.
                const teleportPrompt = prompt.trim();
                if (teleportPrompt) {
                    const sendRes = await sync.sendMessage(landed, teleportPrompt, { source: 'new_session' });
                    if (!sendRes.ok) Modal.alert(t('common.error'), `Initial message not sent: ${sendRes.reason ?? 'unknown'}`);
                }
                router.back();
                setTimeout(() => router.push(`/session/${landed}` as never), 100);
                return;
            }
            // Git-URL spawn: the daemon clones (or reuses) the URL into cwd
            // BEFORE launching, and the spawn fails — instead of starting an
            // agent in an empty folder — if the clone does (#151). Only what
            // the capability table allows is sent (spawnSpec.ts).
            const spawnSpec = buildSpawnSpec(caps, {
                cwd,
                gitUrl: gitClone?.url,
                agent: selectedAgent,
                model: currentModel?.key,
                effort: currentEffort ?? undefined,
                permissionMode: currentMode?.key,
                resumeId,
                continueLast,
                fork: forkSession,
                resumeMb,
                fallbackModel: currentFallback.key,
                extraArgs,
            });
            // Interactive (#417): an unanswered creation offers a Retry that
            // re-drives THIS action under the same creation intent, so the
            // relay replays the session it may already hold instead of
            // accepting a second one.
            const sessionId = await v2SpawnInteractive(selectedMachineId, spawnSpec as V2SpawnSpec);
            if (!sessionId) return; // user declined the directory or retry prompt

            // Remember this machine+folder so the next new-session pre-selects it.
            // Store the tilde-relative form (~/…) so it stays portable across machines.
            const usedPath = formatPathRelativeToHome(trimPathInput(pathInput) || '~/', selectedHomeDir);
            setRecentMachinePaths([
                { machineId: selectedMachineId, path: usedPath },
                ...recentMachinePaths.filter(r => !(r.machineId === selectedMachineId && r.path === usedPath)),
            ].slice(0, 10));

            const trimmedPrompt = prompt.trim();
            if (trimmedPrompt) {
                const sendRes = await sync.sendMessage(sessionId, trimmedPrompt, { source: 'new_session' });
                // A failed initial send must be VISIBLE — it was silently eaten
                // once (the bind race) and read as "messages go into the void".
                if (!sendRes.ok) Modal.alert(t('common.error'), `Initial message not sent: ${sendRes.reason ?? 'unknown'}`);
            }
            router.back();
            setTimeout(() => router.push(`/session/${sessionId}` as never), 100);
        } catch (error) {
            const msg = error instanceof Error ? error.message : 'Failed to start joy-tmux session';
            Modal.alert(t('common.error'), msg);
        } finally {
            setIsSpawning(false);
        }
    }, [selectedMachineId, selectedMachine, selectedHomeDir, pathInput, selectedAgent, caps, teleportFrom, teleportSource, currentModel, currentEffort, currentMode, currentFallback, continueLast, forkSession, resumeId, resumeMb, extraArgs, prompt, router, navigateToSession, recentMachinePaths, setRecentMachinePaths]);

    const canSend = !!selectedMachineId && !!selectedMachine && isMachineOnline(selectedMachine) && !isSpawning && catalogReady;

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

                            {/* Agent badge (tap cycles the harnesses) + model + effort —
                                the model and effort segments appear for any harness whose
                                table offers them. */}
                            <View style={styles.configRow}>
                                <Ionicons name="terminal-outline" size={15} color={theme.colors.textSecondary} />
                                <Pressable disabled={isTeleport} onPress={() => setSelectedAgent(a => HARNESS_ORDER[(HARNESS_ORDER.indexOf(a) + 1) % HARNESS_ORDER.length])} style={(p) => [p.pressed && styles.configRowPressed]}>
                                    <Text style={styles.configLabel} numberOfLines={1}>{HARNESS_LABELS[selectedAgent]}</Text>
                                </Pressable>
                                {currentModel && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleModel} style={(p) => [p.pressed && styles.configRowPressed]} testID="joy-new-model-picker">
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>{currentModel.name}</Text>
                                        </Pressable>
                                    </>
                                )}
                                {!isTeleport && currentEffort && (
                                    <>
                                        <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]}>·</Text>
                                        <Pressable onPress={cycleEffort} style={(p) => [p.pressed && styles.configRowPressed]} testID="joy-new-effort-picker">
                                            <Text style={[styles.configLabel, { color: theme.colors.textSecondary }]} numberOfLines={1}>{currentEffort}</Text>
                                        </Pressable>
                                    </>
                                )}
                            </View>

                            {/* Permission mode — tap to cycle the harness's own modes in
                                the daemon's order (claude: the same as Shift+Tab). Absent
                                for a harness that reports none (agy runs with permissions
                                skipped; an older daemon offers none for opencode / pi). */}
                            {currentMode && (
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={cycleMode}
                                testID="joy-new-permission-picker"
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
                                    {currentMode.description || 'permission mode'}
                                </Text>
                            </Pressable>
                            )}

                            {/* Teleport: the import applies model + permission mode only;
                                everything below is a fresh-spawn option and is hidden so
                                the form never shows a control that is ignored (#152). */}
                            {isTeleport && (
                            <View style={styles.configRow}>
                                <Ionicons name="airplane-outline" size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>teleport</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    continues the conversation here with the model and mode above
                                </Text>
                            </View>
                            )}

                            {!isTeleport && (<>
                            {/* Fallback model (claude's --fallback-model) — tap to cycle. */}
                            {caps.fallbackModel && (
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
                            )}

                            {/* Continue — resume the most recent conversation in this
                                cwd (claude: --continue; codex: newest thread whose
                                rollout ran here; opencode: newest session in this
                                directory; pi: -c; agy: --continue). */}
                            {caps.resume.continueLast && (
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
                                    {continueLast ? `resume last ${HARNESS_LABELS[selectedAgent]} conversation` : 'start fresh'}
                                </Text>
                            </Pressable>
                            )}

                            {/* Fork — continue under a NEW conversation id (claude:
                                --fork-session; codex / pi / agy: the daemon copies the
                                history file). Only meaningful with continue or a resume id. */}
                            {caps.resume.fork && (
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed, !(continueLast || resumeId.trim()) && { opacity: 0.4 }]}
                                onPress={() => setForkSession(v => !v)}
                                disabled={!(continueLast || resumeId.trim())}
                                testID="joy-new-fork-toggle"
                            >
                                <Ionicons
                                    name={(continueLast || resumeId.trim()) && forkSession ? 'checkbox' : 'square-outline'}
                                    size={15}
                                    color={(continueLast || resumeId.trim()) && forkSession ? theme.colors.textLink : theme.colors.textSecondary}
                                />
                                <Text style={styles.configLabel} numberOfLines={1}>fork</Text>
                                <Text style={styles.configHint} numberOfLines={1}>
                                    {(continueLast || resumeId.trim()) ? 'continue under a new session id' : 'requires continue or a resume id'}
                                </Text>
                            </Pressable>
                            )}

                            {/* Resume a specific conversation by id. Overrides continue when set. */}
                            {caps.resume.byId && (
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
                            )}

                            {/* Past conversations in this directory, by title — tap one
                                to fill the resume field. */}
                            {caps.resume.pastList && (<>
                            <Pressable
                                style={(p) => [styles.configRow, p.pressed && styles.configRowPressed]}
                                onPress={togglePast}
                                testID="joy-new-past-toggle"
                            >
                                <Ionicons name={pastOpen ? 'chevron-down' : 'chevron-forward'} size={15} color={theme.colors.textSecondary} />
                                <Text style={styles.configLabel} numberOfLines={1}>past sessions</Text>
                                <Text style={styles.configHint} numberOfLines={1}>{pastHint}</Text>
                            </Pressable>
                            {pastOpen && !pastLoading && pastRows.slice(0, 8).map((ps) => (
                                <Pressable
                                    key={ps.id}
                                    style={(p) => [styles.configRow, { paddingLeft: 34 }, p.pressed && styles.configRowPressed]}
                                    onPress={() => { setResumeId(ps.id); setContinueLast(true); setPastOpen(false); }}
                                >
                                    <Ionicons
                                        name={resumeId === ps.id ? 'radio-button-on' : 'radio-button-off'}
                                        size={13}
                                        color={resumeId === ps.id ? theme.colors.textLink : theme.colors.textSecondary}
                                    />
                                    <Text style={[styles.configLabel, { color: ps.title ? theme.colors.text : theme.colors.textSecondary }]} numberOfLines={1}>
                                        {ps.title || `${ps.id.slice(0, 18)}…`}
                                    </Text>
                                    <Text style={styles.configHint} numberOfLines={1}>
                                        {ps.title ? `${ps.id.slice(0, 8)} · ` : ''}{ocAge(ps.updatedAt)}{ps.sizeBytes != null ? ` · ${Math.max(1, Math.round(ps.sizeBytes / 1024))}KB` : ''}
                                    </Text>
                                </Pressable>
                            ))}
                            </>)}

                            {/* History to backfill (MB) on resume / continue. 0 = full. */}
                            {caps.resumeLimitMb && (resumeId.trim() || continueLast) ? (
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

                            {/* Extra arguments — verbatim command-line args (claude, pi,
                                agy) or key=value config overrides (codex). */}
                            {caps.extraArgs && (
                            <View style={styles.configRow}>
                                <Ionicons name="options-outline" size={15} color={theme.colors.textSecondary} />
                                <TextInput
                                    value={extraArgs}
                                    onChangeText={setExtraArgs}
                                    placeholder={caps.extraArgs === 'config' ? 'config overrides (key=value …)' : 'extra command-line args'}
                                    placeholderTextColor={theme.colors.textSecondary}
                                    style={styles.argsInput}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    testID="joy-new-extra-args-input"
                                />
                            </View>
                            )}
                            </>)}
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
