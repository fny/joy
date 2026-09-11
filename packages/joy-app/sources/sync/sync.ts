import { getCurrentAppState } from '@/sync/clientId';
import { AuthCredentials } from '@/auth/tokenStorage';
import { Encryption } from '@/sync/encryption/encryption';
import { decodeBase64 } from '@/encryption/base64';
import { storage } from './storage';
import { ensureDesktopNotificationPermission } from '@/notifications/desktopNotifications';
import { ApiMessage } from './apiTypes';
import { Session, Machine } from './storageTypes';
import { InvalidateSync } from '@/utils/sync';
import { randomUUID } from 'expo-crypto';
import * as Crypto from 'expo-crypto';
import { sealV2Content, sealV2Bytes, openV2Bytes, type V2Attachment } from './v2/crypto';
import { attachmentDisplayName } from './attachmentNames';
import { v2, v2SendCiphertext, v2UploadAttachment, v2FetchAttachment, v2CancelTurn, connectV2Stream, V2ApiError, getV2BaseUrl } from './v2/api';
import { staleSessionIds } from './sessionListReconcile';
import { StaleFetchError, isSendAcknowledged, cursorsNeedReanchor } from './sessionSyncGuards';
import { initialSettingsSync, nextSettingsSync, pendingOf, type SettingsSyncState, type SettingsSyncEvent } from './settingsSyncMachine';
import { initialLiveDriver, nextLiveDriver, indicatorOf, type LiveDriverState, type LiveDriverEvent } from './liveDriverMachine';
import { SessionLogs, fetchBranchOf } from './sessionLogMachine';
import { v2LinkForRow } from './sessionLink';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeHex } from '@/encryption/hex';
import { v2MessagesAfter, v2MessagesBefore, type V2Lifecycle } from './v2/reads';

/** Relay poll cadence: the baseline live channel everywhere, and the ONLY one
 *  on native (SSE needs a streaming fetch body React Native lacks). */
const POLL_INTERVAL_MS = 2500;
/** How often to re-read account settings while the app is in front. Far slower
 *  than the session poll because settings change when a HUMAN changes them,
 *  not continuously — but not never, which is what it was. */
const SETTINGS_POLL_MS = 30_000;

import { reconcileDisabledPushState, syncCurrentPushToken } from './pushRegistration';
import { SyncInitGate } from './initGate';
import { Platform, AppState } from 'react-native';
import { NormalizedMessage, normalizeRawMessage } from './typesRaw';
import { Settings, settingsParse, settingsToSyncPayload } from './settings';
import { profileParse } from './profile';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { parseToken } from '@/utils/parseToken';
import { log } from '@/log';
import { clearGitStatusForSession, invalidateGitStatus } from './gitStatusResource';
import { forgetSessionFiles } from './fileContents';
import { resources } from './resource';
import { AsyncLock } from '@/utils/lock';
import type { AttachmentPreview } from './attachmentTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isDemoSession } from './demoSession';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import type { Message } from './typesMessage';

import { liveFacts, isTurnActive } from './sessionFacts';
import { CardMemo } from './v2/cardMemo';
// Sentinel used as `before_seq` for the very first backward fetch of a
// session. It must exceed any real `seq` value the server can produce; the
// relay stores `seq` as BIGINT, but a session would need two billion events
// to reach this, so int32-max is "infinite" in practice and stays exact in JS.
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;

/** One span `(fromSeq, toSeq]` of sealed rows that did not open under
 *  `keyId`, settled: every row in it was tried under exactly that key.
 *  `count` is the rows the relay reported unopenable (a display estimate
 *  once a span is clipped). See Sync.unopenableGaps (#128). */
type UnopenableRange = { fromSeq: number; toSeq: number; keyId: string | null; count: number };

/** Advertised per-file attachment cap (the picker's dialog quotes the MB). */
export const MAX_ATTACHMENT_MB = 10;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;
/** A picked file we refuse to upload (too large / empty) — message is the
 *  user-facing, already-localized reason. */
class AttachmentRejected extends Error {}

type SendMessageOptions = {
    source?: 'chat' | 'new_session' | 'option' | 'question' | 'voice';
    /** Optional image attachments to send before the text message. */
    attachments?: AttachmentPreview[];
    /** Caller-supplied localId — the draft-release path passes a persisted,
     *  STABLE id so retries dedupe at both the reducer and the server. */
    localId?: string;
};

/** sendMessage's success contract: ok only once the relay has ACCEPTED the
 *  prompt (there is no optimistic row and no outbox on v2 — the user row
 *  arrives from the relay log). Any ok:false must be handled by the caller:
 *  the composer puts the message back, the draft-release lease reverts.
 *  `turnId` is the relay turn the POST ack named (absent only when the ack
 *  was lost and the event log vouched for the send, #410) — it is what a
 *  removal that raced the send cancels (#134). */
export type SendMessageResult = { ok: true; localId: string; turnId?: string } | { ok: false; reason: string };

/**
 * Thinking state implied by a message's embedded turn-lifecycle event:
 * `true` on turn/task start, `false` on turn/task end or abort, `null` if the
 * message carries no lifecycle signal. Single source of truth shared by the live
 * websocket handler and the HTTP refetch path, so a refetch (reconnect/focus)
 * corrects a missed thinking transition instead of waiting for the next ~20s
 * activity heartbeat.
 */
function deriveThinkingFromContent(content: unknown): boolean | null {
    const rc = content as {
        content?: { type?: string; data?: { type?: string; ev?: { t?: string } } };
    } | null;
    const contentType = rc?.content?.type;
    const dataType = rc?.content?.data?.type;
    const evt = rc?.content?.data?.ev?.t;
    const isComplete =
        ((contentType === 'acp' || contentType === 'codex') && (dataType === 'task_complete' || dataType === 'turn_aborted')) ||
        (contentType === 'session' && evt === 'turn-end');
    const isStarted =
        ((contentType === 'acp' || contentType === 'codex') && dataType === 'task_started') ||
        (contentType === 'session' && evt === 'turn-start');
    if (isComplete) return false;
    if (isStarted) return true;
    return null;
}

class Sync {
    encryption!: Encryption;
    serverID!: string;
    anonID!: string;
    private credentials!: AuthCredentials;
    /** Account master secret — needed to derive the machine tunnel key
     *  (deriveKey(master,'Joy Tunnel',[machineId])). Held in memory only. */
    private masterSecret: Uint8Array | null = null;
    setMasterSecret(secret: Uint8Array) { this.masterSecret = secret; }
    getMasterSecret(): Uint8Array | null { return this.masterSecret; }
    private sessionsSync: InvalidateSync;
    private messagesSync = new Map<string, InvalidateSync>();
    /** Per-session message log state: both cursors, whether the store holds
     *  the rows, and the fetch generation — one machine (sessionLogMachine.ts)
     *  where three maps used to disagree (#407, #406, #12, #4, #2). */
    private logs = new SessionLogs();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    /** Cancels the engine's own push-token requests at shutdown (logout). */
    private pushLifetime = new AbortController();
    private nativeUpdateSync: InvalidateSync;
    /** Settings sync state (settingsSyncMachine.ts). The persisted pending
     *  deltas are its projection: what a restart must still push. */
    private settingsState: SettingsSyncState = initialSettingsSync(loadPendingSettings());
    private settingsRetryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.sessionsSync = new InvalidateSync(this.fetchSessions);
        this.settingsSync = new InvalidateSync(this.syncSettings);
        this.profileSync = new InvalidateSync(this.fetchProfile);
        this.machinesSync = new InvalidateSync(this.fetchMachines);
        this.nativeUpdateSync = new InvalidateSync(this.fetchNativeUpdate);

        const registerPushToken = async () => {
            await this.registerPushToken();
        }
        this.pushTokenSync = new InvalidateSync(registerPushToken);

        // Request desktop-notification permission once (web/desktop app), if enabled.
        if (Platform.OS === 'web' && storage.getState().settings.notificationsDesktop) {
            void ensureDesktopNotificationPermission();
        }

        // Settings are PULLED, never pushed to us. Foreground alone is not
        // enough to make a pin made elsewhere show up here: two devices open
        // side by side never foreground, and a desktop tab in front of you
        // never does either. A small GET on a slow timer is what makes
        // cross-device settings feel like they sync rather than like they do
        // not work.
        const settingsPoll = setInterval(() => {
            if (getCurrentAppState() === 'active') this.settingsSync.invalidate();
        }, SETTINGS_POLL_MS);
        (settingsPoll as { unref?: () => void }).unref?.();

