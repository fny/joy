import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { SPEECH_DETECTOR, SpeechDetector, shouldFinishSpeechClip, shouldRotateSilentRecording } from './speechDetector';

export type SpeechRecording = {
    uri: string;
    mimeType: string;
    name: string;
    dispose(): void | Promise<void>;
};

export type SpeechInputCallbacks = {
    onSpeechStart(): void;
    onRecording(recording: SpeechRecording): void;
    onError(error: Error): void;
};

const MIME = 'audio/mp4';
const EXT = '.m4a';

/** Native file recorder plus local level detection. Speech audio is only emitted after a phrase ends. */
export function createSpeechInput(callbacks: SpeechInputCallbacks) {
    let generation = 0;
    let enabled = false;
    let recorder: AudioRecorder | null = null;
    let detector = new SpeechDetector();
    let timer: ReturnType<typeof setInterval> | null = null;
    let segmentStartedAt = 0;
    let transitioning = false;
    let transition: Promise<void> | null = null;
    let starting: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    let cleanup: Promise<void> | null = null;

    function deleteFile(uri: string | null): void {
        if (!uri) return;
        try {
            const file = new File(uri);
            if (file.exists) file.delete();
        } catch { /* best effort for interrupted/partial recordings */ }
    }

    const report = (reason: unknown, expectedGeneration = generation) => {
        if (!enabled || generation !== expectedGeneration) return;
        enabled = false;
        generation++;
        if (timer) clearInterval(timer);
        timer = null;
        const r = recorder;
        recorder = null;
        cleanup = discard(r);
        callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
    };

    async function discard(r: AudioRecorder | null): Promise<void> {
        if (!r) return;
        try { await r.stop(); } catch { /* already stopped */ }
        let uri: string | null = null;
        try { uri = r.uri; } catch { /* released */ }
        try { r.release(); } catch { /* already released */ }
        deleteFile(uri);
    }

    async function open(myGeneration: number): Promise<boolean> {
        let next: AudioRecorder | null = null;
        try {
            next = new AudioModule.AudioRecorder({
                ...RecordingPresets.HIGH_QUALITY,
                numberOfChannels: 1,
                isMeteringEnabled: true,
                android: { ...RecordingPresets.HIGH_QUALITY.android, audioSource: 'voice_communication' },
            });
            await next.prepareToRecordAsync();
            if (!enabled || generation !== myGeneration) { await discard(next); return false; }
            next.record();
            recorder = next;
            segmentStartedAt = Date.now();
            return true;
        } catch (error) {
            await discard(next);
            throw error;
        }
    }

    async function finishClip(myGeneration: number): Promise<void> {
        const r = recorder;
        recorder = null;
        if (!r) return;
        let uri: string | null = null;
        try {
            await r.stop();
            uri = r.uri;
        } catch (error) {
            try { uri = r.uri; } catch { /* released */ }
            try { r.release(); } catch { /* already released */ }
            deleteFile(uri);
            throw error;
        }
        try { r.release(); } catch { /* already released */ }
        if (!uri) return;
        const file = new File(uri);
        const recording: SpeechRecording = {
            uri,
            mimeType: MIME,
            name: `speech-${Date.now()}${EXT}`,
            dispose: () => { try { if (file.exists) file.delete(); } catch { /* best effort */ } },
        };
        let handedOff = false;
        try {
            if (!enabled || generation !== myGeneration) return;
            // Reopen before handing off network work so capture stays continuous.
            if (!await open(myGeneration)) return;
            callbacks.onRecording(recording);
            handedOff = true;
        } finally {
            if (!handedOff) await recording.dispose();
        }
    }

    function tick() {
        if (!enabled || transitioning) return;
        const r = recorder;
        if (!r) return;
        let status;
        const myGeneration = generation;
        try { status = r.getStatus(); } catch (error) { report(error, myGeneration); return; }
        if (status.mediaServicesDidReset || !status.canRecord || !status.isRecording) {
            report(new Error('Microphone recording stopped unexpectedly. Restart voice input to continue.'), myGeneration);
            return;
        }
        const now = Date.now();
        if (typeof status.metering === 'number') {
            const event = detector.push(status.metering, now);
            if (event === 'start') callbacks.onSpeechStart();
            if (event === 'end') {
                detector = new SpeechDetector();
                transitioning = true;
                transition = finishClip(myGeneration).catch(error => report(error, myGeneration)).finally(() => { transitioning = false; transition = null; });
                return;
            }
        }
        const elapsed = now - segmentStartedAt;
        if (shouldFinishSpeechClip(detector.isSpeaking, elapsed)) {
            detector = new SpeechDetector();
            transitioning = true;
            transition = finishClip(myGeneration).catch(error => report(error, myGeneration)).finally(() => { transitioning = false; transition = null; });
        } else if (shouldRotateSilentRecording(detector.isSpeaking, elapsed)) {
            transitioning = true;
            transition = (async () => {
                const old = recorder;
                recorder = null;
                await discard(old);
                if (enabled && generation === myGeneration) await open(myGeneration);
            })().catch(error => report(error, myGeneration)).finally(() => { transitioning = false; transition = null; });
        }
    }

    return {
        async start(): Promise<void> {
            if (enabled) return;
            const myGeneration = ++generation;
            enabled = true;
            const previousStart = starting;
            const previousStop = stopping;
            const work = (async () => {
                try {
                    await previousStart;
                    await transition;
                    await previousStop;
                    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
                    if (!enabled || generation !== myGeneration) return;
                    if (!await open(myGeneration)) return;
                    timer = setInterval(tick, SPEECH_DETECTOR.sampleMs);
                } catch (error) {
                    report(error, myGeneration);
                    throw error;
                }
            })();
            starting = work;
            try { await work; }
            finally { if (starting === work) starting = null; }
        },
        async stop(): Promise<void> {
            if (stopping) return stopping;
            enabled = false;
            generation++;
            const stopGeneration = generation;
            if (timer) clearInterval(timer);
            timer = null;
            detector.reset();
            const priorStart = starting;
            const priorTransition = transition;
            const priorCleanup = cleanup;
            const work = (async () => {
                await Promise.allSettled([priorStart, priorTransition, priorCleanup].filter((p): p is Promise<void> => p !== null));
                if (generation !== stopGeneration) return;
                const r = recorder;
                recorder = null;
                await discard(r);
            })();
            stopping = work;
            try { await work; }
            finally { if (stopping === work) stopping = null; }
        },
    };
}
