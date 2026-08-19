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
}

export const useSessionSearch = create<SessionSearchState>((set) => ({
    open: false,
    setOpen: (open) => set({ open }),
    toggle: () => set((s) => ({ open: !s.open })),
}));
