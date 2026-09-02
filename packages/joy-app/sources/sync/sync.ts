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
import { v2, v2SendCiphertext, v2UploadAttachment, v2FetchAttachment, connectV2Stream } from './v2/api';
import { readFileBytes } from '@/utils/readFileBytes';
import { encodeHex } from '@/encryption/hex';
import { v2MessagesAfter, v2MessagesBefore } from './v2/reads';

import { syncCurrentPushToken } from './pushRegistration';
import { Platform, AppState } from 'react-native';
import { NormalizedMessage, normalizeRawMessage } from './typesRaw';
import { Settings, settingsParse } from './settings';
import { profileParse } from './profile';
import { loadPendingSettings, savePendingSettings } from './persistence';
import { parseToken } from '@/utils/parseToken';
import { getServerUrl } from './serverConfig';
import { log } from '@/log';
import { gitStatusSync } from './gitStatusSync';
import { AsyncLock } from '@/utils/lock';
import type { AttachmentPreview } from './attachmentTypes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { isDemoSession } from './demoSession';
import { voiceHooks } from '@/realtime/hooks/voiceHooks';
import type { Message } from './typesMessage';

// Sentinel used as `before_seq` for the very first backward fetch of a
// session. It must exceed any real `seq` value the server can produce; the
// relay stores `seq` as BIGINT, but a session would need two billion events
// to reach this, so int32-max is "infinite" in practice and stays exact in JS.
const SEQ_BACKWARD_INITIAL_SENTINEL = 2_147_483_647;

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
 *  the composer puts the message back, the draft-release lease reverts. */
