import { create } from 'zustand';

// Open/closed state for the in-session message search bar. Lives outside the
// React tree for the same reason as useToolsCollapsed: the HEADER button is
// rendered by SessionView (outer) while the search bar itself belongs to
// SessionViewLoaded (inner), so neither can own the state for the other.
// Cmd/Ctrl+F and the header icon are two doors onto this one switch.
interface SessionSearchState {
    open: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
    /** The live query, so the matched row can highlight it (#639). Scrolling to
     *  a match with nothing marked in it reads as "search doesn't work": you
     *  land on a wall of text with no idea which words were hit. */
    query: string;
    /** The match currently selected in the bar. Only this row highlights, so a
     *  keystroke re-renders one row rather than the whole virtualized list. */
    selectedMessageId: string | null;
    setMatch: (query: string, selectedMessageId: string | null) => void;
}

export const useSessionSearch = create<SessionSearchState>((set) => ({
    open: false,
    // Closing clears the match: a stale highlight left behind after the bar is
    // gone has nothing to explain it.
    setOpen: (open) => set(open ? { open } : { open, query: '', selectedMessageId: null }),
    toggle: () => set((s) => (s.open ? { open: false, query: '', selectedMessageId: null } : { open: true })),
    query: '',
    selectedMessageId: null,
    setMatch: (query, selectedMessageId) => set({ query, selectedMessageId }),
}));
