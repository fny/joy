// The status palette, in its own module with NO react-native in its import
// graph, so pure logic can read it.
//
// It used to live in sessionUtils.ts, which pulls in React and react-native
// through its hooks — importing it from sync/sessionListModel.ts (which is
// deliberately dependency-free so its specs need no store) broke the whole
// suite on react-native's Flow syntax. Ordering the pinned section BY COLOUR
// needs the colours, so the colours moved somewhere anything can reach.
//
import type { SessionState } from '@/sync/sessionFacts';

/**
 * SINGLE SOURCE OF TRUTH for status colors + pulsing/connected per state. BOTH
 * the session-screen footer (useSessionStatus, below) and the sidebar
 * (SessionsList) render from this map — they previously kept separate copies
 * that drifted, so a session finishing background tasks showed teal in the
 * footer but orange in the sidebar (and permission_required yellow vs orange).
 * Only color/pulsing/connected live here; statusText + shouldShowStatus stay
 * contextual and are computed per-branch in useSessionStatus.
 */
export const STATUS_PALETTE: Record<SessionState, { color: string; dotColor: string; isPulsing: boolean; isConnected: boolean }> = {
    // Offline: a lighter grey than read-and-idle, so the two greys are two
    // positions in the pinned order (and two looks) — the row also dims its
    // title and desaturates its avatar.
    disconnected:        { color: '#C7C7CC', dotColor: '#C7C7CC', isPulsing: false, isConnected: false },
    detached:            { color: '#FF3B30', dotColor: '#FF3B30', isPulsing: false, isConnected: false },
    retrying:            { color: '#FF9500', dotColor: '#FF9500', isPulsing: true,  isConnected: true },
    compacting:          { color: '#AF52DE', dotColor: '#AF52DE', isPulsing: true,  isConnected: true },
    permission_required: { color: '#FFCC00', dotColor: '#FFCC00', isPulsing: true,  isConnected: true },
    // Same "waiting on you" family as permission_required, but not pulsing:
    // nothing is in progress behind it, which is the point.
    blocked:             { color: '#FFCC00', dotColor: '#FFCC00', isPulsing: false, isConnected: true },
    // Amber like retrying — something is off — but not pulsing: pulsing says
    // "in progress", and the whole point is that nothing observable is.
    stalled:             { color: '#FF9500', dotColor: '#FF9500', isPulsing: false, isConnected: true },
    tasks:               { color: '#30B0C7', dotColor: '#30B0C7', isPulsing: true,  isConnected: true },
    agents:              { color: '#FF2D95', dotColor: '#FF2D95', isPulsing: true,  isConnected: true },
    thinking:            { color: '#007AFF', dotColor: '#007AFF', isPulsing: true,  isConnected: true },
    // Online, idle, and you have seen it: grey. Green is UNREAD's alone —
    // the two used to share it, so a read idle session looked unread.
    waiting:             { color: '#8E8E93', dotColor: '#8E8E93', isPulsing: false, isConnected: true },
    unread:              { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
};