export type SendMessageResult = { ok: true; localId: string } | { ok: false; reason: string };

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
    private sessionLastSeq = new Map<string, number>();
    // Lowest seq value we have already fetched and applied for a session.
    // Used as the cursor for backward pagination when the user scrolls up to
    // load older history. Set after the initial latest-page fetch and
    // advanced downward by loadOlderMessages.
    private sessionOldestSeq = new Map<string, number>();
    private sessionMessageLocks = new Map<string, AsyncLock>();
    private machineDataKeys = new Map<string, Uint8Array>(); // Store machine data encryption keys internally
    private settingsSync: InvalidateSync;
    private profileSync: InvalidateSync;
    private machinesSync: InvalidateSync;
    private pushTokenSync: InvalidateSync;
    private nativeUpdateSync: InvalidateSync;
    private pendingSettings: Partial<Settings> = loadPendingSettings();

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

        // Refresh the account-level syncs when the app returns to the foreground.
        AppState.addEventListener('change', (nextAppState) => {
            if (nextAppState === 'active') {
                log.log('📱 App became active');
                this.profileSync.invalidate();
                this.machinesSync.invalidate();
                this.pushTokenSync.invalidate();
                this.sessionsSync.invalidate();
                this.nativeUpdateSync.invalidate();
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
        const cursor = this.sessionLastSeq.get(sessionId);
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
        this.sessionLastSeq.delete(sessionId);
        this.sessionOldestSeq.delete(sessionId);
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
        void import('@/-session/draftQueueRelease').then(({ initDraftQueueRelease }) => {
            initDraftQueueRelease((sessionId, text, localId) =>
                this.sendMessage(sessionId, text, { source: 'chat', localId }));
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

        // Also invalidate git status sync for this session
        gitStatusSync.getSync(sessionId).invalidate();
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
    private v2StreamStop: (() => void) | null = null;
    private v2PollTimer: ReturnType<typeof setInterval> | null = null;

    private v2SessionIdIndex(): Map<string, string> {
        const idx = new Map<string, string>(); // v2SessionId → local session id
        for (const [sid, s] of Object.entries(storage.getState().sessions)) {
            const v2 = (s as { metadata?: { v2?: { sessionId?: string } } }).metadata?.v2?.sessionId;
            if (v2) idx.set(v2, sid);
        }
        return idx;
    }

    startV2Live() {
        if (this.v2StreamStop || this.v2PollTimer) return;
        const invalidateFor = (v2SessionId: string) => {
            const sid = this.v2SessionIdIndex().get(v2SessionId);
            if (sid) this.getMessagesSync(sid).invalidate();
        };
        // The doorbell is the app's ONLY realtime channel: it feeds the
        // connection indicator too. The stream reconnects itself with a small
        // backoff; between attempts the poll below keeps data flowing, so
        // 'connecting' here means "no live stream", not "no data".
        const connect = () => {
            if (this.v2LiveStopped) return;
            storage.getState().setSocketStatus('connecting');
            try {
                this.v2StreamStop = connectV2Stream({
                    onHello: () => storage.getState().setSocketStatus('connected'),
                    onPoke: (v2SessionId) => {
                        invalidateFor(v2SessionId);
                        // A state poke may mean a card/presence change (bind,
                        // title, joy__state, lease death) — refresh the LIST.
                        this.sessionsSync.invalidate();
                    },
                    onEphemeral: (v2SessionId) => invalidateFor(v2SessionId),
                    onClose: () => {
                        this.v2StreamStop = null;
                        if (this.v2LiveStopped) return;
                        storage.getState().setSocketStatus('connecting');
                        setTimeout(connect, 3000);
                    },
                });
            } catch { /* SSE unavailable — the poll carries it */ }
        };
        this.v2LiveStopped = false;
        connect();
        // Poll fallback: keeps sessions live where SSE cannot run (native)
        // or while the stream is down.
        this.v2PollTimer = setInterval(() => {
            for (const sid of this.v2SessionIdIndex().values()) {
                this.getMessagesSync(sid).invalidate();
            }
            this.sessionsSync.invalidate();
            this.machinesSync.invalidate();
        }, 2500);
    }

    private v2LiveStopped = false;

    stopV2Live() {
        this.v2LiveStopped = true;
        this.v2StreamStop?.(); this.v2StreamStop = null;
        if (this.v2PollTimer) { clearInterval(this.v2PollTimer); this.v2PollTimer = null; }
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
        // No optimistic echo: the relay's `turn.queued` event IS the user row
        // (sync/v2/reads.ts), so the message appears once the relay accepts
        // it. localId doubles as the relay clientIntentId — a retry with the
        // same id (draft release) replays the first acceptance.
        const localId = options?.localId ?? randomUUID();
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
                Modal.alert(
                    e instanceof AttachmentRejected ? t('imageUpload.fileTooLargeTitle') : t('imageUpload.uploadFailedTitle'),
                    e instanceof AttachmentRejected ? e.message : t('imageUpload.uploadFailedMessage', { count: options.attachments.length }),
                    [{ text: t('common.ok'), style: 'cancel' }],
                );
                return { ok: false, reason: `attachment upload failed: ${e instanceof Error ? e.message : e}` };
            }
        }
        try {
            const ciphertext = sealV2Content(text, key, attachments);
            await v2SendCiphertext(v2link.relay, v2link.sessionId, ciphertext, localId, attachments.map(a => a.id));
        } catch (e) {
            console.error('[v2] send failed', e);
            return { ok: false, reason: `v2 send failed: ${e instanceof Error ? e.message : e}` };
        }
        // The relay's accepted response IS the durable ack: a draft released
        // with this localId may now leave the draft queue.
        void import('@/-session/draftQueueRelease').then(({ notifyOutboxAcked }) => {
            notifyOutboxAcked(sessionId, [localId]);
        });
        return { ok: true, localId };
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
            if (bytes.length === 0) throw new AttachmentRejected(t('imageUpload.emptyFileMessage', { name: a.name }));
            if (bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentRejected(t('imageUpload.fileTooLargeMessage', { name: a.name, maxMb: MAX_ATTACHMENT_MB }));
            const sealed = sealV2Bytes(bytes, key);
            // `.slice()` materializes a standalone ArrayBuffer — the digest API
            // rejects views over a SharedArrayBuffer at the type level.
            const hash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, sealed.slice().buffer as ArrayBuffer);
            const { attachmentId } = await v2UploadAttachment(relay, v2SessionId, sealed, encodeHex(new Uint8Array(hash)).toLowerCase());
            out.push({
                id: attachmentId,
                name: a.name,
                size: bytes.length,
                ...(a.mimeType ? { mime: a.mimeType } : {}),
                ...(a.width > 0 && a.height > 0 ? { width: a.width, height: a.height } : {}),
                ...(a.thumbhash ? { thumbhash: a.thumbhash } : {}),
            });
        }
        return out;
    }

    applySettings = (delta: Partial<Settings>) => {
        storage.getState().applySettingsLocal(delta);

        // Save pending settings
        this.pendingSettings = { ...this.pendingSettings, ...delta };
        savePendingSettings(this.pendingSettings);

        // Invalidate settings sync
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
    // while removed keys stay removed. pendingSettings is replaced wholesale so
    // stale deltas can't re-introduce a removed key on the next sync push.
    replaceSettings = (raw: unknown) => {
        const parsed = settingsParse(raw);
        storage.getState().applySettingsRaw(parsed);
        this.pendingSettings = { ...parsed } as Partial<Settings>;
        savePendingSettings(this.pendingSettings);
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
        const { sessions: rows } = await v2.listSessions();

        // Register a (legacy, key-less) session encryption per id: v2 message
        // content never uses it (rows arrive decrypted via __v2Plain), but the
        // engine's lookups expect an entry to exist.
        const sessionKeys = new Map<string, Uint8Array | null>();
        for (const row of rows) sessionKeys.set(row.sessionId, null);
        await this.encryption.initializeSessions(sessionKeys);

        const relayUrl = getServerUrl();
        const decryptedSessions: (Omit<Session, 'presence'> & { presence?: "online" | number })[] = [];
        for (const row of rows) {
            // Session content key: envelope sealed to the account content key.
            const key = row.sessionKeyEnvelope ? this.encryption.openV2SessionKey(row.sessionKeyEnvelope) : null;

            // The card IS the metadata. A session with no card yet (spawn still
            // provisioning, or a pre-card daemon) gets a minimal one carrying
            // the v2 link — enough for the spawn poller and the reads engine.
            let metadata = openCard(row.encryptedMetadata, key) as Session['metadata'] | null;
            if (!metadata) {
                metadata = {
                    path: '',
                    host: '',
                    machineId: row.daemonId,
                    v2: { sessionId: row.sessionId, relay: relayUrl, keyEnvelope: row.sessionKeyEnvelope ?? '', localSessionId: row.localSessionId ?? undefined },
                } as unknown as Session['metadata'];
            } else {
                // The card's v2 link may predate fields (or the relay moved) —
                // the ROW is authoritative for linkage.
                (metadata as Record<string, unknown>).v2 = {
                    ...(metadata as { v2?: Record<string, unknown> }).v2,
                    sessionId: row.sessionId, relay: relayUrl,
                    keyEnvelope: row.sessionKeyEnvelope ?? (metadata as { v2?: { keyEnvelope?: string } }).v2?.keyEnvelope ?? '',
                    localSessionId: row.localSessionId ?? (metadata as { v2?: { localSessionId?: string } }).v2?.localSessionId,
                };
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

        this.applySessions(decryptedSessions);
        log.log(`📥 fetchSessions completed - processed ${decryptedSessions.length} v2 sessions`);
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

    // Settings are device-local: joy-relay has no account-settings store, so
    // "sync" just retires the pending delta — applySettingsLocal/applySettingsRaw
    // already persisted the merged settings on this device.
    private syncSettings = async () => {
        if (Object.keys(this.pendingSettings).length === 0) return;
        this.pendingSettings = {};
        savePendingSettings(this.pendingSettings);
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

            const knownLastSeq = this.sessionLastSeq.get(sessionId);
            const isInitialLoad = knownLastSeq === undefined;
            if (isInitialLoad) {
                // Initial load. Pull only the most recent page so the user can
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
                await this.fetchInitialLatestPage(sessionId, encryption);
            } else if (!storage.getState().sessionMessages[sessionId]) {
                // Cursor survived but the message store was evicted
                // (limitSessionMemory unload). Forward-replaying the gap would
                // rebuild history we no longer even hold — re-anchor: refetch
                // exactly like a cold open (newest page; older fills on scroll).
                log.log(`💬 fetchMessages: store evicted for ${sessionId} — re-anchoring at latest page`);
                this.sessionLastSeq.delete(sessionId);
                this.sessionOldestSeq.delete(sessionId);
                await this.fetchInitialLatestPage(sessionId, encryption);
            } else {
                // Forward incremental sync. Used after reconnect, invalidate,
                // or any subsequent visit. Pulls messages newer than what we
                // already have — bounded by the re-anchor inside (a huge gap
                // stops replaying and jumps to the newest page instead).
                await this.fetchForwardSince(sessionId, encryption, knownLastSeq);
            }

            storage.getState().applyMessagesLoaded(sessionId);
            log.log(`💬 fetchMessages completed for session ${sessionId}`);

            if (isInitialLoad) {
                // Fire-and-forget. The chat is interactive at this point;
                // background pages stream in without blocking either the
                // surrounding lock or the UI. loadOlderMessages takes the
                // same lock internally, so the loop naturally serialises
                // with on-scroll triggers and live-stream pokes.
                void this.prefetchOlderMessagesInBackground(sessionId);
            }
        });
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
            const oldestSeq = this.sessionOldestSeq.get(sessionId);
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
        encryption: ReturnType<Encryption['getSessionEncryption']> & {}
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
        const v2ctx = this.v2ReadCtx(sessionId);
        if (!v2ctx) throw new Error(`Failed to fetch initial page for ${sessionId}: no v2 link`);
        for (let page = 0; page < MAX_INITIAL_PAGES; page++) {
            let data: { messages: ApiMessage[]; hasMore: boolean };
            try {
                data = await v2MessagesBefore({ ...v2ctx, beforeSeq });
            } catch (e) {
                if (page === 0) throw e;
                break; // keep what we have — older pages are a bonus
            }
            const messages = Array.isArray(data.messages) ? data.messages : [];
            hasMore = !!data.hasMore && messages.length > 0;
            collected.push(...messages);

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
            if (!Number.isFinite(pageMin)) break; // empty page — nothing older
            beforeSeq = pageMin;
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
        await this.applyFetchedMessages(sessionId, encryption, collected, { deriveThinking: true });

        // Anchor both ends so future incremental forward sync resumes from
        // maxSeq, and loadOlderMessages can page backward from minSeq.
        this.sessionLastSeq.set(sessionId, maxSeq);
        if (anyMessages) {
            this.sessionOldestSeq.set(sessionId, minSeq);
        }
        storage.getState().applyOlderMessagesPagination(sessionId, {
            hasMore
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
        fromSeq: number
    ) => {
        let afterSeq = fromSeq;
        let pages = 0;
        const v2ctx = this.v2ReadCtx(sessionId);
        if (!v2ctx) throw new Error(`Failed to forward-sync ${sessionId}: no v2 link`);
        while (true) {
            // Read from the relay's event log (seq-ordered, forward-paged).
            const data = await v2MessagesAfter({ ...v2ctx, afterSeq });
            const messages = Array.isArray(data.messages) ? data.messages : [];

            await this.applyFetchedMessages(sessionId, encryption, messages, { deriveThinking: true });

            // Advance by the page's RAW cursor, not by renderable rows: a page
            // of lifecycle-only events (turn starts/terminals with no text)
            // used to leave the cursor unmoved, trip the stall guard below, and
            // park every later output behind the same page forever.
            let maxSeq = Math.max(afterSeq, data.cursor ?? afterSeq);
            for (const message of messages) {
                if (message.seq > maxSeq) maxSeq = message.seq;
            }
            this.sessionLastSeq.set(sessionId, maxSeq);

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
                await this.fetchInitialLatestPage(sessionId, encryption);
                return;
            }
            afterSeq = maxSeq;
        }
    }

    private applyFetchedMessages = async (
        sessionId: string,
        encryption: ReturnType<Encryption['getSessionEncryption']> & {},
        messages: ApiMessage[],
        // Forward/initial fetches carry the newest messages, so a turn-start/
        // turn-end embedded in them reflects the CURRENT turn state — mirror it
        // onto the session (closes the gap codex flagged: the HTTP path updated
        // messages but not thinking). MUST stay false for older-history loads,
        // whose stale lifecycle events would wrongly flip the live thinking flag.
        opts?: { deriveThinking?: boolean }
    ) => {
        if (messages.length === 0) return;
        const decryptedMessages = await encryption.decryptMessages(messages);
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
            this.applyMessages(sessionId, normalizedMessages);
        }
        if (latestThinking) {
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
        const oldestSeq = this.sessionOldestSeq.get(sessionId);
        if (oldestSeq === undefined || oldestSeq <= 1) {
            return;
        }
        const sessionMessages = storage.getState().sessionMessages[sessionId];
        if (!sessionMessages || sessionMessages.isLoadingOlder || !sessionMessages.hasMoreOlder) {
            return;
        }

        storage.getState().applyOlderMessagesLoading(sessionId, true);
        const lock = this.getSessionMessageLock(sessionId);
        try {
            await lock.inLock(async () => {
                const encryption = this.encryption.getSessionEncryption(sessionId);
                if (!encryption) {
                    log.log(`💬 loadOlderMessages: encryption not ready for ${sessionId}`);
                    return;
                }
                // Re-read the cursor inside the lock. A concurrent live
                // refetch or reload could have changed it.
                const beforeSeq = this.sessionOldestSeq.get(sessionId);
                if (beforeSeq === undefined || beforeSeq <= 1) {
                    return;
                }
                const v2ctxOlder = this.v2ReadCtx(sessionId);
                if (!v2ctxOlder) throw new Error(`Failed to load older messages for ${sessionId}: no v2 link`);
                const data = await v2MessagesBefore({ ...v2ctxOlder, beforeSeq });
                const messages = Array.isArray(data.messages) ? data.messages : [];

                await this.applyFetchedMessages(sessionId, encryption, messages);

                let minSeq = beforeSeq;
                for (const message of messages) {
                    if (message.seq < minSeq) minSeq = message.seq;
                }
                if (messages.length > 0) {
                    this.sessionOldestSeq.set(sessionId, minSeq);
                }
                storage.getState().applyOlderMessagesPagination(sessionId, {
                    hasMore: !!data.hasMore && messages.length > 0
                });
            });
        } finally {
            storage.getState().applyOlderMessagesLoading(sessionId, false);
        }
    }

    private registerPushToken = async () => {
        // Mobile push toggle (Notifications settings): when off, don't register a
        // token so the server has nothing to push to.
        if (!storage.getState().settings.notificationsMobile) {
            log.log('registerPushToken skipped — mobile notifications disabled');
            return;
        }
        log.log('registerPushToken');
        try {
            const result = await syncCurrentPushToken(this.credentials);
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
        if (!relayUrl) relayUrl = getServerUrl();
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
        const before = storage.getState().sessions;
        const finished: string[] = [];
        if (storage.getState().voiceArmedSessionId !== null) {
            for (const s of sessions) {
                if (before[s.id]?.thinking === true && s.thinking === false) finished.push(s.id);
            }
        }
        storage.getState().applySessions(sessions);
        for (const id of finished) voiceHooks.onReady(id);
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
            const { getGitStatusFiles } = await import('./gitStatusFiles');
            return getGitStatusFiles(sid);
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

let isInitialized = false;
export async function syncCreate(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, false);
}

export async function syncRestore(credentials: AuthCredentials) {
    if (isInitialized) {
        console.warn('Sync already initialized: ignoring');
        return;
    }
    isInitialized = true;
    await syncInit(credentials, true);
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
