import { File } from 'expo-file-system';
import { getVoiceAudio } from '../../modules/joy-voice-audio';
import { SpeechDetector, shouldFinishSpeechClip, shouldRotateSilentRecording } from './speechDetector';
import type { SpeechInputCallbacks, SpeechRecording } from './speechInput';

/** iOS needs voice-processing I/O for simultaneous microphone and speaker use. */
export function createSpeechInput(callbacks: SpeechInputCallbacks) {
    const audio = getVoiceAudio();
    let generation = 0;
    let active = false;
    let detector = new SpeechDetector();
    let startedAt = 0;
    let rotating: Promise<void> | null = null;
    let starting: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    let subscriptions: Array<{ remove(): void }> = [];
    const removeListeners = () => { subscriptions.forEach(s => s.remove()); subscriptions = []; };
    const discard = (uri: string) => { const file = new File(uri); if (file.exists) file.delete(); };

    const fail = (error: unknown) => {
        if (!active) return;
        active = false;
        generation++;
        removeListeners();
        stopping = audio.stopRecording().catch(() => {});
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    };
    async function rotate(gen: number, deliver: boolean) {
        const uri = await audio.finishRecording();
        let handedOff = false;
        try {
            if (!active || gen !== generation) return;
            startedAt = Date.now();
            if (deliver) {
                const recording: SpeechRecording = { uri, mimeType: 'audio/wav', name: 'speech.wav', dispose: () => discard(uri) };
                callbacks.onRecording(recording);
                handedOff = true;
            }
        } finally { if (!handedOff) discard(uri); }
    }
    return {
        async start() {
            if (active) { await starting; return; }
            const gen = ++generation;
            active = true;
            const work = (async () => {
                await stopping;
                if (!active || gen !== generation) return;
                detector = new SpeechDetector();
                subscriptions = [
                    audio.addListener('error', event => { if (gen === generation) fail(new Error(event.message)); }),
                    audio.addListener('level', ({ db }) => {
                        if (!active || gen !== generation || rotating) return;
                        const now = Date.now();
                        const event = detector.push(db, now);
                        if (event === 'start') callbacks.onSpeechStart();
                        const deliver = event === 'end' || shouldFinishSpeechClip(detector.isSpeaking, now - startedAt);
                        if (deliver || shouldRotateSilentRecording(detector.isSpeaking, now - startedAt)) {
                            detector.reset();
                            rotating = rotate(gen, deliver).catch(fail).finally(() => { rotating = null; });
                        }
                    }),
                ];
                await audio.startRecording();
                startedAt = Date.now();
                if (!active || gen !== generation) await audio.stopRecording();
            })();
            starting = work;
            try { await work; } catch (error) { fail(error); throw error; }
            finally { if (starting === work) starting = null; }
        },
        async stop() {
            active = false;
            generation++;
            removeListeners();
            detector.reset();
            const previous = stopping;
            const pendingStart = starting;
            const pendingRotation = rotating;
            const work = (async () => {
                await Promise.allSettled([previous, pendingStart, pendingRotation]);
                await audio.stopRecording();
            })();
            stopping = work;
            await work;
        },
    };
}
