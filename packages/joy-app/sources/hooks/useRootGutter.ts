import { create } from 'zustand';

/**
 * Background color of the root safe-area gutters — the strips outside the
 * horizontal insets in landscape (notch side / rounded corners). The root
 * layout pads the whole app in by insets.left/right; without a painted
 * background those strips showed the bare native window (white).
 *
 * Default (null) means "use the theme background". Full-bleed dark screens
 * (the terminal pane) set an override while focused so the gutters melt into
 * their own background instead of flashing theme-colored bars.
 */
interface RootGutterState {
    color: string | null;
    setColor: (color: string | null) => void;
}

export const useRootGutter = create<RootGutterState>((set) => ({
    color: null,
    setColor: (color) => set({ color }),
}));
