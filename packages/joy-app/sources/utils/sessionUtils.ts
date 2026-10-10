import { avatarIdFor } from './avatarId';
import { safeGet } from '@/utils/safeGet';
import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { buildResumeCommand, buildResumeCommandBlock, ResumeCommandBlock } from './resumeCommand';
import { formatPathRelativeToHome } from './pathUtils';
import { stabilizeOnline, sameOnlineState, nextOnlineWake, OFFLINE_GRACE_MS, type OnlineHysteresisState } from './onlineHysteresis';
import { sessionFacts, statusState, type SessionFacts } from '@/sync/sessionFacts';
import { statusText as statusTextFor } from './statusLabel';

// SessionState moved next to the facts it projects (sessionFacts.ts); re-exported
// here so the components that render a badge keep importing it from one place.
export type { SessionState } from '@/sync/sessionFacts';
import type { SessionState } from '@/sync/sessionFacts';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

// Re-exported so every existing importer keeps working; it lives in
// statusPalette.ts because pure modules need it and cannot take this file's
// react-native import graph.
import { STATUS_PALETTE } from './statusPalette';
export { STATUS_PALETTE };

/** Base SessionStatus fields (state + colors + pulsing/connected) from the shared palette. */
function paletteBase(state: SessionState): Pick<SessionStatus, 'state' | 'isConnected' | 'statusColor' | 'statusDotColor' | 'isPulsing'> {
    const p = STATUS_PALETTE[state];
    return { state, isConnected: p.isConnected, statusColor: p.color, statusDotColor: p.dotColor, isPulsing: p.isPulsing };
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
// Mirror of storage.ts SESSION_STALE_AFTER_MS — a dead daemon stays server-side
// active:true until the ~10-min reaper, so treat activity older than this (well
// above the 30s keepalive) as offline at render time too.
const SESSION_STALE_AFTER_MS = 90_000;

/**
 * The online reading, debounced in the offline direction only (#649).
 *
 * Going offline replaces the whole composer with the Resume button, so a
 * momentary blip — one late keepalive against the 90s window — was showing
 * that button and taking it away again.
 *
 * The raw reading is time-based (`staleAt` is when it lapses), so something
 * must re-render at that boundary or the flip lands on an unrelated render.
 * That used to be a 2 s interval in EVERY caller — one per session row in the
 * sidebar, each re-rendering its row forever (a third of the app's idle CPU
 * with 150 sessions). Now one timeout wakes at the next moment the reading can
 * actually change, and none runs while nothing can.
 */
function useStableOnline(raw: boolean, staleAt: number | null): boolean {
    const [state, setState] = React.useState<OnlineHysteresisState>(
        () => ({ stable: raw, offlineSince: raw ? null : Date.now() }),
    );

    const [, tick] = React.useReducer((c: number) => c + 1, 0);
    const wakeAt = nextOnlineWake({ raw, staleAt, state, graceMs: OFFLINE_GRACE_MS });
    React.useEffect(() => {
        if (wakeAt === null) return;
        // A little past the boundary, so the re-render reads the far side of it.
        const id = setTimeout(tick, Math.max(0, wakeAt - Date.now()) + 50);
        return () => clearTimeout(id);
    }, [wakeAt]);

    // Runs every render (the raw reading changes without a dep to key on) and
    // returns the SAME object when nothing moved, so this cannot loop.
    React.useEffect(() => {
        setState((prev) => {
            const next = stabilizeOnline({ ...prev, raw, now: Date.now(), graceMs: OFFLINE_GRACE_MS });
            return sameOnlineState(prev, next) ? prev : next;
        });
    });

    return state.stable;
}

/**
 * One shared minute clock for "last seen 5 minutes ago": a single interval for
 * the whole app, running only while something subscribes. An offline status
 * subscribes so its relative time stays true; an online one never needs it.
 */
let minute = 0;
let minuteTimer: ReturnType<typeof setInterval> | null = null;
const minuteListeners = new Set<() => void>();
function subscribeMinute(listener: () => void): () => void {
    minuteListeners.add(listener);
    if (!minuteTimer) minuteTimer = setInterval(() => { minute++; for (const l of minuteListeners) l(); }, 60_000);
    return () => {
        minuteListeners.delete(listener);
        if (minuteListeners.size === 0 && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null; }
    };
}
const noSubscription = () => () => {};
function useMinuteClock(enabled: boolean): void {
    React.useSyncExternalStore(enabled ? subscribeMinute : noSubscription, () => (enabled ? minute : 0), () => 0);
}

/** When an online session's activity window lapses; null when it reads offline anyway. */
function onlineStaleAt(session: Session): number | null {
    return session.presence === "online" ? session.activeAt + SESSION_STALE_AFTER_MS : null;
}

export function useSessionStatus(session: Session): SessionStatus {
    // Instantaneous reading. It depends on Date.now(), so nothing re-renders
    // when the staleness window lapses — useStableOnline supplies both the
    // clock and the hysteresis (#649).
    const rawOnline = session.presence === "online" && (Date.now() - session.activeAt < SESSION_STALE_AFTER_MS);
    const isOnline = useStableOnline(rawOnline, onlineStaleAt(session));
    useMinuteClock(!isOnline); // keeps "last seen …" current

    // Every fact about the session, derived once. The nine-branch ladder that
    // used to be written out here — and again, separately, in storage.ts's
    // buildSessionRowData — is now `statusState`, so the header and the sidebar
    // row cannot disagree about which state wins. What stays here is the part
    // that is genuinely presentational: the wording, and the background suffix.
    const facts = sessionFacts(session, isOnline);
    const state = statusState(facts);

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [isOnline, facts.permission, session.thinking]);

    // The wording lives in statusLabel.ts, shared with the sidebar row — which
    // used to keep its own chain and its own copy of the background suffix, and
    // fell through to "online" under a coloured dot for any state it had not
    // been taught. Only what needs this component's clock stays here.
    const statusText = statusTextFor(state, facts, {
        vibing: vibingMessage,
        lastSeen: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
    });

    return {
        ...paletteBase(state),
        statusText,
        // "ready" is the absence of news, so the session screen stays quiet for
        // it — unless there are long-running processes worth naming.
        shouldShowStatus: state !== 'waiting' || facts.longRunning > 0,
    };
}

