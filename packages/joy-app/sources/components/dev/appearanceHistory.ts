import { create } from 'zustand';
import { storage } from '@/sync/storage';
import { applyAppearance } from '@/palettes';
import { setDefaultFontFamily } from '@/constants/Typography';

// The full appearance state lives in four local settings. An undo step is a
// snapshot of those four. History is in-memory (resets on reload) — it's a
// dev-tool convenience, not persisted state.
export interface AppearanceSnapshot {
    themePalette: string;
    customPalette: Record<string, string> | null;
    accentOverrides: Record<string, string> | null;
    fontOverride: string | null;
}

export function captureAppearance(): AppearanceSnapshot {
    const ls = storage.getState().localSettings;
    return {
        themePalette: ls.themePalette,
        customPalette: ls.customPalette,
        accentOverrides: ls.accentOverrides,
        fontOverride: ls.fontOverride,
    };
}

function applySnapshot(s: AppearanceSnapshot) {
    storage.getState().applyLocalSettings({
        themePalette: s.themePalette,
        customPalette: s.customPalette,
        accentOverrides: s.accentOverrides,
        fontOverride: s.fontOverride,
    });
    setDefaultFontFamily(s.fontOverride);
    applyAppearance(s.themePalette, s.customPalette, s.accentOverrides);
}

interface HistoryState {
    past: AppearanceSnapshot[];
    // The field currently being edited; consecutive edits to the same field
    // coalesce into one undo step instead of one-per-keystroke.
    activeKey: string | null;
    // Record a continuous edit (color field). Pushes the pre-change snapshot
    // only when the edited field changes.
    record: (key: string, before: AppearanceSnapshot) => void;
    // Record a discrete action (palette select, copy, font pick) — always its
    // own undo step.
    commit: (before: AppearanceSnapshot) => void;
    undo: () => void;
}

export const useAppearanceHistory = create<HistoryState>((set, get) => ({
    past: [],
    activeKey: null,
    record: (key, before) => {
        if (get().activeKey === key) return;
        set((st) => ({ past: [...st.past, before].slice(-100), activeKey: key }));
    },
    commit: (before) => set((st) => ({ past: [...st.past, before].slice(-100), activeKey: null })),
    undo: () => {
        const { past } = get();
        if (past.length === 0) return;
        applySnapshot(past[past.length - 1]);
        set({ past: past.slice(0, -1), activeKey: null });
    },
}));
