import { create } from 'zustand';
import { MMKV } from 'react-native-mmkv';

// On-device draft queue. Drafts are messages the user has composed but not yet
// sent — they live ONLY in the app (never propagated to joy-tmux) until the user
// sends one, at which point it goes through the normal send path like any other
// message. Persisted to MMKV (same manual hydrate/persist idiom as
// useNewSessionDraft), so queued drafts survive a reload / app restart.

export interface QueuedDraft {
    id: string;
    text: string;
}

interface DraftQueueState {
    bySession: Record<string, QueuedDraft[]>;
    add: (sessionId: string, text: string) => void;
    update: (sessionId: string, id: string, text: string) => void;
    remove: (sessionId: string, id: string) => void;
}

const mmkv = new MMKV();
const STORAGE_KEY = 'draft-queue';

function load(): Record<string, QueuedDraft[]> {
    const raw = mmkv.getString(STORAGE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
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
    add: (sessionId, text) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: [
                    ...(s.bySession[sessionId] ?? []),
                    { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, text },
                ],
            },
        }));
        persist(get().bySession);
    },
    update: (sessionId, id, text) => {
        set((s) => ({
            bySession: {
                ...s.bySession,
                [sessionId]: (s.bySession[sessionId] ?? []).map((d) => (d.id === id ? { ...d, text } : d)),
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
}));

const EMPTY: QueuedDraft[] = [];

// Subscribe to one session's drafts. The empty case returns a stable reference
// so a session with no drafts never re-renders on unrelated changes.
export function useDrafts(sessionId: string): QueuedDraft[] {
    return useDraftQueueStore((s) => s.bySession[sessionId] ?? EMPTY);
}
