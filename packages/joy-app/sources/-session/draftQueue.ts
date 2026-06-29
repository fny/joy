import { create } from 'zustand';

// On-device draft queue. Drafts are messages the user has composed but not yet
// sent — they live ONLY in the app (never propagated to joy-tmux) until the user
// sends one, at which point it goes through the normal send path like any other
// message. In-memory by design: a draft is a transient "queue this up to send
// shortly" affordance, not durable state.

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

export const useDraftQueueStore = create<DraftQueueState>((set) => ({
    bySession: {},
    add: (sessionId, text) => set((s) => ({
        bySession: {
            ...s.bySession,
            [sessionId]: [
                ...(s.bySession[sessionId] ?? []),
                { id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, text },
            ],
        },
    })),
    update: (sessionId, id, text) => set((s) => ({
        bySession: {
            ...s.bySession,
            [sessionId]: (s.bySession[sessionId] ?? []).map((d) => (d.id === id ? { ...d, text } : d)),
        },
    })),
    remove: (sessionId, id) => set((s) => ({
        bySession: {
            ...s.bySession,
            [sessionId]: (s.bySession[sessionId] ?? []).filter((d) => d.id !== id),
        },
    })),
}));

const EMPTY: QueuedDraft[] = [];

// Subscribe to one session's drafts. The empty case returns a stable reference
// so a session with no drafts never re-renders on unrelated changes.
export function useDrafts(sessionId: string): QueuedDraft[] {
    return useDraftQueueStore((s) => s.bySession[sessionId] ?? EMPTY);
}
