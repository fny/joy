// Web/desktop variant of the idle sound detector: an AnalyserNode on the mic
// stream, RMS level, same floor-relative heuristic as native.
const SAMPLE_MS = 100;
const SPEECH_DB_ABOVE_FLOOR = 12;
const MIN_SPEECH_DB = -40;
const SPEECH_SAMPLES_NEEDED = 4;
const WINDOW_SAMPLES = 10;
const FLOOR_ADAPT = 0.05;

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export async function startSoundWake(onSpeech: () => void): Promise<void> {
    if (stream || timer) return;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        let floor = -60;
        const window: boolean[] = [];
        timer = setInterval(() => {
            analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
            const rms = Math.sqrt(sum / buf.length);
            const level = rms > 0 ? 20 * Math.log10(rms) : -100;
            if (level < floor + SPEECH_DB_ABOVE_FLOOR) floor = floor + (level - floor) * FLOOR_ADAPT;
            const voiced = level > MIN_SPEECH_DB && level > floor + SPEECH_DB_ABOVE_FLOOR;
            window.push(voiced);
            if (window.length > WINDOW_SAMPLES) window.shift();
            if (window.filter(Boolean).length >= SPEECH_SAMPLES_NEEDED) {
                window.length = 0;
                void stopSoundWake().then(onSpeech);
            }
        }, SAMPLE_MS);
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        await stopSoundWake();
    }
}

export async function stopSoundWake(): Promise<void> {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    if (ctx) { try { await ctx.close(); } catch { /* closed */ } ctx = null; }
}

export function isSoundWakeListening(): boolean {
    return stream !== null;
}
