import * as React from 'react';
import { Session } from '@/sync/storageTypes';
import { t } from '@/text';
import { buildResumeCommand, buildResumeCommandBlock, ResumeCommandBlock } from './resumeCommand';

export type SessionState = 'disconnected' | 'detached' | 'retrying' | 'compacting' | 'thinking' | 'tasks' | 'agents' | 'waiting' | 'permission_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

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
    disconnected:        { color: '#999',    dotColor: '#999',    isPulsing: false, isConnected: false },
    detached:            { color: '#FF3B30', dotColor: '#FF3B30', isPulsing: false, isConnected: false },
    retrying:            { color: '#FF9500', dotColor: '#FF9500', isPulsing: true,  isConnected: true },
    compacting:          { color: '#AF52DE', dotColor: '#AF52DE', isPulsing: true,  isConnected: true },
    permission_required: { color: '#FFCC00', dotColor: '#FFCC00', isPulsing: true,  isConnected: true },
    tasks:               { color: '#30B0C7', dotColor: '#30B0C7', isPulsing: true,  isConnected: true },
    agents:              { color: '#FF2D95', dotColor: '#FF2D95', isPulsing: true,  isConnected: true },
    thinking:            { color: '#007AFF', dotColor: '#007AFF', isPulsing: true,  isConnected: true },
    waiting:             { color: '#34C759', dotColor: '#34C759', isPulsing: false, isConnected: true },
};

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

export function useSessionStatus(session: Session): SessionStatus {
    const isOnline = session.presence === "online" && (Date.now() - session.activeAt < SESSION_STALE_AFTER_MS);
    const hasPermissions = (session.agentState?.requests && Object.keys(session.agentState.requests).length > 0 ? true : false);

    const vibingMessage = React.useMemo(() => {
        return vibingMessages[Math.floor(Math.random() * vibingMessages.length)].toLowerCase() + '…';
    }, [isOnline, hasPermissions, session.thinking]);

    // Detached: Claude died but the daemon still serves the window. Shown red.
    // Only honored while the session's OWN presence is live — joy-tmux keeps
    // heartbeating a detached session, so when the daemon dies presence lapses
    // and it falls back to plain offline (we no longer know it's detached).
    if (isOnline && session.metadata?.joy__state === 'detached') {
        return {
            ...paletteBase('detached'),
            statusText: t('status.detached'),
            shouldShowStatus: true,
        };
    }

    if (!isOnline) {
        return {
            ...paletteBase('disconnected'),
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
        };
    }

    // Long-running processes (servers/daemons the agent tagged <joy-bg
    // long-running>) never complete, so they're NOT in the N/M — they're appended
    // to whatever the real status is, in its normal color, e.g.
    // "ready, 3 background processes". withBg is the single exit point that
    // appends the suffix to every online status below.
    const longRunning = session.metadata?.joy__longRunning ?? 0;
    const withBg = (status: SessionStatus): SessionStatus => longRunning > 0
        ? { ...status, statusText: status.statusText + ', ' + t('status.backgroundProcesses', { count: longRunning }) }
        : status;

    // 500-error auto-retry in progress: the daemon is re-sending a failed turn
    // on a backoff schedule. Shown amber + pulsing, with the attempt count.
    const retry = session.metadata?.joy__retry;
    if (retry) {
        return withBg({
            ...paletteBase('retrying'),
            statusText: t('status.retrying', { attempt: retry.attempt, total: retry.total }),
            shouldShowStatus: true,
        });
    }

    // Compacting: Claude is summarizing its context to free up tokens. Can run
    // for minutes, so it's worth surfacing. Shown purple + pulsing. Ranks above
    // thinking (the turn is effectively paused while this happens).
    if (session.metadata?.joy__compacting) {
        return withBg({
            ...paletteBase('compacting'),
            statusText: t('status.compacting'),
            shouldShowStatus: true,
        });
    }

    // Check if permission is required (yellow)
    if (hasPermissions) {
        return withBg({
            ...paletteBase('permission_required'),
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
        });
    }

    // Finishing background tasks (builds, tests, agents — expected to complete):
    // shown in teal with an N/M progress count. Ranks above thinking so the count
    // wins when a foreground turn is also running. Long-running processes are
    // excluded from this (they're the withBg suffix).
    // Background AGENTS (magenta) rank above finishing shell tasks (teal).
    const agents = session.metadata?.joy__agents;
    if (agents && agents.total > 0) {
        return withBg({
            ...paletteBase('agents'),
            statusText: t('status.agentsRunning', { done: agents.done, total: agents.total }),
            shouldShowStatus: true,
        });
    }

    const tasks = session.metadata?.joy__tasks;
    if (tasks && tasks.total > 0) {
        return withBg({
            ...paletteBase('tasks'),
            statusText: t('status.tasksCompleted', { done: tasks.done, total: tasks.total }),
            shouldShowStatus: true,
        });
    }

    // Ephemeral flag (live socket) OR the persisted mirror — the mirror is what
    // survives an app cold start; it's only trusted while presence is live
    // (isOnline gates this whole branch), so a dead daemon can't freeze it.
    if (session.thinking === true || session.metadata?.joy__thinking != null) {
        return withBg({
            ...paletteBase('thinking'),
            statusText: vibingMessage,
            shouldShowStatus: true,
        });
    }

    // Idle. If background processes are running, surface them next to "ready" in
    // the normal (green) color, e.g. "ready, 3 background processes".
    return withBg({
        ...paletteBase('waiting'),
        statusText: t('status.online'),
        shouldShowStatus: longRunning > 0,
    });
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
export function getSessionAvatarId(session: Session): string {
    if (session.metadata?.machineId && session.metadata?.path) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${session.metadata.machineId}:${session.metadata.path}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * Returns the CLI command to resume a disconnected session, or null if not resumable.
 * Uses flavor-specific commands which work without happy-agent auth.
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
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    
    // Normalize paths to handle trailing slashes
    const normalizedHome = homeDir.endsWith('/') ? homeDir.slice(0, -1) : homeDir;
    const normalizedPath = path;
    
    // Check if path starts with home directory
    if (normalizedPath.startsWith(normalizedHome)) {
        // Replace home directory with ~
        const relativePath = normalizedPath.slice(normalizedHome.length);
        // Add ~ and ensure there's a / after it if needed
        if (relativePath.startsWith('/')) {
            return '~' + relativePath;
        } else if (relativePath === '') {
            return '~';
        } else {
            return '~/' + relativePath;
        }
    }
    
    return path;
}

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

    return osMap[platform.toLowerCase()] || platform;
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
