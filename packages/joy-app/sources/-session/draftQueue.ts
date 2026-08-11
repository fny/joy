import { create } from 'zustand';
import { relayScopedMMKV } from '@/sync/serverConfig';

// On-device draft queue. Drafts are messages the user has composed but not yet
// sent — they live ONLY in the app (never propagated to joy-tmux) until the user
// sends one, at which point it goes through the normal send path like any other
// message. Persisted to MMKV (same manual hydrate/persist idiom as
// useNewSessionDraft), so queued drafts survive a reload / app restart.

// Why an item is in the queue — this is what separates a deliberate DRAFT from
// a pending QUEUE ITEM (user model, 2026-07-25):
//   'draft' — the user deliberately stashed it (Save-draft). Lives in the
//             Drafts view; NEVER auto-sends — only a manual tap sends it.
//   'busy'  — auto-held because a message ahead is still being processed.
//             Auto-releases when the turn completes (a "queue item").
// Absent = 'draft' (safe default for older persisted entries — never auto-send
// something whose intent we don't know). Offline sends are NOT queued here —
// they go through the outbox with a per-message delivery status.
export type DraftReason = 'draft' | 'busy';

export interface QueuedDraft {
    id: string;
    text: string;
    reason?: DraftReason;
    /** When the draft was queued — drives the max-hold TTL (older persisted
     *  drafts without it fall back to the id's timestamp prefix). */
    queuedAt?: number;
    /** Lease-based two-phase release (codex review finding 3): 'releasing'
     *  is a LEASE, not a terminal state — an app reload or send failure
     *  reverts/retries with the SAME releaseLocalId so the reducer and the
     *  server both dedupe. Absent = 'queued' (older persisted drafts). */
    state?: 'queued' | 'releasing';
    releaseLocalId?: string;
    leaseUntil?: number;
    attempt?: number;
    lastError?: string;
}

interface DraftQueueState {
    bySession: Record<string, QueuedDraft[]>;
    add: (sessionId: string, text: string, reason?: DraftReason) => void;
    update: (sessionId: string, id: string, text: string) => void;
    remove: (sessionId: string, id: string) => void;
    /** Two-phase release: take the lease (persisted) before sendMessage. Keeps
     *  the existing releaseLocalId on retry so the send stays idempotent. */
    markReleasing: (sessionId: string, id: string, releaseLocalId: string, leaseUntil: number) => void;
    /** Send failed/lease action: back to 'queued' with attempt+1 and the error
     *  recorded — draft stays visible and editable, never silently lost. */
    revertRelease: (sessionId: string, id: string, error: string) => void;
}

const mmkv = relayScopedMMKV();
const STORAGE_KEY = 'draft-queue';

function load(): Record<string, QueuedDraft[]> {
    const raw = mmkv.getString(STORAGE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return {};
        // MIGRATION (2026-07-27): the retired offline-queue shipped items with
        // reason 'network' (+ a timedOut flag) that the current code would
        // silently hide — losing the user's stuck messages. Surface them as
        // plain DRAFTS instead: visible in the Drafts strip, manually sendable
        // or deletable. Clear stale release state so nothing auto-fires.
        for (const queue of Object.values(parsed as Record<string, QueuedDraft[]>)) {
            if (!Array.isArray(queue)) continue;
            for (const d of queue) {
                if ((d as { reason?: string }).reason === 'network') {
                    d.reason = 'draft';
                    d.state = 'queued';
                    delete (d as { timedOut?: boolean }).timedOut;
                    d.releaseLocalId = undefined;
                    d.leaseUntil = undefined;
                }
            }
        }
        return parsed;
    } catch {
        return {};
    }
}

// update() is wired to onChangeText, so persisting inline would JSON.stringify
// every session's drafts and hit MMKV once PER KEYSTROKE. Debounce on a short
// trailing timer; add/remove flush immediately (they're rare and it keeps a
// just-queued/just-sent draft durable even if the app dies right after).
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(bySession: Record<string, QueuedDraft[]>) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    mmkv.set(STORAGE_KEY, JSON.stringify(bySession));
}

function persistDebounced(get: () => DraftQueueState) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => persist(get().bySession), 500);
}

export const useDraftQueueStore = create<DraftQueueState>((set, get) => ({
    bySession: load(),
    add: (sessionId, text, reason = 'draft') => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: [
                    ...(s.bySession[sessionId] ?? []),
                    { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, text, reason, queuedAt: Date.now() },
                ],
            },
        }));
        persist(get().bySession);
    },
    update: (sessionId, id, text) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                // Editing RECLAIMS the draft (5.6-sol audit #7): clearing the
                // release identity means an in-flight ack for the OLD text can
                // no longer remove the edited draft (ack removal matches on
                // releaseLocalId), and the next release mints a fresh localId
                // instead of colliding with the server's dedupe of the old one.
                [sessionId]: (s.bySession[sessionId] ?? []).map((d) => (d.id === id
                    ? { ...d, text, state: 'queued' as const, releaseLocalId: undefined, leaseUntil: undefined, queuedAt: Date.now() }
                    : d)),
            },
        }));
        persistDebounced(get);
    },
    remove: (sessionId, id) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: (s.bySession[sessionId] ?? []).filter((d) => d.id !== id),
            },
        }));
        persist(get().bySession);
    },
    markReleasing: (sessionId, id, releaseLocalId, leaseUntil) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: (s.bySession[sessionId] ?? []).map((d) => (d.id === id
                    ? { ...d, state: 'releasing' as const, releaseLocalId, leaseUntil }
                    : d)),
            },
        }));
        persist(get().bySession);
    },
    revertRelease: (sessionId, id, error) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: (s.bySession[sessionId] ?? []).map((d) => (d.id === id
                    ? { ...d, state: 'queued' as const, leaseUntil: undefined, attempt: (d.attempt ?? 0) + 1, lastError: error.slice(0, 200) }
                    : d)),
            },
        }));
        persist(get().bySession);
    },
}));

const EMPTY: QueuedDraft[] = [];

export function draftReason(d: QueuedDraft): DraftReason { return d.reason ?? 'draft'; }

// Subscribe to one session's items. The empty case returns a stable reference
// so a session with no items never re-renders on unrelated changes.
export function useDrafts(sessionId: string): QueuedDraft[] {
    return useDraftQueueStore((s) => s.bySession[sessionId] ?? EMPTY);
}
