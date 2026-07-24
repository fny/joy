// Rolling capture of the spoken voice conversation (user ↔ Joy). The SDK's
// onMessage is otherwise discarded (console.log only); we keep a bounded buffer
// so that when a session drops and auto-reconnects, the recent spoken exchange
// can be re-injected as context — the connection restarts, but the CONVERSATION
// continues. Coding-session context is re-derivable from app state; this
// transcript is the volatile part that would otherwise be lost on a drop.

export type VoiceTurnRole = 'user' | 'agent';
interface VoiceTurn { role: VoiceTurnRole; text: string; }

// Keep the tail of the conversation only — enough to preserve the thread
// without bloating the system prompt on reconnect.
const MAX_TURNS = 24;
const MAX_CHARS = 4000;

let turns: VoiceTurn[] = [];

/** Defensively record a turn from the SDK's onMessage payload. The web
 *  (@elevenlabs/react) and native (@elevenlabs/react-native) payloads differ in
 *  detail, so extract role + text tolerantly and drop anything unrecognized
 *  rather than throwing inside the hot message callback. */
export function recordVoiceMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    const text = typeof d.message === 'string' ? d.message
        : typeof d.text === 'string' ? d.text
            : null;
    if (!text || !text.trim()) return;
    const source = typeof d.source === 'string' ? d.source : (typeof d.role === 'string' ? d.role : '');
    const role: VoiceTurnRole = source === 'user' ? 'user' : 'agent';
    turns.push({ role, text: text.trim() });
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
}

/** Formatted recent transcript (oldest→newest), trimmed to MAX_CHARS from the
 *  end, or null when nothing has been said yet. */
export function getRecentVoiceTranscript(): string | null {
    if (turns.length === 0) return null;
    const lines = turns.map((tn) => `${tn.role === 'user' ? 'User' : 'Joy'}: ${tn.text}`);
    let out = lines.join('\n');
    if (out.length > MAX_CHARS) out = '…\n' + out.slice(out.length - MAX_CHARS);
    return out;
}

export function hasVoiceTranscript(): boolean {
    return turns.length > 0;
}

/** Reset on a genuinely NEW conversation (fresh mic tap) or explicit stop — but
 *  NOT across an auto-reconnect, which must retain the thread. */
export function clearVoiceTranscript(): void {
    turns = [];
}
