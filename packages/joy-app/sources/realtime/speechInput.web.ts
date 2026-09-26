import { SPEECH_DETECTOR, SpeechDetector, shouldFinishSpeechClip, shouldRotateSilentRecording } from './speechDetector';
import type { SpeechInputCallbacks, SpeechRecording } from './speechInput';

const CANDIDATE_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const STOP_TIMEOUT_MS = 2_000;

/** Web capture uses a fresh MediaRecorder/container for every phrase. */
export function createSpeechInput(callbacks: SpeechInputCallbacks) {
    let generation = 0;
    let enabled = false;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let samples: Float32Array<ArrayBuffer> | null = null;
    let mediaRecorder: MediaRecorder | null = null;
    let mimeType = '';
    let timer: ReturnType<typeof setInterval> | null = null;
    let detector = new SpeechDetector();
    let segmentStartedAt = 0;
    let transition: Promise<void> | null = null;
    let starting: Promise<void> | null = null;
    let stopping: Promise<void> | null = null;
    const expectedStops = new WeakSet<MediaRecorder>();
    const stoppedRecordings = new WeakMap<MediaRecorder, Promise<Blob>>();

    function asError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    function report(error: unknown, expectedGeneration = generation) {
        if (!enabled || generation !== expectedGeneration) return;
        enabled = false;
        generation++;
        if (timer) clearInterval(timer);
        timer = null;
        const r = mediaRecorder;
        mediaRecorder = null;
        if (r && r.state !== 'inactive') {
            expectedStops.add(r);
            try { r.stop(); } catch { /* recorder already stopping */ }
        }
        stopTracks();
        closeAudioContext();
        callbacks.onError(asError(error));
    }

    function stopTracks() {
        const oldStream = stream;
        stream = null;
        oldStream?.getTracks().forEach(track => {
            track.stop();
        });
    }

    function closeAudioContext() {
        try { source?.disconnect(); } catch { /* already disconnected */ }
        source = null;
        analyser = null;
        samples = null;
        const oldContext = context;
        context = null;
        if (oldContext) void oldContext.close().catch(() => {});
    }

    function onTrackEnded(myGeneration: number) {
        return () => report(new Error('Microphone input ended. Restart voice input to continue.'), myGeneration);
    }

    function newRecorder(myGeneration: number): MediaRecorder {
        if (!stream) throw new Error('Microphone stream is unavailable');
        const selectedMime = CANDIDATE_MIMES.find(type => MediaRecorder.isTypeSupported(type));
        const r = new MediaRecorder(stream, selectedMime ? { mimeType: selectedMime } : undefined);
        const actualMime = r.mimeType || selectedMime || 'audio/webm';
        let parts: Blob[] = [];
        let settled = false;
        let resolveStop!: (blob: Blob) => void;
        const stopped = new Promise<Blob>(resolve => { resolveStop = resolve; });

        r.addEventListener('dataavailable', event => {
            if (mediaRecorder === r && enabled && generation === myGeneration && event.data.size) parts.push(event.data);
        });
        r.addEventListener('error', event => {
            const error = new Error(`Microphone recorder failed: ${event.type}`);
            if (mediaRecorder === r && generation === myGeneration) report(error, myGeneration);
        });
        r.addEventListener('stop', () => {
            if (mediaRecorder === r) mediaRecorder = null;
            if (!settled) {
                settled = true;
                resolveStop(new Blob(parts, { type: actualMime }));
            }
            if (!expectedStops.has(r) && enabled && generation === myGeneration) {
                report(new Error('Microphone recorder stopped unexpectedly. Restart voice input to continue.'), myGeneration);
            }
        });
        r.start();
        mediaRecorder = r;
        mimeType = actualMime;
        stoppedRecordings.set(r, stopped);
        segmentStartedAt = Date.now();
        return r;
    }

    async function stopRecorder(r: MediaRecorder): Promise<Blob> {
        expectedStops.add(r);
        const stopped = stoppedRecordings.get(r);
        if (!stopped) throw new Error('Microphone recorder has no stop completion handler');
        if (r.state !== 'inactive') r.stop();
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeout = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Timed out while finalizing microphone audio')), STOP_TIMEOUT_MS);
        });
        try { return await Promise.race([stopped, timeout]); }
        finally { if (timeoutId) clearTimeout(timeoutId); }
    }

    function recordingFor(blob: Blob, actualMime: string): SpeechRecording | null {
        if (!blob.size) return null;
        const uri = URL.createObjectURL(blob);
        const ext = actualMime.includes('mp4') ? '.m4a' : '.webm';
        let disposed = false;
        return {
            uri,
            mimeType: actualMime.split(';')[0],
            name: `speech-${Date.now()}${ext}`,
            dispose: () => { if (!disposed) { disposed = true; URL.revokeObjectURL(uri); } },
        };
    }

    async function finalizeSegment(myGeneration: number, deliver: boolean): Promise<void> {
        const r = mediaRecorder;
        if (!r) return;
        const actualMime = r.mimeType || mimeType;
        const blob = await stopRecorder(r);
        if (!enabled || generation !== myGeneration) return;
        // A stopped MediaRecorder has a complete standalone container. Reopen capture before upload.
        newRecorder(myGeneration);
        if (!deliver) return;
        const recording = recordingFor(blob, actualMime);
        if (!recording) return;
        try { callbacks.onRecording(recording); }
        catch (error) { await recording.dispose(); throw error; }
    }

    function levelDb(): number {
        if (!analyser || !samples) return -160;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        return rms > 0 ? 20 * Math.log10(rms) : -160;
    }

    function beginTransition(myGeneration: number, deliver: boolean) {
        if (transition) return;
        transition = finalizeSegment(myGeneration, deliver)
            .catch(error => report(error, myGeneration))
            .finally(() => { transition = null; });
    }

    function tick() {
        if (!enabled || transition) return;
        const event = detector.push(levelDb(), Date.now());
        if (event === 'start') callbacks.onSpeechStart();
        if (event === 'end') {
            detector = new SpeechDetector();
            beginTransition(generation, true);
            return;
        }
        const elapsed = Date.now() - segmentStartedAt;
        if (shouldFinishSpeechClip(detector.isSpeaking, elapsed)) {
            detector = new SpeechDetector();
            beginTransition(generation, true);
        } else if (shouldRotateSilentRecording(detector.isSpeaking, elapsed)) {
            beginTransition(generation, false);
        }
    }

    return {
        async start(): Promise<void> {
            if (enabled) return;
            const myGeneration = ++generation;
            enabled = true;
            const previousStart = starting;
            const previousStop = stopping;
            // Create/resume synchronously inside the initiating user gesture.
            let ownContext: AudioContext;
            try {
                ownContext = new AudioContext();
                void ownContext.resume().catch(() => {});
            } catch (error) {
                report(error, myGeneration);
                throw asError(error);
            }
            const work = (async () => {
                try {
                    await previousStart;
                    await transition;
                    await previousStop;
                    if (!enabled || generation !== myGeneration) {
                        await ownContext.close().catch(() => {});
                        return;
                    }
                    const pendingStream = await navigator.mediaDevices.getUserMedia({
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                    });
                    if (!enabled || generation !== myGeneration) {
                        pendingStream.getTracks().forEach(track => track.stop());
                        await ownContext.close().catch(() => {});
                        return;
                    }
                    stream = pendingStream;
                    context = ownContext;
                    for (const track of stream.getAudioTracks()) track.addEventListener('ended', onTrackEnded(myGeneration), { once: true });
                    source = context.createMediaStreamSource(stream);
                    analyser = context.createAnalyser();
                    analyser.fftSize = 2048;
                    source.connect(analyser);
                    samples = new Float32Array(analyser.fftSize);
                    detector = new SpeechDetector();
                    newRecorder(myGeneration);
                    timer = setInterval(tick, SPEECH_DETECTOR.sampleMs);
                } catch (error) {
                    if (context !== ownContext) await ownContext.close().catch(() => {});
                    report(error, myGeneration);
                    throw asError(error);
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
            if (timer) clearInterval(timer);
            timer = null;
            detector.reset();
            const priorStart = starting;
            const priorTransition = transition;
            const work = (async () => {
                await Promise.allSettled([priorStart, priorTransition].filter((p): p is Promise<void> => p !== null));
                const r = mediaRecorder;
                if (r) {
                    try { await stopRecorder(r); } catch { /* cancellation discards partial audio */ }
                    if (mediaRecorder === r) mediaRecorder = null;
                }
                stopTracks();
                closeAudioContext();
            })();
            stopping = work;
            try { await work; }
            finally { if (stopping === work) stopping = null; }
        },
    };
}
