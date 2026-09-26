import { Platform } from 'react-native';
import { apiEndpoint, requestVoiceJson } from './conversationApi';
import type { SpeechRecording } from './speechInput';

export interface TranscriptionConfig { baseUrl: string; model: string; apiKey: string }

export async function transcribe(config: TranscriptionConfig, recording: SpeechRecording, signal: AbortSignal): Promise<string> {
    if (!config.model.trim()) throw new Error('Choose a transcription model in Voice settings.');
    if (signal.aborted) throw Object.assign(new Error('Transcription stopped.'), { name: 'AbortError' });
    const form = new FormData();
    if (Platform.OS === 'web') {
        const response = await fetch(recording.uri, { signal });
        form.append('file', await response.blob(), recording.name);
    } else {
        // React Native serializes local file URIs without a JS/base64 copy.
        form.append('file', { uri: recording.uri, name: recording.name, type: recording.mimeType } as unknown as Blob);
    }
    form.append('model', config.model.trim());
    const data = await requestVoiceJson(apiEndpoint(config.baseUrl, 'audio/transcriptions'), {
        method: 'POST', body: form,
        headers: config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {},
    }, signal) as { text?: unknown } | null;
    if (typeof data?.text !== 'string') throw new Error('Invalid transcription response.');
    return data.text.trim();
}
