import { Platform } from 'react-native';

// True on web when the primary pointer is coarse (touch) — i.e. phones and
// tablets in a browser. Used to attach touch affordances (long-press menus)
// on surfaces where desktop web uses right-click instead. Evaluated once at
// module load; pointer class doesn't change mid-session.
//
// Why this exists: iOS Safari never synthesizes a `contextmenu` event for a
// touch long-press (Android Chrome does), so web surfaces that only wire
// onContextMenu are completely unreachable from an iPhone.
export const isTouchWeb: boolean =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(pointer: coarse)').matches;
