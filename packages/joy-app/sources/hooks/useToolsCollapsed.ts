import { create } from 'zustand';

// Global "collapse all tool calls" switch for the session chat. Lives outside
// React tree state so the header button (SessionView) and every ToolView can
// share it without threading props through ChatList/MessageView/ToolGroupView.
// nonce bumps on every global toggle so per-card manual overrides (local state
// in ToolView) reset to follow the new global value.
interface ToolsCollapsedState {
    collapsed: boolean;
    nonce: number;
    toggle: () => void;
}

export const useToolsCollapsed = create<ToolsCollapsedState>((set) => ({
    collapsed: false,
    nonce: 0,
    toggle: () => set((s) => ({ collapsed: !s.collapsed, nonce: s.nonce + 1 })),
}));