/** The derived facts behind a session's status, for anything that needs more
 *  than the single badge `useSessionStatus` collapses them to. */
export function useSessionFacts(session: Session): SessionFacts {
    const rawOnline = session.presence === "online" && (Date.now() - session.activeAt < SESSION_STALE_AFTER_MS);
    return sessionFacts(session, useStableOnline(rawOnline, onlineStaleAt(session)));
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: Session): string {
    if (session.metadata?.summary) {
        return session.metadata.summary.text;
    }
    return t('session.newChat');
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
/** The stored, project-seeded id — what everything outside the session list
 *  still means by "this session's avatar". The list re-seeds at render time
 *  from the same parts (see hooks/useIdenticonSeed). */
export function getSessionAvatarId(session: Session): string {
    return avatarIdFor({
        id: session.id,
        machineId: session.metadata?.machineId,
        path: session.metadata?.path,
        flavor: session.metadata?.flavor,
    });
}

/**
 * Returns the CLI command to resume a disconnected session, or null if not resumable.
 * Built from the session's agent ids (claude session / codex thread).
 */
export function getResumeCommand(session: Session): string | null {
    return buildResumeCommand(session.metadata ?? {});
}

export function getResumeCommandBlock(session: Session): ResumeCommandBlock | null {
    return buildResumeCommandBlock(session.metadata ?? {});
}

/**
 * Formats a path relative to home directory if possible.
 * If the path starts with the home directory, replaces it with ~
 * Otherwise returns the full path.
 */
// Moved to pathUtils (boundary-aware, #193); re-exported for existing importers.
export { formatPathRelativeToHome };

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: Session): string {
    if (session.metadata) {
        return formatPathRelativeToHome(session.metadata.path, session.metadata.homeDir);
    }
    return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
}

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';

    const osMap: Record<string, string> = {
        'darwin': 'macOS',
        'win32': 'Windows',
        'linux': 'Linux',
        'android': 'Android',
        'ios': 'iOS',
        'aix': 'AIX',
        'freebsd': 'FreeBSD',
        'openbsd': 'OpenBSD',
        'sunos': 'SunOS'
    };

    // Own-property read: a platform string of "__proto__"/"constructor" from
    // machine metadata used to return Object.prototype / the Object function
    // as the "display string" (#453). Unknown platforms echo the input.
    return safeGet(osMap, platform.toLowerCase()) ?? platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) {
        return t('status.activeNow');
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else if (diffDays < 7) {
        return t('sessionHistory.daysAgo', { count: diffDays });
    } else {
        // Format as date
        const date = new Date(activeAt);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}

export const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
