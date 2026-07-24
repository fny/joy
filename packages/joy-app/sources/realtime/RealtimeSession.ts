import type { VoiceSession } from './types';
import { fetchVoiceCredentials } from '@/sync/apiVoice';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';
import { storage } from '@/sync/storage';
import {
    getVoiceMessageCount,
    getVoiceOnboardingPromptLoadCount,
    getVoiceSoftPaywallShownCount,
    incrementVoiceOnboardingPromptLoadCount,
    incrementVoiceSoftPaywallShown,
} from '@/sync/persistence';
import { buildVoiceFirstMessage, buildVoiceSystemPrompt } from './voiceSystemPrompt';
import { getVoiceUpsellVariant } from './voiceExperiment';
import { clearVoiceTranscript, getRecentVoiceTranscript } from './voiceTranscript';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let currentSessionId: string | null = null;
let currentVoiceConversationId: string | null = null;
let currentVoiceSessionStartedAt: number | null = null;

// ── Auto-reconnect state ─────────────────────────────────────────────────────
// A dropped connection (agent-side max duration, transient network blip, token
// expiry — see the disconnect investigation) leaves voice permanently dead
// because nothing restarts it. We reconnect on an UNINTENTIONAL disconnect,
// restoring context (coding session + recent voice transcript) so the
// conversation continues rather than starting over.
const MAX_RECONNECT_ATTEMPTS = 4;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Set right before a user-initiated stop so the resulting onDisconnect does NOT
// trigger a reconnect.
let intentionalStop = false;
// The coding-session context from the last fresh start, reused when we
// reconnect (the reconnect has no SessionView call site to rebuild it).
let lastCodingContext: string | undefined;

interface StartOptions { isContinuation?: boolean; silent?: boolean; }

