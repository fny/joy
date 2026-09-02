// Rolling capture of the spoken conversation (user ↔ Joy). Survives hang-ups
// while voice stays ARMED, so a reconnect (idle hang-up, drop, event wake)
// hands the agent the thread it was in. Cleared only when voice is fully
// ended from the status bar.

export type VoiceTurnRole = 'user' | 'agent';
interface VoiceTurn { role: VoiceTurnRole; text: string; at: number; }

const MAX_TURNS = 40;
const MAX_CHARS = 6000;

let turns: VoiceTurn[] = [];

/** Record a turn from the SDK's onMessage payload. Web and native payloads
 *  differ in detail, so extract role + text tolerantly. */
export function recordVoiceMessage(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as Record<string, unknown>;
    const text = typeof d.message === 'string' ? d.message
        : typeof d.text === 'string' ? d.text
            : null;
    if (!text || !text.trim()) return;
    const source = typeof d.source === 'string' ? d.source : (typeof d.role === 'string' ? d.role : '');
    const role: VoiceTurnRole = source === 'user' ? 'user' : 'agent';
    turns.push({ role, text: text.trim(), at: Date.now() });
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
}

/** Formatted recent transcript (oldest→newest), trimmed from the front to
 *  MAX_CHARS, or null when nothing has been said yet. */
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

/** When the last spoken turn happened (ms epoch), or null. */
export function lastVoiceTurnAt(): number | null {
    return turns.length ? turns[turns.length - 1].at : null;
}

export function clearVoiceTranscript(): void {
    turns = [];
}
