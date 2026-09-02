// Direct ElevenLabs calls made from the device with the user's own key. There
// is no server in the loop: the key lives in synced (end-to-end encrypted)
// settings and only ever travels to api.elevenlabs.io.
import type { Settings } from '@/sync/settings';

export type VoiceAgent = Settings['voiceAgents'][number];

const API = 'https://api.elevenlabs.io';

/** Mint a single-use WebRTC conversation token for a private agent. */
export async function mintConversationToken(agentId: string, apiKey: string): Promise<string> {
    const res = await fetch(`${API}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`, {
        method: 'GET',
        headers: { 'xi-api-key': apiKey },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`token ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    const json = await res.json() as { token?: string };
    if (!json.token) throw new Error('token missing in response');
    return json.token;
}

/** The agent the user picked, or null when none is configured. */
export function activeVoiceAgent(settings: Pick<Settings, 'voiceAgents' | 'voiceActiveAgentId'>): VoiceAgent | null {
    const list = settings.voiceAgents ?? [];
    if (list.length === 0) return null;
    return list.find(a => a.id === settings.voiceActiveAgentId) ?? list[0];
}
