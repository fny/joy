// Wire shapes for the joy-tmux daemon, shared across joy-app's hooks,
// screens, and components. The daemon speaks snake_case over both HTTP
// (/sessions) and relay RPC (joy-list-sessions, joy-get-session, …).

// List-item shape returned by GET /sessions and the joy-list-sessions RPC.
export interface JoySession {
    id: string;
    cwd: string;
    status: 'starting' | 'active' | 'ended';
    relay_session_id?: string;
    claude_session_id?: string;
    started_at: number;
    tmux_window: string;
    end_reason?: string;
}

// Live single-session record (snake_case wire shape of Session.toJSON()).
// Relay metadata is static after create; this carries what only the daemon
// knows: claude session id, live status, current model, tmux window, pid,
// launch flags. Returned by the joy-get-session RPC.
export type JoySessionRecord = {
    id: string;
    claude_session_id?: string;
    tmux_window?: string;
    cwd?: string;
    pid?: number;
    status?: string;
    current_model?: string;
    effort?: string;
    flags?: string[];
    started_at?: number;
    end_reason?: string;
};