        // Refresh the account-level syncs when the app returns to the foreground.
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                log.log('📱 App became active');
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
                // Settings too: they are pulled, not pushed to us, so without
                // this a pin made on another device only arrived if THIS
                // device happened to change a setting of its own.
                this.settingsSync.invalidate();
                // Refetch the session the user is looking at. sessionsSync above
                // restores metadata but NOT messages (and it preserves thinking),
                // so a chat that missed `update`/`ephemeral` events while the app
                // was backgrounded would otherwise stay stale until remounted.
                this.refetchViewedSession();
            } else {
                log.log(`📱 App state changed to: ${nextAppState}`);
            }
        });

        // Web/desktop: AppState alone doesn't capture tab focus/visibility.
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
            const broadcast = () => {
                // On web, RN AppState doesn't reliably fire 'active' on tab/window
                // refocus, so the became-active refetch above can be skipped. When
                // we regain focus, pull the viewed session so a chat that missed
                // live pokes while the tab was hidden catches up automatically.
                if (getCurrentAppState() === 'active') {
                    this.refetchViewedSession();
                    // Settings too. This is the ONLY place web ever learned
                    // them after startup: RN's AppState 'active' does not fire
                    // on tab focus (the reason this handler exists), so the
                    // invalidate added to that listener never ran on web and a
                    // pin made on another device arrived only on page reload.
                    this.settingsSync.invalidate();
                }
            };
            document.addEventListener('visibilitychange', broadcast);
            window.addEventListener('focus', broadcast);
            window.addEventListener('blur', broadcast);
        }
    }

    // Refetch messages + git status for the session the user is currently viewing,
    // independent of the live stream. Used as a self-heal on reconnect / app-foreground
    // so a missed `update`/`ephemeral` event doesn't leave the open chat frozen
    // until it's manually remounted. Cheap when already up to date (forward sync
    // from the last seq returns nothing).
    private refetchViewedSession = () => {
        const viewing = storage.getState().currentViewingSessionId;
        if (viewing) {
            this.onSessionVisible(viewing);
        }
    }

    /** Staleness probe for the OPEN chat: one-row fetch after the local cursor.
     *  Anything there means we missed a live update (dead SSE stream, dropped
     *  poke — cause immaterial) → invalidate and let the normal fetch heal.
     *  Runs on a short interval from SessionView; a single tiny query per tick
     *  for one session, and a no-op result costs one empty page. This is the
     *  backstop for the "response doesn't show until I switch away and back"
     *  family — reconnect/foreground heals exist, but silent in-foreground
     *  loss had nothing watching for it. */
    probeViewedSessionStaleness = async () => {
        const sessionId = storage.getState().currentViewingSessionId;
        if (!sessionId) return;
        const cursor = this.logs.lastSeq(sessionId);
        if (cursor === undefined) return; // initial load not done — it fetches anyway
        const ctx = this.v2ReadCtx(sessionId);
        if (!ctx) return;
        try {
            const data = await v2MessagesAfter({ ...ctx, afterSeq: cursor, limit: 1 });
            if (data.messages.length > 0) {
                log.log(`🩹 Staleness probe: rows beyond cursor ${cursor} for ${sessionId} — healing`);
                this.getMessagesSync(sessionId).invalidate();
            }
        } catch {
            // transient — next tick retries
        }
    }

    /** Nuclear per-session heal: drop the chat's client state (messages,
     *  reducer, cursors) and refetch from scratch — the user-facing escape
     *  hatch for any "chat is frozen/behind and nothing else fixes it" bug.
     *  Server state is untouched; nothing can be lost except local corruption. */
    resetSessionChatState(sessionId: string): void {
        // Invalidate in-flight work FIRST: a forward fetch awaiting its
        // response when the reset ran used to apply its page afterwards and
        // restore only the forward cursor — one message, no backward anchor,
        // and the history never reloaded (#407). The stale fetch now aborts
        // at its commit point; the invalidate below re-runs from scratch.
        this.logs.reset(sessionId);
        storage.getState().resetSessionMessages(sessionId);
        this.getMessagesSync(sessionId).invalidate();
    }

    async create(credentials: AuthCredentials, encryption: Encryption) {
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();

        // Await settings sync to have fresh settings
        await this.settingsSync.awaitQueue();

        // Await profile sync to have fresh profile
        await this.profileSync.awaitQueue();
    }

    async restore(credentials: AuthCredentials, encryption: Encryption) {
        // NOTE: No awaiting anything here, we're restoring from a disk (ie app restarted)
        this.credentials = credentials;
        this.encryption = encryption;
        this.anonID = encryption.anonID;
        this.serverID = parseToken(credentials.token);
        await this.#init();
    }

    async #init() {

        // App-side queue release valve: sends the head queued draft when a
        // session's turn completes. MUST be wired here (shared by create AND
        // restore) — it used to live only in create(), which runs solely on a
        // fresh login, so every normal boot with stored credentials (i.e. any
        // reload, including every relay switch) came up with NO release valve
        // and queued messages sat forever. Lazy import — the module reads
        // storage + sync only at runtime, avoiding a static cycle.
        // The second hook cancels an accepted turn whose draft the user
        // removed while its POST was in flight (#134) — the same relay
        // control-lane cancel sessionAbort uses, keyed on the ack's turnId.
        void import('@/-session/draftQueueRelease').then(({ initDraftQueueRelease }) => {
            initDraftQueueRelease(
                (sessionId, text, localId, attachments) => this.sendMessage(sessionId, text, {
                    source: 'chat',
                    localId,
                    // A draft's stashed images (#650) — the release path only
                    // gets here when none of them have gone missing.
                    ...(attachments && attachments.length > 0 ? { attachments: attachments as never } : {}),
                }),
                async (sessionId, turnId) => {
                    const v2link = storage.getState().sessions[sessionId]?.metadata?.v2;
                    if (!v2link?.sessionId) throw new Error('session has no relay link');
                    await v2CancelTurn(v2link.relay, v2link.sessionId, turnId);
                },
            );
        });

        // Invalidate sync
        log.log('🔄 #init: Invalidating all syncs');
        this.sessionsSync.invalidate();
        this.settingsSync.invalidate();
        this.profileSync.invalidate();
        this.machinesSync.invalidate();
        this.pushTokenSync.invalidate();
        this.nativeUpdateSync.invalidate();

        // Mark UI ready as soon as sessions load. Machines sync may hang
        // when encryption keys are unavailable (e.g. V1 auth fallback) —
        // let it resolve in the background instead of blocking the UI.
        this.sessionsSync.awaitQueue().then(() => {
            storage.getState().applyReady();
        }).catch((error) => {
            console.error('Failed to load sessions:', error);
            // Still mark ready so the UI doesn't stay on a blank screen forever
            storage.getState().applyReady();
        });
    }


    onSessionVisible = (sessionId: string) => {
        // The demo session is local-only (no encryption/backend) — fixtures are
        // injected client-side; never fetch/clobber it.
        if (isDemoSession(sessionId)) return;
        this.getMessagesSync(sessionId).invalidate();

        // Mark this session most-recently-viewed; unloads stale background
        // sessions' messages when limitSessionMemory is on (memory).
        storage.getState().noteSessionVisible(sessionId);

        // Voice: the focused session is where spoken requests go.
        voiceHooks.onSessionFocus(sessionId);

        // Also refresh the project's git status resource for this session
        invalidateGitStatus(sessionId);
    }

    // Forward-sync for the open-session backstop repair loop. Refreshes BOTH the
    // messages AND the session-list metadata, since a dropped live poke can
    // strand either: messages (no streamed reply) or metadata (title stuck on
    // "New chat", stale joy__state). No single-session GET exists, so the title
    // refresh piggybacks on the global sessions fetch — InvalidateSync coalesces
    // it and it only runs while the user watches a live turn. No git (too heavy
    // for a ~10–15s loop).
    backstopSyncSession = (sessionId: string) => {
        if (isDemoSession(sessionId)) return;
        this.getMessagesSync(sessionId).invalidate();
        this.sessionsSync.invalidate();
    }

    // One-shot session-metadata refresh when a chat is opened, so a title that
    // missed its live `update-session` event (stuck on "New chat") is corrected
    // on open / switch-back. onSessionVisible refreshes messages+git but is also
    // called per incoming message, so the heavier sessions fetch can't live
    // there. Coalesced by InvalidateSync.
    refreshOpenSessionMeta = () => {
        this.sessionsSync.invalidate();
    }

    // ── v2 live driver ────────────────────────────────────────────────────
    // Sessions ride the relay's SSE doorbell (content-free pokes) with a poll
    // fallback, both of which simply invalidate the message sync — so the
    // fetch/reducer pipeline is the same whichever signal fires.
    //
    // The driver's state is a machine (liveDriverMachine.ts): every stream
    // attempt is a generation, and an event from a retired one is ignored —
    // so a stop/start inside the reconnect window can no longer let the old
    // timer open a SECOND stream over the new driver's (#408). What lives
    // here is only the world the state names: the open stream, the timers.
    private live: LiveDriverState = initialLiveDriver();
    private v2StreamStop: (() => void) | null = null;
    private v2PollTimer: ReturnType<typeof setInterval> | null = null;
    private v2ReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private v2SessionIdIndex(): Map<string, string> {
        const idx = new Map<string, string>(); // v2SessionId → local session id
        for (const [sid, s] of Object.entries(storage.getState().sessions)) {
            const v2 = (s as { metadata?: { v2?: { sessionId?: string } } }).metadata?.v2?.sessionId;
            if (v2) idx.set(v2, sid);
        }
        return idx;
    }

    /** One step: apply the event, make the world match, publish the indicator. */
    private liveSend(ev: LiveDriverEvent) {
        const prev = this.live;
        this.live = nextLiveDriver(prev, ev);
        const c = this.live.conn;
        if (c !== prev.conn) {
            if (this.v2ReconnectTimer) { clearTimeout(this.v2ReconnectTimer); this.v2ReconnectTimer = null; }
            if (c.kind === 'stopped' || c.kind === 'connecting') { this.v2StreamStop?.(); this.v2StreamStop = null; }
            if (c.kind === 'connecting') this.openV2Stream(c.gen);
            if (c.kind === 'polling_reconnect') {
                const gen = c.gen;
                this.v2ReconnectTimer = setTimeout(() => {
                    this.v2ReconnectTimer = null;
                    this.liveSend({ type: 'retry_due', gen, now: Date.now() });
                }, Math.max(0, c.retryAt - Date.now()));
            }
        }
        this.publishIndicator();
    }

    private openV2Stream(gen: number) {
        const invalidateFor = (v2SessionId: string) => {
            const sid = this.v2SessionIdIndex().get(v2SessionId);
            if (sid) this.getMessagesSync(sid).invalidate();
        };
        // The SSE doorbell is a LATENCY WIN, not the connection. It needs a
        // streaming fetch body (res.body.getReader), which React Native does
        // not have — so on native it can never open, and reporting its state as
        // the app's left the phone pulsing "connecting" forever while data
        // flowed perfectly through the poll. The indicator reports what
        // actually carries data (indicatorOf): a recent successful read is
        // 'connected', whichever transport delivered it.
        try {
            this.v2StreamStop = connectV2Stream({
                onHello: () => this.liveSend({ type: 'hello', gen, now: Date.now() }),
                onPoke: (v2SessionId) => {
                    invalidateFor(v2SessionId);
                    // A state poke may mean a card/presence change (bind,
                    // title, joy__state, lease death) — refresh the LIST.
                    this.sessionsSync.invalidate();
                },
                onEphemeral: (v2SessionId) => invalidateFor(v2SessionId),
                onClose: () => {
                    // Only this generation's stream is ours to forget; a
                    // retired stream's close must not drop a newer one.
                    const cur = this.live.conn;
                    if ((cur.kind === 'connecting' || cur.kind === 'streaming') && cur.gen === gen) this.v2StreamStop = null;
                    this.liveSend({ type: 'close', gen, now: Date.now() });
                },
            });
        } catch {
            // SSE unavailable — the poll carries it; the machine backs off.
            this.liveSend({ type: 'close', gen, now: Date.now() });
        }
    }

    startV2Live() {
        if (this.live.conn.kind !== 'stopped' || this.v2PollTimer) return;
        this.liveSend({ type: 'start' });
        // Poll: the baseline everywhere, and the ONLY live channel on native.
        // Its own success/failure drives the connection indicator.
        this.v2PollTimer = setInterval(() => {
            // Sessions FIRST: a bind lands the card's key envelope, and the
            // messages fetch for that session needs it (issue #3).
            this.sessionsSync.invalidate();
            // Only the session on screen (and any with a send still settling)
            // polls its messages. Polling EVERY session fetched and decrypted
            // the whole account every 2.5s, and re-anchored sessions the memory
            // limit had just evicted (#2). Everything else is woken by the SSE
            // poke or when it becomes visible.
            const viewing = storage.getState().currentViewingSessionId;
            const now = Date.now();
            for (const sid of this.v2SessionIdIndex().values()) {
                const recentSend = (this.recentSendAt.get(sid) ?? 0) > now - 60_000;
                if (sid === viewing || recentSend) this.getMessagesSync(sid).invalidate();
            }
            this.machinesSync.invalidate();
        }, POLL_INTERVAL_MS);
    }

    /** What each relay row last decrypted to — see v2/cardMemo.ts. */
    private cardMemo = new CardMemo<Session['metadata'] | null>();

    /** A read reached the relay: we are connected, whichever transport did it. */
    private noteRelayReadOk() {
        this.liveSend({ type: 'read_ok', now: Date.now() });
    }

    /** A read failed. One failure is noise (a dropped request, a radio waking);
     *  the indicator reports trouble only once nothing has landed for several
     *  poll cycles (indicatorOf). 'connecting' never showed the banner, so a
     *  phone that lost the network stayed banner-less while a cold start
     *  flashed it (#11). */
    private noteRelayReadFailed() {
        this.liveSend({ type: 'read_failed', now: Date.now() });
    }

    /** The one notion of connected, derived from the driver's state. */
    private publishIndicator() {
        const want = indicatorOf(this.live, Date.now(), POLL_INTERVAL_MS);
        if (storage.getState().socketStatus !== want) storage.getState().setSocketStatus(want);
    }

    stopV2Live() {
        this.liveSend({ type: 'stop' });
        if (this.v2PollTimer) { clearInterval(this.v2PollTimer); this.v2PollTimer = null; }
    }

    /**
     * Logout: drop the whole account scope — live stream, keys, secret,
     * per-session cursors and the in-memory account data — so nothing of the
     * previous account stays reachable in this process (#189). The singleton
     * cannot be re-created for another account without a reload (its
     * constructor wiring is not re-entrant); see initGate.
     */
    shutdown() {
        this.stopV2Live();
        this.pushLifetime.abort();
        this.masterSecret = null;
        this.machineDataKeys.clear();
        this.logs.clear();
        this.sessionMessageLocks.clear();
        this.messagesSync.clear();
        storage.getState().resetAccountData();
    }

    private getMessagesSync(sessionId: string): InvalidateSync {
        let sync = this.messagesSync.get(sessionId);
        if (!sync) {
            sync = new InvalidateSync(() => this.fetchMessages(sessionId));
            this.messagesSync.set(sessionId, sync);
        }
        return sync;
    }

    private getSessionMessageLock(sessionId: string): AsyncLock {
        let lock = this.sessionMessageLocks.get(sessionId);
        if (!lock) {
            lock = new AsyncLock();
            this.sessionMessageLocks.set(sessionId, lock);
        }
        return lock;
    }

    async sendMessage(sessionId: string, text: string, options?: SendMessageOptions): Promise<SendMessageResult> {
        this.recentSendAt.set(sessionId, Date.now());

        // Get encryption — may not be ready yet if sessions are still syncing
        let encryption = this.encryption.getSessionEncryption(sessionId);
        if (!encryption) {
            // Wait for sessions sync to complete (initializes encryption keys)
            await this.sessionsSync.awaitQueue();
            encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                console.error(`Session ${sessionId} not found after sync`);
                return { ok: false, reason: 'session encryption not ready' };
            }
        }

        // Get session data from storage
        let session = storage.getState().sessions[sessionId];
        if (!session) {
            await this.sessionsSync.awaitQueue();
            session = storage.getState().sessions[sessionId];
            if (!session) {
                console.error(`Session ${sessionId} not found in storage after sync`);
                return { ok: false, reason: 'session not found' };
            }
        }

        // Every session is a v2 session: the send travels the relay's durable
        // queue, sealed with the session content key. The daemon echoes the
        // conversation (including this prompt) back onto the card, so display
        // and history come from the read path — the send is write-only.
        const v2link = session.metadata?.v2;
        if (!v2link?.sessionId) {
            return { ok: false, reason: 'session has no v2 link' };
        }
        // B1 (security): a session stamped with a key envelope MUST seal.
        // If the envelope is present but the key will not open (wrong
        // account, corruption), REFUSE — never fall back to plaintext,
        // which would leak readable content to the relay.
        let key: Uint8Array | null = null;
        if (v2link.keyEnvelope && v2link.keyEnvelope !== 'v2:plaintext') {
            key = this.encryption.openV2SessionKey(v2link.keyEnvelope);
            if (!key) {
                console.error('[v2] session key envelope present but unopenable — refusing plaintext send');
                return { ok: false, reason: 'v2 content key unavailable (cannot seal) — refusing to send in the clear' };
            }
        } else if (v2link.keyEnvelope !== 'v2:plaintext') {
            // No envelope at all — the session has not BOUND yet (the
            // envelope arrives with the bind). Refuse rather than sending
            // in the clear; the caller retries once the card completes.
            return { ok: false, reason: 'v2 session not bound yet — no content key to seal with' };
        }
        // OPTIMISTIC: the row appears the instant you send, at 70%, and
        // brightens as it travels — 80% when the relay accepts it, 90% when the
        // machine has it (turn.receipted), 100% once the agent has it
        // (turn.started). Before this the row only appeared when the relay's
        // turn.queued came back through the 2.5s poll, which read as a lag on
        // every send and made tap-to-answer feel broken. localId doubles as the
        // relay clientIntentId: the relay's own row carries it back
        // (origin.clientIntentId → reads.ts) and reconciles INTO this row
        // rather than duplicating it, and a retry with the same id (draft
        // release) replays the first acceptance.
        const localId = options?.localId ?? randomUUID();
        // limitSessionMemory evicts the store but leaves the cursors. The
        // optimistic row below would re-create a store that LOOKS anchored,
        // so the next fetch walked forward from the old cursor and the chat
        // showed only rows after it with hasMoreOlder stuck false (#12).
        // Drop the cursors so that fetch re-anchors like a cold open.
        if (cursorsNeedReanchor(!!storage.getState().sessionMessages[sessionId], this.logs.lastSeq(sessionId) !== undefined)) {
            log.log(`💬 sendMessage: store evicted for ${sessionId} — clearing cursors so the next fetch re-anchors (#12)`);
            // Clearing the cursors is not enough on its own: a forward page
            // already in flight from the old cursor used to land afterwards
            // and put the forward cursor back — without the backward anchor —
            // so the recreated store was forward-only again. `recreated`
            // mints a fresh generation, so that page is stale at its commit
            // point (same fence as #407).
            this.logs.send(sessionId, { type: 'evicted' });
            this.logs.recreated(sessionId);
        }
        storage.getState().applyMessages(sessionId, [{
            id: localId,
            localId,
            createdAt: Date.now(),
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text },
            meta: { sentFrom: 'app', deliveryStage: 'local' },
        } as NormalizedMessage]);
        // Attachments travel beside the text: bytes sealed under the same
        // session key and uploaded first, then cited (id + display facts)
        // INSIDE the sealed message so every device and the daemon can
        // resolve them while the relay sees only opaque blobs. Any upload
        // failure drops the whole send — a prompt about a screenshot that
        // silently lost the screenshot is worse than no send.
        let attachments: V2Attachment[] = [];
        if (options?.attachments?.length) {
            try {
                attachments = await this.uploadV2Attachments(v2link.relay, v2link.sessionId, key, options.attachments);
            } catch (e) {
                console.error('[v2] attachment upload failed', e);
                // Say WHY. The reason used to go only to console.error, which is
                // invisible on a phone — "uploads can't be uploaded from mobile"
                // was reported with no way to tell a failed file read from a
                // rejected POST from a hash mismatch. The detail is a status
                // code or an error message, never file content.
                const detail = e instanceof V2ApiError
                    ? `HTTP ${e.status}${e.code ? ` · ${e.code}` : ''}`
                    : e instanceof Error ? `${e.name}: ${e.message}` : String(e);
                Modal.alert(
                    e instanceof AttachmentRejected ? t('imageUpload.fileTooLargeTitle') : t('imageUpload.uploadFailedTitle'),
                    e instanceof AttachmentRejected
                        ? e.message
                        : `${t('imageUpload.uploadFailedMessage', { count: options.attachments.length })}\n\n${detail}`,
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
                storage.getState().dismissLocalMessage(sessionId, localId);
                return { ok: false, reason: `attachment upload failed: ${e instanceof Error ? e.message : e}` };
            }
        }
        let ack: { messageId: string; turnId: string };
        try {
            const ciphertext = sealV2Content(text, key, attachments);
            ack = await v2SendCiphertext(v2link.relay, v2link.sessionId, ciphertext, localId, attachments.map(a => a.id));
            // Accepted: 80%, and the ack names the turn — bind it now so the
            // receipted/started events can find this row even before the
            // relay's own turn.queued row has been read back.
            storage.getState().bindTurnToLocal(sessionId, localId, ack.turnId);
            storage.getState().applyDeliveryStage(sessionId, { localId }, 'relay');
        } catch (e) {
            console.error('[v2] send failed', e);
            // A failed RESPONSE is not a failed send: if a poll already
            // reconciled this row with the relay's own event-log row (server
            // seq / stage past local), the relay accepted the prompt and the
            // agent may be running it. Dismissing the row then deleted a
            // delivered prompt with the forward cursor already past it, so no
            // sync ever restored it (#410). Treat the acknowledgment as the ack.
            const row = this.localRow(sessionId, localId);
            if (isSendAcknowledged(row)) {
                log.log(`💬 sendMessage: POST failed for ${localId} but the event log already acknowledged it — keeping the row (#410)`);
                storage.getState().applyDeliveryStage(sessionId, { localId }, 'relay');
                // The turn is whatever the event log bound to the row, if it
                // has yet — a pending removal needs it to cancel (#134).
                const turnId = row?.turnId;
                void import('@/-session/draftQueueRelease').then(({ notifyOutboxAcked }) => {
                    notifyOutboxAcked(sessionId, [{ localId, turnId }]);
                });
                return { ok: true, localId, turnId };
            }
            // The text goes back to the composer (caller); the ghost row must go.
            storage.getState().dismissLocalMessage(sessionId, localId);
            // 429 session_event_budget_exhausted (#613): the relay refuses new
            // prompts once the session's event budget is spent — retrying never
            // clears it, so the reason says what to do instead of "failed".
            // Mapped here, once, for every send path (composer, drafts, cards).
            if (e instanceof V2ApiError && e.code === 'session_event_budget_exhausted') {
                return { ok: false, reason: t('errors.sessionFull') };
            }
            return { ok: false, reason: `v2 send failed: ${e instanceof Error ? e.message : e}` };
        }
        // The relay's accepted response IS the durable ack: a draft released
        // with this localId may now leave the draft queue — or, if the user
        // removed it while the POST was in flight, cancel the turn it became.
        void import('@/-session/draftQueueRelease').then(({ notifyOutboxAcked }) => {
            notifyOutboxAcked(sessionId, [{ localId, turnId: ack.turnId }]);
        });
        return { ok: true, localId, turnId: ack.turnId };
    }

    /** The store's row for one of this client's sends, by localId. */
    private localRow(sessionId: string, localId: string): { seq?: number | null; deliveryStage?: string; turnId?: string } | undefined {
        const store = storage.getState().sessionMessages[sessionId];
        const internalId = store?.reducerState.localIds.get(localId);
        return internalId ? (store?.messagesMap[internalId] as { seq?: number | null; deliveryStage?: string; turnId?: string } | undefined) : undefined;
    }

    /** Drop every trace of a session the relay no longer lists (#406): its
     *  message synchronizer, cursors, lock, send/strike bookkeeping, git
     *  status, and the stored card + messages. */
    private forgetSession(sessionId: string) {
        // Invalidate FIRST, with a generation that stays unique: a page in
        // flight for this session must find itself stale at its commit point
        // and write nothing after the delete below. The old per-session
        // counter reset to the reusable default 0 on forget — the very value
        // an in-flight fetch had captured — so that page landed after the
        // removal and restored the messages and cursor. SessionLogs mints
        // every generation from one counter, so a re-listed session can
        // never revalidate an old token.
        this.logs.forget(sessionId);
        this.messagesSync.get(sessionId)?.stop();
        this.messagesSync.delete(sessionId);
        this.sessionMessageLocks.delete(sessionId);
        this.recentSendAt.delete(sessionId);
        this.unopenableStrikes.delete(sessionId);
        this.unopenableGaps.delete(sessionId);
        this.publishUnopenableGaps(sessionId);
        // #406: the fetch generation is never forgotten (a reused counter revalidated old requests); the git resource is cleared.
        // The project's git status needs the session's metadata to find its
        // key, so both resource clears run BEFORE the store forgets the
        // session; a screen still mounted on one of these keys keeps its
        // subscription and sees an idle entry (sync/resource.ts `remove`).
        clearGitStatusForSession(sessionId);
        forgetSessionFiles(sessionId);
        storage.getState().deleteSession(sessionId);
    }

    /** Read, seal and upload each picked file; returns the citations to embed
     *  in the message. Throws on the first failure (the caller drops the send). */
    private async uploadV2Attachments(relay: string, v2SessionId: string, key: Uint8Array | null, picked: AttachmentPreview[]): Promise<V2Attachment[]> {
        const out: V2Attachment[] = [];
        for (const a of picked) {
            const bytes = await readFileBytes(a.uri);
            // The picker's pre-check trusts a self-reported size (0 when the
            // platform gives none; web paste/drop skips it entirely) — the
            // bytes we just read are the truth, and the relay would accept up
            // to 32MB, so the advertised cap is enforced HERE.
            if (bytes.length === 0) throw new AttachmentRejected(t('imageUpload.emptyFileMessage', { name: attachmentDisplayName(a) }));
            if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentRejected(t('imageUpload.fileTooLargeMessage', { name: attachmentDisplayName(a), maxMb: MAX_ATTACHMENT_MB }));
            const sealed = sealV2Bytes(bytes, key);
            // Pass a TypedArray, NOT `.buffer`. expo-crypto's native digest casts
            // its data argument to TypedArray and throws on a bare ArrayBuffer —
            // "The 3rd argument cannot be cast to type TypedArray" — so every
            // upload from iOS/Android failed here while web, whose digest accepts
            // either, worked (2026-09-03). `.slice()` still gives a standalone
            // Uint8Array<ArrayBuffer>, which is what the type wanted all along.
            const hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, sealed.slice());
            const { attachmentId } = await v2UploadAttachment(relay, v2SessionId, sealed, encodeHex(new Uint8Array(hash)).toLowerCase());
            out.push({
                id: attachmentId,
                name: a.name,
                size: bytes.length,
                ...(a.mimeType ? { mime: a.mimeType } : {}),
                ...(a.source ? { source: a.source } : {}),
                ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {}),
                ...(a.thumbhash ? { thumbhash: a.thumbhash } : {}),
            });
        }
        return out;
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);
        // Recorded BEFORE the sync is asked to run: a delta that lands while
        // a push is in flight rides into the next dirty state, never dropped.
        this.settingsSend({ type: 'local_change', delta });
        this.settingsSync.invalidate();

        // Toggling mobile push on/off re-runs token (de)registration immediately.
        if ('notificationsMobile' in delta) this.pushTokenSync.invalidate();
        // Turning desktop notifications on prompts for permission right away.
        if (delta.notificationsDesktop && Platform.OS === 'web') void ensureDesktopNotificationPermission();
    }

    // Mod 13: replace the entire settings payload (used by the raw settings
    // editor). Unlike applySettings(), this does NOT merge with the previous
    // settings — keys the user removed in the editor are actually dropped.
    // The raw object is run through settingsParse() so known fields keep their
    // defaults and any kept unknown/deprecated keys are preserved verbatim,
    // while removed keys stay removed. The pending deltas are replaced
    // wholesale (local_replace) so stale deltas can't re-introduce a removed
    // key on the next sync push.
    replaceSettings = (raw: unknown) => {
        const parsed = settingsParse(raw);
        storage.getState().applySettingsRaw(parsed);
        this.settingsSend({ type: 'local_replace', settings: { ...parsed } as Partial<Settings> });
        this.settingsSync.invalidate();
    }

    refreshProfile = async () => {
        await this.profileSync.invalidateAndAwait();
    }

    //
    // Private
    //

    private fetchSessions = async () => {
        if (!this.credentials) return;

        // Sessions come ENTIRELY from the v2 relay: the daemon publishes each
        // session's sealed CARD (metadata under the session content key) and
        // the relay merges presence from lease liveness — the same authority
        // its own work queue trusts.
        const { v2 } = await import('./v2/api');
        const { openCard } = await import('./v2/card');
        const { v2ActiveAt } = await import('./v2/liveness');
        // This request runs on every poll tick, so it doubles as the connection
        // probe — no extra traffic, and it reports the transport that actually
        // carries data rather than the SSE stream native can never open.
        // The base the list is fetched from IS the relay every card must be
        // addressed to. Captured before the request: it used to be stamped
        // with getServerUrl() after the fact, so with the v2 override on
        // relay B the cards listed from B sent all their traffic to A (#409).
        const relayUrl = getV2BaseUrl();
        let rows: Awaited<ReturnType<typeof v2.listSessions>>['sessions'];
        try {
            ({ sessions: rows } = await v2.listSessions());
            this.noteRelayReadOk();
        } catch (e) {
            this.noteRelayReadFailed();
            throw e; // InvalidateSync retries
        }

        // Register a (legacy, key-less) session encryption per id: v2 message
        // content never uses it (rows arrive decrypted via __v2Plain), but the
        // engine's lookups expect an entry to exist.
        const sessionKeys = new Map<string, Uint8Array | null>();
        for (const row of rows) sessionKeys.set(row.sessionId, null);
        await this.encryption.initializeSessions(sessionKeys);

        const decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
        const memo = this.cardMemo;
        memo.hits = 0; memo.misses = 0;
        for (const row of rows) {
            // Same ciphertext under the same envelope is the same card: reuse
            // last tick's result and do no crypto for it. At idle that is
            // every row — this poll used to re-open every key and every card
            // on the account every 2.5 s whether anything had changed or not.
            const remembered = memo.lookup(row);
            // Session content key: envelope sealed to the account content key.
            const key = remembered.hit || !row.sessionKeyEnvelope ? null : this.encryption.openV2SessionKey(row.sessionKeyEnvelope);

            // The card IS the metadata. A session with no card yet (spawn still
            // provisioning, or a pre-card daemon) gets a minimal one carrying
            // the v2 link — enough for the spawn poller and the reads engine.
            let metadata: Session['metadata'] | null = remembered.hit
                ? remembered.value
                : (openCard(row.encryptedMetadata, key) as Session['metadata'] | null);
            if (!remembered.hit) memo.remember(row, metadata);
            if (!metadata) {
                metadata = {
                    path: '',
                    host: '',
                    machineId: row.daemonId,
                    v2: { sessionId: row.sessionId, relay: relayUrl, keyEnvelope: row.sessionKeyEnvelope ?? '', localSessionId: row.localSessionId ?? undefined },
                } as unknown as Session['metadata'];
            } else {
                // The card's v2 link may predate fields (or the relay moved) —
                // the ROW is authoritative for linkage (see sessionLink.ts).
                (metadata as Record<string, unknown>).v2 = v2LinkForRow(
                    row,
                    (metadata as { v2?: Record<string, unknown> }).v2,
                    relayUrl,
                );
            }

            const existing = storage.getState().sessions[row.sessionId];
            decryptedSessions.push({
                id: row.sessionId,
                tag: row.sessionId,
                seq: Number(row.revision),
                metadata,
                metadataVersion: Number(row.revision),
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                active: row.state === 'provisioning' || row.state === 'starting' || row.state === 'active',
                // Lease liveness is the heartbeat (see v2/liveness.ts): an idle
                // session stays fresh while its daemon is online.
                activeAt: v2ActiveAt(row, existing?.activeAt),
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                lastMessage: null,
                thinking: existing?.thinking ?? false,
                thinkingAt: existing?.thinkingAt ?? 0,
                presence: row.online ? 'online' : (row.lastTurnAt ?? row.updatedAt),
            } as unknown as (Omit<Session, 'presence'> & { presence?: "online" | number }));
        }

        // The list is the account's authoritative snapshot on this relay, but
        // applySessions only MERGES — a session deleted elsewhere kept its
        // card and its message poll forever (#406). Reconcile absent ids.
        const stale = staleSessionIds(storage.getState().sessions, rows.map(r => r.sessionId), isDemoSession);
        this.applySessions(decryptedSessions);
        for (const sid of stale) this.forgetSession(sid);
        memo.prune(rows.map(r => r.sessionId));
        if (stale.length > 0) log.log(`📥 fetchSessions: removed ${stale.length} session(s) no longer listed by the relay (#406)`);
        // An idle tick is all hits; the line only earns a read when it did work.
        if (memo.misses > 0) log.log(`📥 fetchSessions completed - ${decryptedSessions.length} v2 sessions, decrypted ${memo.misses}, reused ${memo.hits}`);
    }

    public refreshMachines = async () => {
        return this.fetchMachines();
    }

    public refreshSessions = async () => {
        return this.sessionsSync.invalidateAndAwait();
    }

    public getCredentials() {
        return this.credentials;
    }

    private fetchMachines = async () => {
        if (!this.credentials) return;

        console.log('📊 Sync: Fetching machines (v2)...');
        // Machines over v2: the relay serves the account's machine records
        // (delegating internally) and merges leaseAlive from the same lease
        // table its work queue runs on.
        const { v2 } = await import('./v2/api');
        const data = (await v2.listMachines()).machines;
        console.log(`📊 Sync: Fetched ${Array.isArray(data) ? data.length : 0} machines from v2`);
        const machines = data as unknown as Array<{
            id: string;
            metadata: string;
            metadataVersion: number;
            daemonState?: string | null;
            daemonStateVersion?: number;
            dataEncryptionKey?: string | null; // Add support for per-machine encryption keys
            seq: number;
            active: boolean;
            activeAt: number;  // Changed from lastActiveAt
            createdAt: number;
            updatedAt: number;
            leaseAlive?: boolean;
        }>;

        // First, collect and decrypt encryption keys for all machines
        const machineKeysMap = new Map<string, Uint8Array | null>();
        for (const machine of machines) {
            if (machine.dataEncryptionKey) {
                const decryptedKey = await this.encryption.decryptEncryptionKey(machine.dataEncryptionKey);
                if (!decryptedKey) {
                    console.error(`Failed to decrypt data encryption key for machine ${machine.id}`);
                    continue;
                }
                machineKeysMap.set(machine.id, decryptedKey);
                this.machineDataKeys.set(machine.id, decryptedKey);
            } else {
                machineKeysMap.set(machine.id, null);
            }
        }

        // Initialize machine encryptions
        await this.encryption.initializeMachines(machineKeysMap);
        // The machine plane just became usable for these machines: a resource
        // that answered `unavailable` for lack of a machine context (a screen
        // that mounted before this sync landed) is read again now, rather
        // than waiting for a focus or reconnect that may never come.
        if (Array.from(machineKeysMap.values()).some((k) => k !== null)) resources.onContextReady();

        // Process all machines first, then update state once
        const decryptedMachines: Machine[] = [];

        for (const machine of machines) {
            // Get machine-specific encryption (might exist from previous initialization)
            const machineEncryption = this.encryption.getMachineEncryption(machine.id);
            if (!machineEncryption) {
                console.error(`Machine encryption not found for ${machine.id} - this should never happen`);
                continue;
            }

            try {

                // Use machine-specific encryption (which handles fallback internally)
                const metadata = machine.metadata
                    ? await machineEncryption.decryptMetadata(machine.metadataVersion, machine.metadata)
                    : null;

                const daemonState = machine.daemonState
                    ? await machineEncryption.decryptDaemonState(machine.daemonStateVersion || 0, machine.daemonState)
                    : null;

                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    leaseAlive: machine.leaseAlive,
                    metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState,
                    daemonStateVersion: machine.daemonStateVersion || 0
                });
            } catch (error) {
                console.error(`Failed to decrypt machine ${machine.id}:`, error);
                // Still add the machine with null metadata
                decryptedMachines.push({
                    id: machine.id,
                    seq: machine.seq,
                    createdAt: machine.createdAt,
                    updatedAt: machine.updatedAt,
                    active: machine.active,
                    activeAt: machine.activeAt,
                    leaseAlive: machine.leaseAlive,
                    metadata: null,
                    metadataVersion: machine.metadataVersion,
                    daemonState: null,
                    daemonStateVersion: 0
                });
            }
        }

        // Replace entire machine state with fetched machines
        storage.getState().applyMachines(decryptedMachines, true);
        log.log(`🖥️ fetchMachines completed - processed ${decryptedMachines.length} machines`);
    }

    /** One step of the settings machine; the persisted pending deltas are
     *  its projection (what a restart must still push). */
    private settingsSend(ev: SettingsSyncEvent): SettingsSyncState {
        this.settingsState = nextSettingsSync(this.settingsState, ev);
        savePendingSettings(pendingOf(this.settingsState));
        return this.settingsState;
    }

    /** A failed push waits out its backoff, then the sync is asked to run
     *  again. Bounded (settingsSyncMachine.failedBackoffMs), unlike the
     *  InvalidateSync backoff a throw would have fallen into. */
    private armSettingsRetry(s: SettingsSyncState) {
        if (this.settingsRetryTimer) { clearTimeout(this.settingsRetryTimer); this.settingsRetryTimer = null; }
        if (s.kind !== 'failed') return;
        this.settingsRetryTimer = setTimeout(() => {
            this.settingsRetryTimer = null;
            if (this.settingsSend({ type: 'tick', now: Date.now() }).kind === 'dirty') this.settingsSync.invalidate();
        }, Math.max(0, s.retryAt - Date.now()));
        (this.settingsRetryTimer as { unref?: () => void }).unref?.();
    }

    /**
     * Settings, both directions, against ONE sealed blob on the relay.
     *
     * This used to clear the pending queue and return — the upload half never
     * survived the happy-server retirement, and there was no endpoint to
     * upload to. Every "synced" setting was device-local in fact while the
     * schema said otherwise: a pin made on a phone was invisible on a laptop.
     *
     * Pull first, then replay the local deltas ON TOP, then push. That order
     * is what makes two devices adding a pin each end with both pins rather
     * than whichever wrote last. The relay never sees any of it: the blob is
     * sealed with the account key, like machine metadata.
     *
     * The phases are the settings machine's (settingsSyncMachine.ts). It
     * used to capture `pending` before the push and clear the field after —
     * a toggle made during the await was dropped and stayed device-local
     * until the next unrelated change. Now a change during a push becomes
     * the next dirty state and is pushed right after.
     */
    private syncSettings = async () => {
        if (!this.credentials) return;

        const remote = await v2.accountSettings();
        await this.absorbRemoteSettings(remote.settings, remote.version);

        let s = this.settingsSend({ type: 'pull_ok', version: remote.version, now: Date.now() });
        if (s.kind !== 'pushing') return; // nothing pending, or a failed push still backing off

        // The pull may have replaced the store with the relay's copy, so the
        // deltas this device has not yet pushed go back on top before we seal.
        storage.getState().applySettingsLocal(s.pending);
        let expectedVersion = storage.getState().settingsVersion ?? 0;
        for (;;) {
            try {
                const version = await this.pushSettings(expectedVersion);
                s = this.settingsSend({ type: 'push_ok', version });
                break;
            } catch (e) {
                if (!(e instanceof V2ApiError) || e.status !== 409) {
                    // Kept, backed off, retried by the machine's own timer —
                    // not thrown: the deltas are safe in `failed`, and the
                    // pull half of this run already succeeded.
                    this.armSettingsRetry(this.settingsSend({ type: 'push_failed', now: Date.now() }));
                    log.log(`⚙️ settings push failed, retrying later: ${String(e)}`);
                    return;
                }
                // Lost a race with another device. The relay hands back the
                // winner's blob with the 409, so one merge and one retry
                // settles it — no second fetch to discover what we lost to.
                // A SECOND loss parks the deltas (conflicted) for the next
                // run rather than throwing.
                const body = e.body as { version?: number; settings?: string | null } | null;
                const winnerVersion = body?.version ?? 0;
                await this.absorbRemoteSettings(body?.settings ?? null, winnerVersion, { force: true });
                s = this.settingsSend({ type: 'push_conflict', winnerVersion });
                if (s.kind !== 'pushing' && s.kind !== 'conflicted') return;
                storage.getState().applySettingsLocal(s.pending);
                if (s.kind === 'conflicted') return;
                expectedVersion = winnerVersion;
            }
        }
        // A change landed while the push was in flight: push it now, not on
        // the next poll.
        if (s.kind === 'dirty') this.settingsSync.invalidate();
    }

    /** Open a sealed blob from the relay and adopt it, unless what we hold is
     *  already at least as new. `force` is for the 409 path, where the version
     *  we are adopting can equal one we have already seen locally. */
    private absorbRemoteSettings = async (sealed: string | null, version: number, opts?: { force?: boolean }) => {
        if (!sealed) return;
        const opened = await this.encryption.decryptRaw(sealed);
        if (!opened) return; // a blob this device cannot open: leave ours alone
        if (opts?.force) {
            storage.getState().applySettingsRaw(settingsParse(opened));
            return;
        }
        storage.getState().applySettings(settingsParse(opened), version);
    }

    private pushSettings = async (expectedVersion: number) => {
        const sealed = await this.encryption.encryptRaw(
            settingsToSyncPayload(storage.getState().settings));
        const saved = await v2.putAccountSettings(sealed, expectedVersion);
        // Record the version the relay assigned, so the next push is
        // conditional on the right one.
        storage.getState().applySettings(storage.getState().settings, saved.version);
        return saved.version;
    }

    private fetchProfile = async () => {
        if (!this.credentials) return;

        const data = await v2.accountProfile();
        const parsedProfile = profileParse(data);

        // Log profile data for debugging
        console.log('profile', JSON.stringify({
            id: parsedProfile.id,
            timestamp: parsedProfile.timestamp,
            firstName: parsedProfile.firstName,
            lastName: parsedProfile.lastName,
            hasAvatar: !!parsedProfile.avatar,
        }));

        // Apply profile to storage
        storage.getState().applyProfile(parsedProfile);
    }

    // joy-relay has no native-version endpoint, so there is never a forced
    // store update to surface; keep the store slot cleared.
    private fetchNativeUpdate = async () => {
        storage.getState().applyNativeUpdateStatus(null);
    }

    private fetchMessages = async (sessionId: string) => {
        log.log(`💬 fetchMessages starting for session ${sessionId} - acquiring lock`);
        const lock = this.getSessionMessageLock(sessionId);
        await lock.inLock(async () => {
            const encryption = this.encryption.getSessionEncryption(sessionId);
            if (!encryption) {
                log.log(`💬 fetchMessages: Session encryption not ready for ${sessionId}, will retry`);
                throw new Error(`Session encryption not ready for ${sessionId}`);
            }
            // Generation captured INSIDE the lock, alongside the cursor read:
            // a reset that lands while a page is in flight makes both stale
            // together (#407). The commit guards below throw StaleFetchError;
            // the reset's own invalidate re-runs this command from scratch.
            const gen = this.logs.gen(sessionId);
            try {
                await this.fetchMessagesLocked(sessionId, encryption, gen);
            } catch (e) {
                if (e instanceof StaleFetchError) {
                    log.log(`💬 fetchMessages: ${sessionId} was reset mid-fetch — discarding the stale page (#407)`);
                    return;
                }
                throw e;
            }
        });
    }

    private fetchMessagesLocked = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        gen: number,
    ) => {
        // The log machine decides the branch (sessionLogMachine.ts): a cold
        // session anchors at the newest page; an anchored one syncs forward;
        // an evicted one re-anchors only when it is on screen — re-anchoring
        // it on a background poll defeated the memory limit (#2).
        if (!storage.getState().sessionMessages[sessionId]) this.logs.send(sessionId, { type: 'evicted' });
        const viewing = storage.getState().currentViewingSessionId === sessionId;
        const branch = fetchBranchOf(this.logs.send(sessionId, { type: 'fetch_started', gen, viewing }));
        if (branch === 'skip') return;
        try {
            if (branch === 'forward') {
                // Forward incremental sync. Used after reconnect, invalidate,
                // or any subsequent visit. Pulls messages newer than what we
                // already have — bounded by the re-anchor inside (a huge gap
                // stops replaying and jumps to the newest page instead).
                await this.fetchForwardSince(sessionId, encryption, this.logs.lastSeq(sessionId) ?? 0, gen);
            } else {
                // Initial load (or a re-anchor after the store was evicted:
                // forward-replaying the gap would rebuild history we no longer
                // even hold). Pull only the most recent page so the user can
                // start chatting immediately. Older history streams in lazily
                // through loadOlderMessages() when the user scrolls up — and
                // also through a background prefetch kicked off below, so the
                // history fills in even when the user doesn't scroll.
                //
                // Previously this method walked forward from seq=0 until every
                // page had been fetched and decrypted, which blocked the chat
                // from displaying anything for sessions with thousands of
                // messages. The user's reported pain point was "opening a long
                // session feels frozen" — this is the fix.
                if (branch === 'reanchor') log.log(`💬 fetchMessages: store evicted for ${sessionId} — re-anchoring at latest page`);
                await this.fetchInitialLatestPage(sessionId, encryption, gen);
            }
        } catch (e) {
            this.logs.send(sessionId, { type: 'fetch_failed', gen });
            throw e;
        }

        this.assertFresh(sessionId, gen);
        storage.getState().applyMessagesLoaded(sessionId);
        log.log(`💬 fetchMessages completed for session ${sessionId}`);

        if (branch !== 'forward') {
            // Fire-and-forget. The chat is interactive at this point;
            // background pages stream in without blocking either the
            // surrounding lock or the UI. loadOlderMessages takes the
            // same lock internally, so the loop naturally serialises
            // with on-scroll triggers and live-stream pokes.
            void this.prefetchOlderMessagesInBackground(sessionId);
        }
    }

    /** Commit guard for the message pipeline: throws once a reset has
     *  superseded the fetch that captured `gen` (#407). */
    private assertFresh(sessionId: string, gen: number) {
        if (this.logs.isStale(sessionId, gen)) throw new StaleFetchError(sessionId);
    }

    private prefetchOlderMessagesInBackground = async (sessionId: string) => {
        const SLEEP_BETWEEN_PAGES_MS = 500;
        // Cap the background prefetch: enough recent scrollback (~300
        // messages) for casual scrolling and the prompt scrubber, without
        // hammering the server for a session's entire history right after
        // the chat opens (a 20k-message session would otherwise mean 200
        // GETs + decrypts). Deeper history loads on demand via the
        // on-scroll path (onStartReached → loadOlderMessages).
        const MAX_PREFETCH_PAGES = 3;
        // While loadOlderMessages handles the actual work, this loop is what
        // keeps it going without user input. We keep stepping until either:
        //   - we hit the prefetch page cap (scroll covers the rest), or
        //   - the server says there is no more older history, or
        //   - the session is no longer present in the store (user navigated
        //     away and the session was unloaded), or
        //   - we hit seq = 1 (the very first message), or
        //   - the encryption key is gone (logged out).
        // The loop yields between pages to keep the UI thread responsive
        // and to spread out server load.
        for (let page = 0; page < MAX_PREFETCH_PAGES; page++) {
            const sessionMessages = storage.getState().sessionMessages[sessionId];
            if (!sessionMessages || !sessionMessages.hasMoreOlder) {
                return;
            }
            if (!this.encryption.getSessionEncryption(sessionId)) {
                return;
            }
            const oldestSeq = this.logs.oldestSeq(sessionId);
            if (oldestSeq === undefined || oldestSeq <= 1) {
                return;
            }

            try {
                await this.loadOlderMessages(sessionId);
            } catch (error) {
                log.log(`💬 prefetchOlderMessagesInBackground: error for ${sessionId}, stopping: ${String(error)}`);
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, SLEEP_BETWEEN_PAGES_MS));
        }
    }

    private fetchInitialLatestPage = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        gen: number,
    ) => {
        // Page backward until the chat has something to SHOW. A raw 100-row
        // page can be almost entirely invisible lifecycle events (turn-start/
        // end, usage — a busy joy session produced 98/100), which opened a
        // long-running session onto a near-EMPTY chat ("prior sessions aren't
        // loading", 2026-07-09). Keep pulling older pages until the store has
        // a screenful of renderable messages or we hit the page budget —
        // scroll-up paging takes over from there.
        const MIN_RENDERABLE = 20;
        const MAX_INITIAL_PAGES = 5;
        // COLLECT pages first, apply ONCE in ascending seq order. The first
        // version of this loop applied each page as it arrived — newest page
        // first — feeding the ORDER-DEPENDENT reducer newer rows before older
        // ones. On any session that needed page 2+ (lifecycle-heavy joy
        // sessions, i.e. the busiest ones), the reducer state corrupted and
        // the chat froze behind reality with no error ("new messages never
        // appeared", fny agent2, 2026-07-12). The renderable-count probe uses
        // a cheap normalize pass instead of the store.
        let beforeSeq = SEQ_BACKWARD_INITIAL_SENTINEL;
        let maxSeq = 0;
        let minSeq = Number.POSITIVE_INFINITY;
        let hasMore = false;
        const collected: ApiMessage[] = [];
        const lifecycle: V2Lifecycle[] = [];
        const v2ctx = this.v2ReadCtx(sessionId);
        if (!v2ctx) throw new Error(`Failed to fetch initial page for ${sessionId}: no v2 link`);
        for (let page = 0; page < MAX_INITIAL_PAGES; page++) {
            let data: { messages: ApiMessage[]; hasMore: boolean; unopenable?: number; unopenableSeqs?: number[]; lifecycle: V2Lifecycle[]; cursor?: number };
            try {
                data = await v2MessagesBefore({ ...v2ctx, beforeSeq });
                this.assertFresh(sessionId, gen); // reset while this page was in flight (#407)
                // Same rule as the forward path (#3): with no key yet, a page
                // whose sealed rows did not open must not anchor history —
                // throwing here retries page 0 once the card's envelope lands.
                if ((data.unopenable ?? 0) > 0) {
                    this.sessionsSync.invalidate(); // fire only: awaiting queue idleness can starve under the 2.5s poll (Astra, a979cfef)
                    const strikes = v2ctx.key ? (this.unopenableStrikes.get(sessionId) ?? 0) + 1 : 0;
                    if (!v2ctx.key || strikes <= Sync.MAX_UNOPENABLE_RETRIES) {
                        this.unopenableStrikes.set(sessionId, strikes);
                        throw new Error(`Initial page of ${sessionId}: ${data.unopenable} sealed row(s) could not be opened (${v2ctx.key ? `key present, attempt ${strikes}` : 'no content key yet'}) — retrying`);
                    }
                    // The rows that failed stay a recoverable gap — their own
                    // runs, not the page's span: the reader scanned (and
                    // trimmed) rows below the ones it returned (#128).
                    const runs = Sync.sealedSpans(data, typeof data.cursor === 'number' ? data.cursor - 1 : 0, Number.isFinite(beforeSeq) ? beforeSeq - 1 : Number.MAX_SAFE_INTEGER);
                    this.recordUnopenableGaps(sessionId, runs, v2ctx.key, Sync.seqsOf(data.messages));
                    log.log(`💬 fetchInitialLatestPage: ${data.unopenable} row(s) in ${sessionId} unopenable after ${strikes - 1} retries — anchoring past them, kept as a recoverable gap (#128)`);
                    this.unopenableStrikes.delete(sessionId);
                }
            } catch (e) {
                if (page === 0 || e instanceof StaleFetchError) throw e;
                break; // keep what we have — older pages are a bonus
            }
            const messages = Array.isArray(data.messages) ? data.messages : [];
            // A page of only non-renderable rows still moves the bound: the
            // reader reports the oldest seq it scanned (#4).
            const scannedTo = typeof data.cursor === 'number' && data.cursor < beforeSeq ? data.cursor : undefined;
            hasMore = !!data.hasMore && (messages.length > 0 || scannedTo !== undefined);
            collected.push(...messages);
            lifecycle.push(...data.lifecycle);

            let pageMin = Number.POSITIVE_INFINITY;
            for (const message of messages) {
                if (message.seq > maxSeq) maxSeq = message.seq;
                if (message.seq < minSeq) minSeq = message.seq;
                if (message.seq < pageMin) pageMin = message.seq;
            }
            // Enough renderable content? Estimate by decrypt+normalize, but
            // count only rows that produce a VISIBLE chat element (5.6-sol
            // audit #8): tool-results/usage/etc normalize non-null yet render
            // nothing, so a raw normalize count declared lifecycle-heavy pages
            // "full" while the chat stayed near-empty.
            const decrypted = await encryption.decryptMessages(collected);
            let renderable = 0;
            for (const d of decrypted) {
                if (!d) continue;
                const n = normalizeRawMessage(d.id, d.localId, d.createdAt, d.content);
                if (!n) continue;
                if (n.role === 'user') { renderable++; continue; }
                if (n.role === 'agent' && Array.isArray(n.content)) {
                    if (n.content.some((c: { type?: string; text?: string }) =>
                        (c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0)
                        || c.type === 'tool-call')) renderable++;
                }
            }
            if (!hasMore || renderable >= MIN_RENDERABLE) break;
            const nextBound = Math.min(pageMin, scannedTo ?? Number.POSITIVE_INFINITY);
            if (!Number.isFinite(nextBound)) break; // empty page — nothing older
            beforeSeq = nextBound;
        }
        // v2 pages can repeat the same rows when paging backward (the log only
        // pages forward), so de-dup by id before the ordered apply — the
        // reducer is order-dependent and duplicate ids corrupt its state.
        const seenIds = new Set<string>();
        for (let i = collected.length - 1; i >= 0; i--) {
            if (seenIds.has(collected[i].id)) collected.splice(i, 1);
            else seenIds.add(collected[i].id);
        }
        const anyMessages = collected.length > 0;
        // Single ordered apply: ascending seq, exactly what the reducer expects.
        collected.sort((a, b) => a.seq - b.seq);
        const storeBefore = storage.getState().sessionMessages[sessionId]?.messages.length ?? 0;
        this.assertFresh(sessionId, gen);
        await this.applyFetchedMessages(sessionId, encryption, collected, gen, { deriveThinking: true });
        this.assertFresh(sessionId, gen); // nothing below may commit after a reset
        // History that fetches but never renders has now happened twice, and
        // both times the only evidence was gone by the time it was reported
        // (a reload rebuilds the store and hides it). Say what the initial
        // load actually did: rows collected, the seq span, and how much the
        // store grew. `collected > 0` with no growth is the reducer dropping
        // them — the order-dependent apply racing rows the live stream already
        // wrote — and that line is the whole diagnosis next time.
        this.applyLifecycle(sessionId, lifecycle);
        const storeAfter = storage.getState().sessionMessages[sessionId]?.messages.length ?? 0;
        log.log(`💬 initial history ${sessionId}: collected=${collected.length} seq=${anyMessages ? `${minSeq}..${maxSeq}` : '-'} store ${storeBefore}→${storeAfter} hasMore=${hasMore}`);
        if (collected.length > 0 && storeAfter === storeBefore) {
            log.log(`⚠️ initial history ${sessionId}: ${collected.length} rows applied but the store did not grow — history will render empty`);
        }

        // Anchor both ends so future incremental forward sync resumes from
        // maxSeq, and loadOlderMessages can page backward from minSeq. The
        // backward anchor is the last bound the loop scanned to, even when
        // every page was non-renderable: with no anchor, loadOlderMessages
        // never asked again although the relay said more existed (#4).
        const anchored = this.logs.send(sessionId, {
            type: 'page_applied', gen, page: 'anchor',
            minSeq: anyMessages ? minSeq : null, maxSeq: anyMessages ? maxSeq : null,
            scannedTo: beforeSeq !== SEQ_BACKWARD_INITIAL_SENTINEL ? beforeSeq : null, hasMore,
        });
        storage.getState().applyOlderMessagesPagination(sessionId, {
            hasMore: anchored.kind === 'anchored' ? anchored.hasMoreOlder : hasMore,
        });
    }

    // Forward catch-up tolerates this many 100-message pages before giving up
    // on replaying the gap and re-anchoring at the newest page. Small gaps
    // (reconnects, brief backgrounding) replay exactly as before; a session
    // that ran hot while unwatched (or a daemon backfill wave) no longer costs
    // an unbounded serial replay — decrypt + reducer + re-render per page —
    // just to reach "now". 5 pages ≈ 500 messages.
    private static readonly MAX_FORWARD_CATCHUP_PAGES = 5;

    private fetchForwardSince = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        fromSeq: number,
        gen: number,
    ) => {
        let afterSeq = fromSeq;
        let pages = 0;
        const v2ctx = this.v2ReadCtx(sessionId);
        if (!v2ctx) throw new Error(`Failed to forward-sync ${sessionId}: no v2 link`);
        // A gap left by an earlier read is re-tried first whenever the key
        // has changed since it failed (#128).
        await this.replayUnopenableGap(sessionId, encryption, v2ctx, fromSeq, gen);
        while (true) {
            // Read from the relay's event log (seq-ordered, forward-paged).
            const data = await v2MessagesAfter({ ...v2ctx, afterSeq });
            this.assertFresh(sessionId, gen); // reset while this page was in flight (#407)
            const messages = Array.isArray(data.messages) ? data.messages : [];
            // Advance by the page's RAW cursor, not by renderable rows: a page
            // of lifecycle-only events (turn starts/terminals with no text)
            // used to leave the cursor unmoved, trip the stall guard below, and
            // park every later output behind the same page forever.
            let maxSeq = Math.max(afterSeq, data.cursor ?? afterSeq);
            for (const message of messages) {
                if (message.seq > maxSeq) maxSeq = message.seq;
            }
            // Sealed rows this page could not open must not be stepped over:
            // with no key yet (the card's envelope has not landed) they are
            // the session's first output, and advancing past them lost them
            // until "Reload chat" (issue #3). Stop here; the invalidate that
            // follows the sessions refresh retries with the key.
            // With a key PRESENT the rows may be sealed under a newer key (the
            // card's envelope was re-stamped) — retry a bounded number of times
            // (v2ReadCtx re-reads the card each attempt), then advance and say
            // so loudly rather than block the session forever on a corrupt row.
            if ((data.unopenable ?? 0) > 0) {
                // Pull the card first so the retry reads the newest envelope,
                // then retry. Only PRESENT-key failures spend the budget: a
                // no-key wait must not exhaust the retries a stale key needs.
                this.sessionsSync.invalidate(); // fire only: awaiting queue idleness can starve under the 2.5s poll (Astra, a979cfef)
                const strikes = v2ctx.key ? (this.unopenableStrikes.get(sessionId) ?? 0) + 1 : 0;
                if (!v2ctx.key || strikes <= Sync.MAX_UNOPENABLE_RETRIES) {
                    this.unopenableStrikes.set(sessionId, strikes);
                    throw new Error(`Forward sync of ${sessionId}: ${data.unopenable} sealed row(s) could not be opened (${v2ctx.key ? `key present, attempt ${strikes}` : 'no content key yet'}) — retrying`);
                }
                // Still unreadable with the freshest key after every retry:
                // advance rather than wedge the session, but KEEP the rows
                // that failed as a gap that a later key change re-reads (#128).
                const runs = Sync.sealedSpans(data, afterSeq, maxSeq);
                this.recordUnopenableGaps(sessionId, runs, v2ctx.key, Sync.seqsOf(messages));
                log.log(`💬 fetchForwardSince: ${data.unopenable} row(s) in ${sessionId} unopenable after ${strikes - 1} retries with the current key — advancing past them, ${Sync.describeSpans(runs)} kept as a recoverable gap (#128)`);
            }
            this.unopenableStrikes.delete(sessionId);

            await this.applyFetchedMessages(sessionId, encryption, messages, gen, { deriveThinking: true });
            this.assertFresh(sessionId, gen);
            this.applyLifecycle(sessionId, data.lifecycle);

            this.logs.send(sessionId, { type: 'page_applied', gen, page: 'forward', minSeq: null, maxSeq, scannedTo: null, hasMore: !!data.hasMore });

            if (!data.hasMore) break;
            if (maxSeq === afterSeq) {
                log.log(`💬 fetchForwardSince: pagination stalled for ${sessionId}, stopping to avoid infinite loop`);
                break;
            }

            pages += 1;
            if (pages >= Sync.MAX_FORWARD_CATCHUP_PAGES) {
                // Re-anchor at the latest page WITHOUT nuking the store. The
                // old code called resetSessionMessages here, which erased every
                // loaded message — including history the user had scrolled up to
                // load — down to just the newest page. On a busy session (agent2)
                // that routinely fell >5 pages behind, ANY slow-path fetch
                // (including the one an interrupt triggers) wiped the visible
                // conversation: THE "interrupt erases prior messages" report
                // (2026-07-13, confirmed by e2e: the data pipeline preserves
                // everything for a caught-up client; only this reset erased it).
                // applyMessages MERGES by id, and these rows are all NEWER than
                // what's loaded (safe for the order-dependent reducer), so the
                // existing history survives; fetchInitialLatestPage re-anchors
                // both cursors and the middle gap fills via scroll-up.
                log.log(`💬 fetchForwardSince: gap exceeds ${Sync.MAX_FORWARD_CATCHUP_PAGES} pages for ${sessionId} — re-anchoring at latest page (history preserved)`);
                await this.fetchInitialLatestPage(sessionId, encryption, gen);
                return;
            }
            afterSeq = maxSeq;
        }
    }

    /** Turn lifecycle → delivery stage on the optimistic row that opened the
     *  turn. No-op for rows without a stage (history, other devices). */
    private applyLifecycle(sessionId: string, lifecycle: V2Lifecycle[]) {
        for (const l of lifecycle) {
            storage.getState().applyDeliveryStage(sessionId, { turnId: l.turnId }, l.kind === 'receipted' ? 'daemon' : 'agent');
        }
    }

    private applyFetchedMessages = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        messages: ApiMessage[],
        // The fetch generation the caller captured (#407): decryption is
        // async, and a reset (or a removal, #406; or a send re-anchor, #12)
        // that lands while it runs must stop the commit HERE — the caller's
        // own check after this call came too late for the writes inside it.
        gen: number,
        // Forward/initial fetches carry the newest messages, so a turn-start/
        // turn-end embedded in them reflects the CURRENT turn state — mirror it
        // onto the session (closes the gap codex flagged: the HTTP path updated
        // messages but not thinking). MUST stay false for older-history loads,
        // whose stale lifecycle events would wrongly flip the live thinking flag.
        opts?: { deriveThinking?: boolean }
    ) => {
        if (messages.length === 0) return;
        const decryptedMessages = await encryption.decryptMessages(messages);
        this.assertFresh(sessionId, gen); // superseded while decrypting: nothing below may write
        const normalizedMessages: NormalizedMessage[] = [];
        let latestThinking: { seq: number; thinking: boolean } | null = null;
        for (let i = 0; i < decryptedMessages.length; i++) {
            const decrypted = decryptedMessages[i];
            if (!decrypted) continue;
            const normalized = normalizeRawMessage(decrypted.id, decrypted.localId, decrypted.createdAt, decrypted.content);
            if (normalized) {
                // Carry the authoritative server log order onto the message so
                // the display sort can use it instead of the (skew-prone) createdAt.
                normalized.seq = decrypted.seq;
                // Carry the v2 provenance tag: only event-log rows are applied.
                if ((messages[i] as { __fromV2?: boolean })?.__fromV2) {
                    (normalized as { __fromV2?: boolean }).__fromV2 = true;
                }
                normalizedMessages.push(normalized);
            }
            if (opts?.deriveThinking) {
                const t = deriveThinkingFromContent(decrypted.content);
                if (t !== null) {
                    const seq = messages[i]?.seq ?? -1;
                    if (!latestThinking || seq >= latestThinking.seq) {
                        latestThinking = { seq, thinking: t };
                    }
                }
            }
        }
        if (normalizedMessages.length > 0) {
            this.assertFresh(sessionId, gen);
            this.applyMessages(sessionId, normalizedMessages);
        }
        if (latestThinking) {
            this.assertFresh(sessionId, gen);
            const session = storage.getState().sessions[sessionId];
            if (session && session.thinking !== latestThinking.thinking) {
                this.applySessions([{ ...session, thinking: latestThinking.thinking, thinkingAt: Date.now() }]);
            }
        }
    }

    /**
     * Fetch one page of older messages for a session and prepend them to the
     * store. Called from the chat UI when the user scrolls past the top of
     * the currently loaded history. No-op when we have already fetched the
     * earliest message, when no initial fetch has happened yet, or when an
     * older-fetch is already in flight for this session.
     */
    loadOlderMessages = async (sessionId: string) => {
        // The store gone means the log is evicted, whatever it last thought.
        if (!storage.getState().sessionMessages[sessionId]) { this.logs.send(sessionId, { type: 'evicted' }); return; }
        // The machine refuses at seq 1, with no anchor, with nothing more,
        // or while an older page is already in flight.
        const gen = this.logs.gen(sessionId);
        if (this.logs.send(sessionId, { type: 'older_started', gen }).kind !== 'loading_older') return;

        storage.getState().applyOlderMessagesLoading(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        let settled = false;
        try {
            await lock.inLock(async () => {
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log(`💬 loadOlderMessages: encryption not ready for ${sessionId}`);
                    return;
                }
                // Re-read the anchor inside the lock. A concurrent live
                // refetch or reload could have changed it (or reset the log).
                const beforeSeq = this.logs.oldestSeq(sessionId);
                if (beforeSeq === undefined || beforeSeq <= 1 || this.logs.isStale(sessionId, gen)) {
                    return;
                }
                const v2ctxOlder = this.v2ReadCtx(sessionId);
                if (!v2ctxOlder) throw new Error(`Failed to load older messages for ${sessionId}: no v2 link`);
                const data = await v2MessagesBefore({ ...v2ctxOlder, beforeSeq });
                // A reset during this page: commit nothing (#407). The reset's
                // invalidate re-anchors; the scroll-up path will ask again.
                if (this.logs.isStale(sessionId, gen)) return;
                const messages = Array.isArray(data.messages) ? data.messages : [];

                try {
                    await this.applyFetchedMessages(sessionId, encryption, messages, gen);
                } catch (e) {
                    if (e instanceof StaleFetchError) return; // reset while decrypting (#407)
                    throw e;
                }
                if (this.logs.isStale(sessionId, gen)) return;

                let rowsMin: number | null = null;
                for (const message of messages) {
                    if (rowsMin === null || message.seq < rowsMin) rowsMin = message.seq;
                }
                // The reader's cursor is the oldest seq it scanned, which may be
                // below every returned row — or the only progress when a page
                // held nothing renderable. Without it, 20 pages of lifecycle
                // rows left older history unreachable by scrolling (#4). The
                // machine takes the lowest of the two and ends hasMoreOlder
                // when neither moved.
                const after = this.logs.send(sessionId, {
                    type: 'page_applied', gen, page: 'older', minSeq: rowsMin, maxSeq: null,
                    scannedTo: typeof data.cursor === 'number' ? data.cursor : null, hasMore: !!data.hasMore,
                });
                settled = true;
                const reached = after.kind === 'anchored' && after.oldestSeq !== null ? after.oldestSeq : beforeSeq;
                // Sealed rows this older page could not open: the scroll-up
                // path advances past them (a retry loop here would stall the
                // scroll), but they are a recoverable gap like any other,
                // re-read once the key changes — it used to advance to seq 1
                // with no accounting at all (#128). The gap is the failed
                // rows' OWN span: the reader may have scanned, then trimmed,
                // rows far below the ones it returned, and a gap over the
                // returned span blamed rows that opened fine. Pull the card
                // so a re-stamped envelope reaches the next sync.
                if ((data.unopenable ?? 0) > 0) {
                    this.sessionsSync.invalidate(); // fire only: awaiting queue idleness can starve under the 2.5s poll (Astra, a979cfef)
                    const runs = Sync.sealedSpans(data, reached - 1, beforeSeq - 1);
                    this.recordUnopenableGaps(sessionId, runs, v2ctxOlder.key, Sync.seqsOf(messages));
                    log.log(`💬 loadOlderMessages: ${data.unopenable} row(s) in ${sessionId} unopenable — ${Sync.describeSpans(runs)} kept as a recoverable gap (#128)`);
                }
                storage.getState().applyOlderMessagesPagination(sessionId, {
                    hasMore: after.kind === 'anchored' ? after.hasMoreOlder : false,
                });
            });
        } finally {
            // An early return or a throw: the page was not applied, the log
            // goes back to anchored (a no-op if a reset moved it on).
            if (!settled) this.logs.send(sessionId, { type: 'older_failed', gen });
            storage.getState().applyOlderMessagesLoading(sessionId, false);
        }
    }

    private registerPushToken = async () => {
        // Mobile push toggle (Notifications settings): when off, don't register a
        // token so the server has nothing to push to — and remove whatever of
        // this device is still there. This sync runs at startup, on foreground
        // and when the setting changes, so an offline removal followed by a
        // restart is finished here, not only when the notifications screen is
        // next opened (#181).
        if (!storage.getState().settings.notificationsMobile) {
            log.log('registerPushToken skipped — mobile notifications disabled');
            try {
                await reconcileDisabledPushState(this.credentials, { signal: this.pushLifetime.signal });
            } catch (error) {
                log.log('Failed to remove the push token while disabled: ' + JSON.stringify(error));
            }
            return;
        }
        log.log('registerPushToken');
        try {
            const result = await syncCurrentPushToken(this.credentials, { signal: this.pushLifetime.signal });
            log.log('Push token sync result: ' + JSON.stringify({
                registered: result.registered,
                hasToken: !!result.token,
                permission: result.permission.status,
            }));
            if (!result.permission.granted) {
                console.log('Failed to get push token for push notification!');
            }
        } catch (error) {
            log.log('Failed to register push token: ' + JSON.stringify(error));
        }
    }

    //
    // Apply store
    //

    /** v2 read context for a session, or null when it is not a v2 session.
     *  Returns the relay base, the v2 session id, and the unsealed content key
     *  so pages can be fetched and opened from the v2 event log. */
    /** Fetch and open one attachment cited by a message in this session.
     *  Throws when the session is not v2 / not readable, when the relay
     *  refuses, or when the bytes do not open under the session key. */
    async fetchAttachment(sessionId: string, attachmentId: string): Promise<Uint8Array> {
        const ctx = this.v2ReadCtx(sessionId);
        if (!ctx) throw new Error('session has no readable v2 link');
        const sealed = await v2FetchAttachment(ctx.base, attachmentId);
        const bytes = openV2Bytes(sealed, ctx.key);
        if (!bytes) throw new Error('attachment does not open under the session key');
        return bytes;
    }

    /** Consecutive forward-sync attempts that met sealed rows they could not
     *  open with a key present (see fetchForwardSince). */
    private unopenableStrikes = new Map<string, number>();
    /** Sessions with a send in the last minute keep polling their messages (#2). */
    private recentSendAt = new Map<string, number>();
    private static readonly MAX_UNOPENABLE_RETRIES = 5;

    /**
     * Sealed rows a read could not open even after every retry with the key
     * it had, kept as recoverable GAPS — seq ranges, each with the key it
     * failed under — instead of being stepped over for good (#128). The
     * cursor still advances so one corrupt row cannot wedge the session, but
     * a range is re-read the next time the session's key DIFFERS from the one
     * it failed under (a corrected envelope, a late key), and the rows land
     * then. A session holds a LIST of disjoint ranges sorted by seq: a page
     * that fails under a later key must not replace unfinished work on an
     * earlier range, and a replay that runs out of budget mid-range leaves
     * the unvisited remainder stamped with the OLD key — that stamp is its
     * continuation cursor, and the next sync picks it up. Ranges merge only
     * when adjacent and settled under the same key. The ranges are mirrored
     * into the store so the chat can show the gap (projected at read time,
     * never part of the reducer's history).
     */
    private unopenableGaps = new Map<string, UnopenableRange[]>();

    /** `a..b, c..d` for a log line. */
    private static describeSpans(spans: { fromSeq: number; toSeq: number }[]): string {
        return spans.map((s) => `${s.fromSeq + 1}..${s.toSeq}`).join(', ');
    }

    /** Identity of a session key for gap bookkeeping: same bytes, same id. */
    private static keyId(key: Uint8Array | null): string | null {
        if (!key) return null;
        let s = '';
        for (let i = 0; i < key.length; i++) s += key[i].toString(16).padStart(2, '0');
        return s;
    }

    /**
     * The spans to record for a page's sealed rows: one `(first-1, last]`
     * per RUN of consecutive seqs the reader named — never one min/max
     * envelope over all of them. The rows BETWEEN two failures either
     * opened (and must not sit under a placeholder) or were never delivered
     * at all (a backward read trims rows below the ones it returns; a replay
     * page stops at its range), and an envelope stamped with the current
     * key would replace another key's gap on such a row and end its replay
     * eligibility before anything applied it (#128). From a reader that
     * only counted its failures, the page's own `(pageFrom, pageTo]`.
     * Sorted and disjoint, like every span list this bookkeeping takes.
     */
    private static sealedSpans(
        data: { unopenable?: number; unopenableSeqs?: number[] },
        pageFrom: number,
        pageTo: number,
    ): { fromSeq: number; toSeq: number; count: number }[] {
        const seqs = data.unopenableSeqs;
        if (seqs && seqs.length > 0) return Sync.seqRuns(seqs);
        return [{ fromSeq: pageFrom, toSeq: pageTo, count: data.unopenable ?? 0 }];
    }

    /** Disjoint `(first-1, last]` runs of consecutive seqs, ascending; each
     *  run holds exactly the seqs it was built from, one row per seq. */
    private static seqRuns(seqs: number[]): { fromSeq: number; toSeq: number; count: number }[] {
        const runs: { fromSeq: number; toSeq: number; count: number }[] = [];
        for (const seq of Array.from(new Set(seqs)).sort((a, b) => a - b)) {
            const last = runs[runs.length - 1];
            if (last && seq === last.toSeq + 1) {
                last.toSeq = seq;
                last.count += 1;
            } else {
                runs.push({ fromSeq: seq - 1, toSeq: seq, count: 1 });
            }
        }
        return runs;
    }

    /** The server seqs of a page's rows, for the stored-seq subtraction. */
    private static seqsOf(messages: { seq?: number | null }[] | undefined): number[] {
        const out: number[] = [];
        if (Array.isArray(messages)) for (const m of messages) if (typeof m.seq === 'number') out.push(m.seq);
        return out;
    }

    /**
     * Remember one read's failed `runs` (sorted, disjoint — `sealedSpans`)
     * as unreadable under `key`: ONE pass over the session's list and ONE
     * store publication per read, however many runs the page named. The
     * first cut of #128 settled and published per run: 4,000 alternating
     * sealed/lifecycle events made 2,000 publications, each a full sorted
     * copy of the list — 42M range objects and ~5.7 s on 20,000 old gaps
     * (F17). A seq the store already holds (or that this page `opened`) is
     * never a gap — a row sealed under an OLDER key that a newer key's read
     * cannot open is still history, not missing — so those seqs are cut
     * out of the runs first, and out of every existing range while here.
     */
    private recordUnopenableGaps(
        sessionId: string,
        runs: { fromSeq: number; toSeq: number; count: number }[],
        key: Uint8Array | null,
        opened: number[] = [],
    ) {
        const keyId = Sync.keyId(key);
        const spans: UnopenableRange[] = [];
        for (const r of runs) if (r.toSeq > r.fromSeq) spans.push({ fromSeq: r.fromSeq, toSeq: r.toSeq, keyId, count: Math.max(1, r.count) });
        if (spans.length === 0) return;
        const stored = this.storedSeqs(sessionId, opened);
        const ranges = this.unopenableGaps.get(sessionId) ?? [];
        const next = Sync.cutSeqs(Sync.settleRanges(ranges, Sync.cutSeqs(spans, stored)), stored);
        if (next !== ranges) this.setUnopenableGaps(sessionId, next);
    }

    /** Every server seq the session's store holds, plus `extra`, ascending
     *  (duplicates allowed). Rows without a seq (own sends before their ack)
     *  cannot be a gap's rows and are skipped. */
    private storedSeqs(sessionId: string, extra: number[] = []): number[] {
        const messages = storage.getState().sessionMessages[sessionId]?.messages;
        const seqs: number[] = [];
        if (Array.isArray(messages)) for (const m of messages) if (typeof m.seq === 'number') seqs.push(m.seq);
        for (const seq of extra) if (typeof seq === 'number') seqs.push(seq);
        return seqs.sort((a, b) => a - b);
    }

    /** Replace a session's list (empty → forgotten) and mirror it once. */
    private setUnopenableGaps(sessionId: string, ranges: UnopenableRange[]) {
        if (ranges.length === 0) this.unopenableGaps.delete(sessionId);
        else this.unopenableGaps.set(sessionId, ranges);
        this.publishUnopenableGaps(sessionId);
    }

    /** Mirror a session's ranges into the store for the chat's gap row. */
    private publishUnopenableGaps(sessionId: string) {
        const ranges = this.unopenableGaps.get(sessionId) ?? [];
        storage.getState().applyUnopenableGaps(sessionId, ranges.map(({ fromSeq, toSeq, count }) => ({ fromSeq, toSeq, count })));
    }

    /**
     * `runs` (sorted, disjoint, ALL stamped with one key) are the latest word
     * on their rows. An existing range under the SAME key that overlaps a
     * run is absorbed (union, the larger count — the same rows were counted
     * twice, not more rows); under a DIFFERENT key only the overlapped part
     * is replaced and the rest is kept. Adjacent ranges settled under one
     * key are then merged. One merge of two sorted lists: O(ranges + runs),
     * and the input is returned untouched when there is nothing to add.
     */
    private static settleRanges(ranges: UnopenableRange[], runs: UnopenableRange[]): UnopenableRange[] {
        if (runs.length === 0) return ranges;
        const added: UnopenableRange[] = runs.map((r) => ({ ...r }));
        const kept: UnopenableRange[] = [];
        let j = 0;
        for (const r of ranges) {
            while (j < added.length && added[j].toSeq <= r.fromSeq) j++;
            if (j >= added.length || added[j].fromSeq >= r.toSeq) { kept.push(r); continue; }
            if (r.keyId === added[j].keyId) {
                // Absorb r into every run it touches; those runs become one.
                const u = { fromSeq: Math.min(r.fromSeq, added[j].fromSeq), toSeq: Math.max(r.toSeq, added[j].toSeq), keyId: r.keyId, count: Math.max(r.count, added[j].count) };
                let k = j;
                while (k + 1 < added.length && added[k + 1].fromSeq < r.toSeq) {
                    k++;
                    u.toSeq = Math.max(u.toSeq, added[k].toSeq);
                    u.count = Math.max(u.count, added[k].count);
                }
                added.splice(j, k - j + 1, u);
                continue;
            }
            // Another key: keep the pieces of r that no run covers.
            let from = r.fromSeq;
            for (let k = j; k < added.length && added[k].fromSeq < r.toSeq; k++) {
                if (added[k].fromSeq > from) kept.push(Sync.clipRange(r, from, added[k].fromSeq));
                from = Math.max(from, added[k].toSeq);
            }
            if (from < r.toSeq) kept.push(Sync.clipRange(r, from, r.toSeq));
        }
        // kept and added are each sorted and mutually disjoint: merge them,
        // fusing adjacent ranges that share a key.
        const merged: UnopenableRange[] = [];
        let a = 0;
        let b = 0;
        while (a < kept.length || b < added.length) {
            const r = b >= added.length || (a < kept.length && kept[a].fromSeq < added[b].fromSeq) ? kept[a++] : added[b++];
            const last = merged[merged.length - 1];
            if (last && last.keyId === r.keyId && last.toSeq === r.fromSeq) {
                merged[merged.length - 1] = { ...last, toSeq: r.toSeq, count: last.count + r.count };
            } else {
                merged.push(r);
            }
        }
        return merged;
    }

    /**
     * Remove every seq in `seqs` (ascending) from the sorted list: a row the
     * store holds is not missing, whatever a reader said about it. Ranges
     * with no such seq come back as-is; the list itself when none had one.
     */
    private static cutSeqs(ranges: UnopenableRange[], seqs: number[]): UnopenableRange[] {
        if (ranges.length === 0 || seqs.length === 0) return ranges;
        const out: UnopenableRange[] = [];
        let changed = false;
        let p = 0;
        for (const r of ranges) {
            while (p < seqs.length && seqs[p] <= r.fromSeq) p++;
            if (p >= seqs.length || seqs[p] > r.toSeq) { out.push(r); continue; }
            changed = true;
            let from = r.fromSeq;
            while (p < seqs.length && seqs[p] <= r.toSeq) {
                const seq = seqs[p++];
                if (seq - 1 > from) out.push(Sync.clipRange(r, from, seq - 1));
                from = seq;
            }
            if (r.toSeq > from) out.push(Sync.clipRange(r, from, r.toSeq));
        }
        return changed ? out : ranges;
    }

    /** The range holding `seq`, by binary search over the sorted list. */
    private static rangeAt(ranges: UnopenableRange[], seq: number): UnopenableRange | undefined {
        let lo = 0;
        let hi = ranges.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const r = ranges[mid];
            if (seq <= r.fromSeq) hi = mid - 1;
            else if (seq > r.toSeq) lo = mid + 1;
            else return r;
        }
        return undefined;
    }

    /** Whether `seq` is in the ascending list `seqs`. */
    private static hasSeq(seqs: number[], seq: number): boolean {
        let lo = 0;
        let hi = seqs.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (seqs[mid] < seq) lo = mid + 1;
            else if (seqs[mid] > seq) hi = mid - 1;
            else return true;
        }
        return false;
    }

    /** Remove `(fromSeq, toSeq]` from the list, clipping what overlaps it. */
    private static cutRange(ranges: UnopenableRange[], fromSeq: number, toSeq: number): UnopenableRange[] {
        const out: UnopenableRange[] = [];
        for (const r of ranges) {
            if (r.toSeq <= fromSeq || r.fromSeq >= toSeq) { out.push(r); continue; }
            if (r.fromSeq < fromSeq) out.push(Sync.clipRange(r, r.fromSeq, fromSeq));
            if (r.toSeq > toSeq) out.push(Sync.clipRange(r, toSeq, r.toSeq));
        }
        return out;
    }

    /** `(fromSeq, toSeq]` of `r`; its row count scaled to the kept share of
     *  the span — a display estimate (the relay counts per page, not per seq). */
    private static clipRange(r: UnopenableRange, fromSeq: number, toSeq: number): UnopenableRange {
        const share = (toSeq - fromSeq) / (r.toSeq - r.fromSeq);
        return { fromSeq, toSeq, keyId: r.keyId, count: Math.max(1, Math.min(toSeq - fromSeq, Math.round(r.count * share))) };
    }

    /**
     * Re-read every recorded range whose key is no longer the one that
     * failed on it, oldest first, within one catch-up page budget per sync.
     * Rows that open now are merged as history (no thinking derivation: they
     * are older than the head). Each page settles its own span: still sealed
     * → kept, stamped with the key that failed THIS time, so the same key is
     * not retried on every sync; opened → gone. Whatever the budget did not
     * reach keeps its old stamp and is where the next sync continues — the
     * old code deleted the whole range once five pages had opened, and the
     * rows past page five were lost for good.
     *
     * A page is an unbounded forward read, so it can carry rows PAST the
     * range being replayed. Only failures inside the range settle it — a
     * failure beyond it used to re-stamp a range whose own rows had all
     * opened, and the current key then never revisited them. Rows beyond
     * the range that the head (`headSeq`) has already passed are recorded
     * as their own range under this key; rows past the head are the
     * forward read's to retry.
     */
    private replayUnopenableGap = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        v2ctx: { base: string; v2SessionId: string; key: Uint8Array | null; token: string },
        headSeq: number,
        gen: number,
    ) => {
        const ranges = this.unopenableGaps.get(sessionId);
        if (!ranges || ranges.length === 0) return;
        const keyId = Sync.keyId(v2ctx.key);
        let pages = 0;
        let touched = false;
        try {
            for (const range of ranges) {
                if (range.keyId === keyId) continue; // the key that failed on it: nothing new to try
                if (pages >= Sync.MAX_FORWARD_CATCHUP_PAGES) break;
                let afterSeq = range.fromSeq;
                let stillSealed = 0;
                let opened = 0;
                let stalled = false;
                const sealed: UnopenableRange[] = [];
                const beyond: number[] = [];
                while (afterSeq < range.toSeq && pages < Sync.MAX_FORWARD_CATCHUP_PAGES) {
                    const data = await v2MessagesAfter({ ...v2ctx, afterSeq });
                    this.assertFresh(sessionId, gen);
                    pages += 1;
                    const messages = (Array.isArray(data.messages) ? data.messages : []).filter((m) => m.seq <= range.toSeq);
                    await this.applyFetchedMessages(sessionId, encryption, messages, gen);
                    this.assertFresh(sessionId, gen);
                    let pageEnd = Math.max(afterSeq, data.cursor ?? afterSeq);
                    for (const m of messages) if (m.seq > pageEnd) pageEnd = m.seq;
                    pageEnd = Math.min(pageEnd, range.toSeq);
                    // Nothing beyond this page: the rest of the range holds no rows.
                    if (!data.hasMore) pageEnd = range.toSeq;
                    if (pageEnd <= afterSeq) { stalled = true; break; }
                    const failed = data.unopenableSeqs;
                    const inRange = failed ? failed.filter((seq) => seq > afterSeq && seq <= pageEnd) : [];
                    const unopenable = failed ? inRange.length : (data.unopenable ?? 0);
                    if (unopenable > 0) {
                        stillSealed += unopenable;
                        // One range per run of failed seqs: the rows between two
                        // runs opened on this page and were applied above.
                        for (const s of Sync.sealedSpans({ unopenable, unopenableSeqs: inRange }, afterSeq, pageEnd)) sealed.push({ ...s, keyId });
                    }
                    opened += messages.length;
                    if (failed) for (const seq of failed) if (seq > range.toSeq && seq <= headSeq) beyond.push(seq);
                    afterSeq = pageEnd;
                }
                // Rows the store holds are history, whatever failed here: a row
                // sealed under the key BEFORE this one opened then and is not
                // missing now — the over-read past a range used to record the
                // seven rows a K2 sync had loaded as K3 gaps, three warnings over
                // twelve stored rows (F17).
                const stored = this.storedSeqs(sessionId);
                let next = Sync.cutRange(this.unopenableGaps.get(sessionId) ?? [], range.fromSeq, range.toSeq);
                // Failures past this range that the head already stepped over:
                // nobody else will read them again, so they are a gap of their
                // own — unless a recorded range already holds them (it replays
                // under its own stamp, and keeps its continuation cursor). The
                // subtraction is per SEQ, before the runs are built: a run of
                // uncovered seqs cannot cross a recorded range, so the run for
                // 402 and the run for 404 leave an unvisited (402, 403] alone
                // where one 402..404 envelope replaced it (#128).
                const orphaned = beyond.filter((seq) => !Sync.rangeAt(next, seq) && !Sync.hasSeq(stored, seq));
                const orphanRuns = Sync.seqRuns(orphaned).map((s) => ({ ...s, keyId }));
                // sealed lies inside the range, orphanRuns past it: one sorted,
                // disjoint batch under this key, settled in a single pass.
                next = Sync.settleRanges(next, Sync.cutSeqs(sealed.concat(orphanRuns), stored));
                if (orphaned.length > 0) {
                    log.log(`💬 replayUnopenableGap: ${orphaned.length} row(s) in ${sessionId} past ${range.fromSeq + 1}..${range.toSeq} unopenable with the current key — ${Sync.describeSpans(orphanRuns)} kept as a recoverable gap of its own (#128)`);
                }
                if (afterSeq < range.toSeq) {
                    // Unvisited remainder: the continuation cursor. A relay that
                    // made no progress is stamped with this key instead, so it is
                    // not hammered on every sync until the key changes again.
                    next = Sync.settleRanges(next, [{ ...Sync.clipRange(range, afterSeq, range.toSeq), keyId: stalled ? keyId : range.keyId }]);
                }
                next = Sync.cutSeqs(next, stored);
                if (next.length === 0) this.unopenableGaps.delete(sessionId);
                else this.unopenableGaps.set(sessionId, next);
                touched = true;
                const span = `${range.fromSeq + 1}..${range.toSeq}`;
                if (stillSealed > 0) {
                    log.log(`💬 replayUnopenableGap: ${stillSealed} row(s) in ${sessionId} (${span}) still unopenable with the new key — kept (#128)`);
                } else if (afterSeq < range.toSeq) {
                    log.log(`💬 replayUnopenableGap: ${opened} row(s) of ${sessionId} (${span}) recovered, ${afterSeq + 1}..${range.toSeq} continues next sync (#128)`);
                } else {
                    log.log(`💬 replayUnopenableGap: gap ${span} in ${sessionId} recovered with the new key (#128)`);
                }
            }
        } finally {
            // One publication per replay, however many ranges it settled —
            // and still one when a reset interrupts it after the first (#407).
            if (touched) this.publishUnopenableGaps(sessionId);
        }
    }

    private v2ReadCtx(sessionId: string): { base: string; v2SessionId: string; key: Uint8Array | null; token: string } | null {
        const session = storage.getState().sessions[sessionId];
        const link = session?.metadata?.v2;
        if (!link?.sessionId) return null;
        const token = this.credentials?.token;
        if (!token) return null;
        const key = link.keyEnvelope ? this.encryption.openV2SessionKey(link.keyEnvelope) : null;
        return { base: link.relay, v2SessionId: link.sessionId, key, token };
    }

    /** Machine-plane context for a v2 session (tunnel target + local session
     *  id), or null when the session is not v2 or prerequisites are missing. */
    machineCtx(sessionId: string): { relayUrl: string; accountToken: string; machineKey: Uint8Array; machineId: string; localSessionId: string } | null {
        const session = storage.getState().sessions[sessionId];
        const link = session?.metadata?.v2;
        const machineId = session?.metadata?.machineId;
        const localSessionId = link?.localSessionId;
        if (!link?.sessionId || !machineId || !localSessionId) return null;
        const token = this.credentials?.token;
        // The tunnel key is rooted on the PER-MACHINE key (what the daemon
        // stores as access.key machineKey and publishes as the machine
        // record's dataEncryptionKey) — a dataKey daemon never holds the
        // account master, and per-machine scoping limits the blast radius.
        const machineKey = this.machineDataKeys.get(machineId);
        if (!token || !machineKey) {
            // A session whose machine key is unknown CANNOT use the machine
            // plane. Say so loudly — a silent fallback hides exactly the
            // breakage this is meant to surface.
            console.error(`[v2] machine plane unavailable for session ${sessionId}: ${!token ? 'no token' : `no key for machine ${machineId}`}`);
            return null;
        }
        return { relayUrl: link.relay, accountToken: token, machineKey, machineId, localSessionId };
    }

    /**
     * machineCtx, but patient: the machine key arrives with session sync, which
     * can land AFTER a screen's first fetch — and it lives in a plain Map, so
     * nothing re-renders to tell a caller it showed up. Callers that would
     * otherwise cache a failure ("not a git repo", "no usage") must wait for it
     * instead of latching. Returns null only if it never arrives.
     */
    async awaitMachineCtx(sessionId: string, timeoutMs = 15_000): Promise<ReturnType<Sync['machineCtx']>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const ctx = this.machineCtx(sessionId);
            if (ctx) return ctx;
            if (Date.now() >= deadline) return null;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    /** Machine-plane context addressed by MACHINE (not relay session) — for
     *  screens that already hold machineId + the daemon-local session id
     *  (terminal, machine view). Returns null when the machine's key or a v2
     *  relay for it is unknown. */
    machineCtxFor(machineId: string, localSessionId: string): { relayUrl: string; accountToken: string; machineKey: Uint8Array; machineId: string; localSessionId: string } | null {
        const token = this.credentials?.token;
        const machineKey = this.machineDataKeys.get(machineId);
        if (!token || !machineKey) return null;
        // Prefer a v2 relay this machine is actually linked on; fall back to
        // the app's own server URL (same origin serves /joy/v2 once promoted).
        let relayUrl: string | null = null;
        for (const s of Object.values(storage.getState().sessions)) {
            const link = (s as { metadata?: { v2?: { relay?: string }; machineId?: string } }).metadata;
            if (link?.machineId === machineId && link?.v2?.relay) { relayUrl = link.v2.relay; break; }
        }
        if (!relayUrl) relayUrl = getV2BaseUrl(); // same base the session list uses (#409)
        return { relayUrl, accountToken: token, machineKey, machineId, localSessionId };
    }

    /** Machine-scoped tunnel context (no session needed) — usage, limits,
     *  harness config, history, machine status. */
    machineOnlyCtx(machineId: string): { relayUrl: string; accountToken: string; machineKey: Uint8Array; machineId: string } | null {
        const c = this.machineCtxFor(machineId, '');
        return c ? { relayUrl: c.relayUrl, accountToken: c.accountToken, machineKey: c.machineKey, machineId } : null;
    }

    private applyMessages = (sessionId: string, messages: NormalizedMessage[]) => {
        // Sessions read their history from the v2 EVENT LOG; only rows tagged
        // as coming from it are applied so nothing can render twice.
        if (messages.length > 0 && storage.getState().sessions[sessionId]?.metadata?.v2?.sessionId) {
            messages = messages.filter(m => (m as { __fromV2?: boolean }).__fromV2 === true);
            if (messages.length === 0) return;
        }
        const result = storage.getState().applyMessages(sessionId, messages);
        // Voice: changed rows feed the agent (text, tool use, held approvals,
        // <joy-options> questions).
        if (result.changed.length > 0 && storage.getState().voiceArmedSessionId !== null) {
            const map = storage.getState().sessionMessages[sessionId]?.messagesMap;
            const changed: Message[] = [];
            for (const id of result.changed) {
                const m = map?.[id];
                if (m) changed.push(m);
            }
            if (changed.length > 0) voiceHooks.onMessages(sessionId, changed);
        }
    }

    private applySessions = (sessions: (Omit<Session, "presence"> & {
        presence?: "online" | number;
    })[]) => {
        // Voice: a working → idle transition is "the turn ended".
        //
        // Read as the falling edge of the SHARED turn predicate, before and
        // after the merge. It used to compare the raw ephemeral thinking flag on
        // the incoming row against the stored one, which missed a turn carried
        // by the persisted mirror — the cold-start and reconnect case — and
        // missed a turn that ended out of compaction or a retry backoff. Voice
        // simply never heard "ready" for those, and sat waiting.
        //
        // The "after" side reads the MERGED row rather than the incoming patch:
        // an update carrying only some fields would otherwise look idle purely
        // because the fields that say otherwise were absent from it.
        const armed = storage.getState().voiceArmedSessionId !== null;
        const wasActive = new Map<string, boolean>();
        if (armed) {
            const before = storage.getState().sessions;
            for (const s of sessions) {
                const prev = before[s.id];
                wasActive.set(s.id, !!prev && isTurnActive(liveFacts(prev)));
            }
        }
        storage.getState().applySessions(sessions);
        if (armed) {
            const after = storage.getState().sessions;
            for (const s of sessions) {
                if (!wasActive.get(s.id)) continue;
                const now = after[s.id];
                if (now && !isTurnActive(liveFacts(now))) voiceHooks.onReady(s.id);
            }
        }
    }

}

