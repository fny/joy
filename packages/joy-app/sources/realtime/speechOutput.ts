import { File, Paths } from 'expo-file-system';
import { randomUUID } from 'expo-crypto';
import { getVoiceAudio } from '../../modules/joy-voice-audio';
import type { SpeechOutput } from './types';

export function createSpeechOutput(): SpeechOutput {
    let disposed = false;
    const audio = getVoiceAudio();
    return {
        async prepare() { /* Native audio ownership starts after microphone permission. */ },
        async play(wav, signal) {
            if (disposed || signal.aborted) return;
            const file = new File(Paths.cache, `joy-speech-${randomUUID()}.wav`);
            const abort = () => { void audio.stopPlayback().catch(() => {}); };
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                file.write(wav);
                await audio.preparePlayback();
                if (disposed || signal.aborted) return;
                signal.addEventListener('abort', abort, { once: true });
                // Bound native failures (route changes can otherwise strand a completion).
                const timedOut = new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => { abort(); reject(new Error('Speech playback timed out.')); }, 90_000);
                });
                await Promise.race([audio.play(file.uri), timedOut]);
            } finally {
                if (timeout) clearTimeout(timeout);
                signal.removeEventListener('abort', abort);
                if (file.exists) file.delete();
            }
        },
        async dispose() { disposed = true; await audio.disposePlayback(); },
    };
}