function clearReconnectTimer(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

/**
 * Start a voice session. Returns the ElevenLabs conversation ID if started, null otherwise.
 */
export async function startRealtimeSession(sessionId: string, initialContext?: string, opts?: StartOptions): Promise<string | null> {
    currentVoiceConversationId = null;
    currentVoiceSessionStartedAt = null;

    const isContinuation = opts?.isContinuation === true;
    const silent = opts?.silent === true;
    if (!isContinuation) {
        // A genuinely new conversation: drop any prior transcript and reset the
        // reconnect budget. A continuation keeps both.
        clearVoiceTranscript();
        clearReconnectTimer();
        reconnectAttempts = 0;
        intentionalStop = false;
        lastCodingContext = initialContext;
    } else if (initialContext === undefined) {
        // Reconnect path: reuse the coding context captured at the fresh start.
        initialContext = lastCodingContext;
    }

    if (!voiceSession) {
        console.warn('No voice session registered');
        return null;
    }

    // Show connecting state immediately so the user sees feedback
    storage.getState().setRealtimeStatus('connecting');

    // Request microphone permission before starting voice session
    // Critical for iOS/Android - first session will fail without this
    const permissionResult = await requestMicrophonePermission();
    if (!permissionResult.granted) {
        storage.getState().setRealtimeStatus('disconnected');
        if (!silent) showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
        return null;
    }

    try {
        // Bypass Happy server token — only when user has their own custom agent
        const { voiceBypassToken, voiceCustomAgentId } = storage.getState().settings;
        if (voiceBypassToken && voiceCustomAgentId) {
            console.log('[Voice] Bypassing token, custom agent ID:', voiceCustomAgentId);
            currentSessionId = sessionId;
            const conversationId = await voiceSession.startSession({
                sessionId,
                initialContext,
                agentId: voiceCustomAgentId,
            });
            currentVoiceConversationId = conversationId;
            currentVoiceSessionStartedAt = Date.now();
            voiceSessionStarted = true;
            return conversationId;
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            storage.getState().setRealtimeStatus('disconnected');
            if (!silent) Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        const response = await fetchVoiceCredentials(credentials, sessionId);
        console.log('[Voice] fetchVoiceCredentials response:', response);

        if (!response.allowed) {
            storage.getState().setRealtimeStatus('disconnected');

            if (response.reason === 'voice_conversation_limit_reached') {
                if (!silent) Modal.alert(
                    t('errors.voiceLimitReachedTitle'),
                    t('errors.voiceConversationLimitReached'),
                );
                return null;
            }

            // Server hard-declined — must pay to continue. Never pop a paywall
            // during a background reconnect — just stop trying.
            if (silent) return null;
            console.log('[Voice] Not allowed (reason: %s), presenting must-pay paywall...', response.reason);
            const result = await sync.presentPaywall('voice_must_pay');
            console.log('[Voice] Must-pay paywall result:', result);
            if (result.purchased) {
                return startRealtimeSession(sessionId, initialContext);
            }
            return null;
        }

        const hasPro = storage.getState().purchases.entitlements['pro'] ?? false;
        const { voiceUpsellOverride, devModeEnabled } = storage.getState().localSettings;
        const voiceUpsellVariant = getVoiceUpsellVariant({
            override: voiceUpsellOverride,
            overrideEnabled: __DEV__ || devModeEnabled,
        });

        if (
            !silent &&
            !hasPro &&
            voiceUpsellVariant === 'show-paywall-before-first-voice-chat' &&
            getVoiceSoftPaywallShownCount() < 1
        ) {
            console.log('[Voice] First voice attempt on free tier, showing soft paywall...');
            incrementVoiceSoftPaywallShown();
            const result = await sync.presentPaywall('voice_trial_eligible');
            console.log('[Voice] Soft paywall result:', result);
            // Dismissed or error — continue anyway, they can still use free tier.
        }

        currentSessionId = sessionId;
        const onboardingPromptLoadCount = getVoiceOnboardingPromptLoadCount();
        const voiceMessageCount = getVoiceMessageCount();
        const systemPrompt = buildVoiceSystemPrompt({
            initialContext,
            onboardingPromptLoadCount,
            voiceMessageCount,
            includePaidVoiceOnboarding: !hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell',
            isContinuation,
            voiceTranscript: isContinuation ? getRecentVoiceTranscript() : null,
        });
        const firstMessage = buildVoiceFirstMessage({
            hasPro,
            onboardingPromptLoadCount,
            includePaidVoiceOnboarding: voiceUpsellVariant === 'voice-onboarding-and-upsell',
            isContinuation,
        });

        const startedConversationId = await voiceSession.startSession({
            sessionId,
            initialContext,
            systemPrompt,
            firstMessage,
            conversationToken: response.conversationToken,
            agentId: response.agentId,
            userId: response.elevenUserId,
        });
        if (!hasPro && voiceUpsellVariant === 'voice-onboarding-and-upsell') {
            incrementVoiceOnboardingPromptLoadCount();
        }
        currentVoiceConversationId = response.conversationId ?? startedConversationId;
        currentVoiceSessionStartedAt = Date.now();
        voiceSessionStarted = true;
        return currentVoiceConversationId;
    } catch (error) {
        console.error('Failed to start realtime session:', error);
        storage.getState().setRealtimeStatus('disconnected');
        currentSessionId = null;
        currentVoiceConversationId = null;
        currentVoiceSessionStartedAt = null;
        voiceSessionStarted = false;
        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        return null;
    }
}

export async function stopRealtimeSession() {
    // Mark BEFORE ending so the resulting onDisconnect skips auto-reconnect.
    intentionalStop = true;
    clearReconnectTimer();
    reconnectAttempts = 0;
    clearVoiceTranscript();

    if (!voiceSession) {
        return;
    }

    try {
        await voiceSession.endSession();
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
        currentSessionId = null;
        currentVoiceConversationId = null;
        currentVoiceSessionStartedAt = null;
        voiceSessionStarted = false;
    }
}

/**
 * Called from the SDK's onConnect. A live connection means the reconnect
 * sequence (if any) succeeded — reset the budget.
 */
export function notifyVoiceConnected(): void {
    reconnectAttempts = 0;
    clearReconnectTimer();
}

/**
 * Called from the SDK's onDisconnect when the drop was NOT user-initiated.
 * Schedules a context-restoring reconnect with exponential backoff, up to
 * MAX_RECONNECT_ATTEMPTS. The onDisconnect handler still bumps the session
 * generation first (remounting the provider for a clean SDK instance); the
 * backoff delay lets that remount settle before we start again.
 */
export function notifyVoiceUnexpectedDisconnect(): void {
    if (intentionalStop) { intentionalStop = false; return; }
    const sessionId = currentSessionId;
    if (!sessionId) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.warn('[Voice] reconnect budget exhausted — giving up');
        clearReconnectTimer();
        reconnectAttempts = 0;
        currentSessionId = null;
        voiceSessionStarted = false;
        clearVoiceTranscript();
        return;
    }
    const attempt = reconnectAttempts++;
    const delay = Math.min(800 * 2 ** attempt, 8000); // 800ms, 1.6s, 3.2s, 6.4s
    console.log(`[Voice] scheduling reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    storage.getState().setRealtimeStatus('connecting');
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        const sid = currentSessionId;
        if (!sid || intentionalStop) return;
        startRealtimeSession(sid, undefined, { isContinuation: true, silent: true })
            .then((id) => {
                // startSession resolved but failed to connect (returned null):
                // re-enter the backoff chain rather than leaving voice dead.
                if (!id && !intentionalStop) notifyVoiceUnexpectedDisconnect();
            })
            .catch(() => { if (!intentionalStop) notifyVoiceUnexpectedDisconnect(); });
    }, delay);
}

export function registerVoiceSession(session: VoiceSession) {
    if (voiceSession) {
        console.warn('Voice session already registered, replacing with new one');
    }
    voiceSession = session;
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

export function getCurrentRealtimeSessionId(): string | null {
    return currentSessionId;
}

export function getCurrentVoiceConversationId(): string | null {
    return currentVoiceConversationId;
}

export function getCurrentVoiceSessionDurationSeconds(): number | undefined {
    if (currentVoiceSessionStartedAt === null) {
        return undefined;
    }
    return Math.max(0, Math.round((Date.now() - currentVoiceSessionStartedAt) / 1000));
}

export function setCurrentRealtimeSessionId(sessionId: string) {
    currentSessionId = sessionId;
}
