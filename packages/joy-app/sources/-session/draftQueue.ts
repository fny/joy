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

function persist(bySession: Record<string, QueuedDraft[]>) {
    mmkv.set(STORAGE_KEY, JSON.stringify(bySession));
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
        persist(get().bySession);
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
