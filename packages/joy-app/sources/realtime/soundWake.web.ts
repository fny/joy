// Web/desktop variant of the idle sound detector: an AnalyserNode on the mic
// stream, RMS level, same heuristic as native (soundWakeDetector.ts).
import { isLatest, nextGen, retire } from '@/utils/latest';
import { SOUND_WAKE, SpeechDetector } from './soundWakeDetector';

// One generation per start: a stop retires it, so a microphone acquisition
// that resolves after the stop releases its tracks instead of listening on
// (#348), and a stop's async context close only touches the context it
// captured, never a replacement detector's (#349).
const KEY = 'soundWake.web';

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let detector: SpeechDetector | null = null;
// The ambient floor survives restarts so a noisy room does not re-trigger on
// every return to idle (#347).
let lastFloor: number | null = null;

export async function startSoundWake(onSpeech: () => void): Promise<void> {
    if (stream || timer) return;
    const gen = nextGen(KEY);
    let acquired: MediaStream;
    try {
        acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        if (isLatest(KEY, gen)) console.warn('[voice] sound wake unavailable:', e);
        return;
    }
    if (!isLatest(KEY, gen) || stream || timer) {
        // Stopped (or restarted) while the browser was asking for the mic.
        acquired.getTracks().forEach(t => t.stop());
        return;
    }
    try {
        stream = acquired;
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const d = new SpeechDetector(lastFloor ?? undefined);
        detector = d;
        timer = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            const level = rms > 0 ? 20 * Math.log10(rms) : -100;
            if (d.push(level)) {
                void stopSoundWake().then(onSpeech);
            }
        }, SOUND_WAKE.SAMPLE_MS);
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        await stopSoundWake();
    }
}

export async function stopSoundWake(): Promise<void> {
    retire(KEY); // a start still waiting on getUserMedia must not take the mic
    if (timer) { clearInterval(timer); timer = null; }
    if (detector) { lastFloor = detector.floor; detector = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    // Detach BEFORE awaiting the close: a restart during the await stores a
    // new context in `ctx`, which this stop must leave alone.
    const closing = ctx;
    ctx = null;
    if (closing) { try { await closing.close(); } catch { /* closed */ } }
}

export function isSoundWakeListening(): boolean {
    return stream !== null;
}