// Global singleton instance
export const sync = new Sync();

// DEV probe: lets the e2e harness exercise the machine plane (tunnel) from the
// console. Harmless in production — it only exposes calls the app already makes.
if (typeof globalThis !== 'undefined') {
    (globalThis as { __joyV2?: unknown }).__joyV2 = {
        machineCtx: (sid: string) => sync.machineCtx(sid),
        // Machine-scoped (no session) probe: mirrors the machine page's
        // joy-status health check so the harness can see WHY it fails.
        machineStatus: async (machineId: string) => {
            const ctx = sync.machineOnlyCtx(machineId);
            if (!ctx) return { error: 'no machineOnlyCtx (no token or machine data key yet)' };
            const { machineStatusOnly } = await import('./v2/machine');
            try { return await machineStatusOnly(ctx); }
            catch (e) { return { error: `ERR ${(e as Error).name}: ${(e as Error).message}` }; }
        },
        cardProbe: async (v2id: string) => {
            const { v2 } = await import('./v2/api');
            const { openCard } = await import('./v2/card');
            const row = (await v2.listSessions()).sessions.find(r => r.sessionId.startsWith(v2id));
            if (!row) return { stage: 'no-row' };
            const key = row.sessionKeyEnvelope ? sync.encryption.openV2SessionKey(row.sessionKeyEnvelope) : null;
            const card = openCard(row.encryptedMetadata, key);
            return { stage: 'done', hasKey: !!key, metaLen: (row.encryptedMetadata ?? '').length, card: card ? Object.keys(card) : null };
        },
        // Session card as the app sees it: the v2 link, presence and the
        // thinking flag that gates the composer's send-vs-hold decision.
        card: (sid: string) => {
            const s = storage.getState().sessions[sid];
            if (!s) return null;
            return { v2: s.metadata?.v2, presence: s.presence, thinking: s.thinking, active: s.active, updatedAt: s.updatedAt };
        },
        send: (sid: string, text: string) => sync.sendMessage(sid, text, { source: 'chat' }),
        gitFiles: async (sid: string) => {
            const { fetchGitStatusFiles } = await import('./gitStatusResource');
            return fetchGitStatusFiles(sid);
        },
        gitStatus: async (sid: string) => {
            const ctx = sync.machineCtx(sid);
            if (!ctx) return { error: 'no machineCtx' };
            const { machineGitStatus } = await import('./v2/machine');
            return machineGitStatus(ctx);
        },
        pane: async (sid: string) => {
            const ctx = sync.machineCtx(sid);
            if (!ctx) return { error: 'no machineCtx' };
            const { machinePane } = await import('./v2/machine');
            return machinePane(ctx);
        },
        // Broad machine-plane sweep used by the e2e harness.
        sweep: async (sid: string) => {
            const ctx = sync.machineCtx(sid);
            if (!ctx) return { error: 'no machineCtx' };
            const m = await import('./v2/machine');
            const only = { relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey, machineId: ctx.machineId };
            const r: Record<string, string> = {};
            const t = async (name: string, fn: () => Promise<{ status: number; data: unknown }>) => {
                try { const x = await fn(); r[name] = `${x.status}${x.data ? '' : ' (no data)'}`; }
                catch (e) { r[name] = `ERR ${(e as Error).message}`; }
            };
            await t('write', () => m.machineWriteFile(ctx, 'v2probe.txt', 'hello-v2'));
            await t('read', () => m.machineReadFile(ctx, 'v2probe.txt'));
            await t('entries', () => m.machineListDir(ctx, '.', 1));
            await t('grep', () => m.machineGrep(ctx, 'hello-v2'));
            await t('delete', () => m.machineDeleteFile(ctx, 'v2probe.txt'));
            await t('slash', () => m.machineSlashCommands(ctx));
            await t('status', () => m.machineStatusOnly(only));
            await t('usage', () => m.machineUsageOnly(only, 'today'));
            await t('limits', () => m.machineLimitsOnly(only, 'claude'));
            await t('config', () => m.machineConfigRead(only, 'claude'));
            await t('history', () => m.machineHistory(only, '/tmp/v2-reads-test'));
            return r;
        },
    };
}

