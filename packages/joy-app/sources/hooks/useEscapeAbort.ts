import { create } from 'zustand';

// Escape-on-the-session-screen contract: Esc must NEVER navigate away from a
// chat (losing your place mid-session), it should abort the running turn when
// there is one and otherwise do nothing. The session screen registers its
// abort here while a turn is abortable; the browser-navigation Esc handler
// (useBrowserNavigationShortcuts) consults it instead of falling through to
// route-back on /session/:id.
interface EscapeAbortState {
    /** Non-null while the visible session screen can abort a running turn. */
    handler: (() => void) | null;
    setHandler: (handler: (() => void) | null) => void;
}

export const useEscapeAbort = create<EscapeAbortState>((set) => ({
    handler: null,
    setHandler: (handler) => set({ handler }),
}));