//
// Init sequence
//

// Success AND failure of the one-shot init are owned here, for both entry
// points: a boot that threw used to leave the flag set, so the next login was
// a silent no-op that "succeeded" with no engine underneath (#88, #190).
// After a failure — or a logout that could not reload (#189) — every further
// init throws SyncInitUnavailableError until the process reloads.
const initGate = new SyncInitGate();

/** True when signing in cannot boot an engine in this process. */
export function syncReloadRequired(): boolean {
    return initGate.reloadRequired;
}

export async function syncCreate(credentials: AuthCredentials) {
    if (await initGate.run(() => syncInit(credentials, false)) === 'skipped') {
        console.warn('Sync already initialized: ignoring');
    }
}

export async function syncRestore(credentials: AuthCredentials) {
    if (await initGate.run(() => syncInit(credentials, true)) === 'skipped') {
        console.warn('Sync already initialized: ignoring');
    }
}

/** Logout: tear the account down and refuse further inits until a reload. */
export function syncShutdownForLogout() {
    sync.shutdown();
    initGate.markStopped();
}

async function syncInit(credentials: AuthCredentials, restore: boolean) {

    // Initialize sync engine
    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    const encryption = await Encryption.create(secretKey);
    sync.setMasterSecret(secretKey);

    // The app's realtime is the v2 SSE doorbell (plus the poll fallback).
    // Connection status is wired inside startV2Live.

    // Initialize sessions engine
    if (restore) {
        await sync.restore(credentials, encryption);
    } else {
        await sync.create(credentials, encryption);
    }

    // Live updates come from the relay (SSE doorbell + poll fallback).
    sync.startV2Live();
}
