// Local "is someone talking?" detector used while Joy is IDLE (armed but hung
// up). Runs on the device only — nothing is billed, nothing leaves the phone.
// Uses expo-audio's recorder metering (dBFS) so it works on the native build
// we already ship; the recording itself is throwaway.
//
// Speech heuristic: level above a floor-relative threshold for a few
// consecutive samples inside a short window, and the floor adapts slowly so a
// constant hum (fan, road noise) does not count. It is sound-level detection,
// not word recognition: a TV or a nearby conversation can wake it.
import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';

const SAMPLE_MS = 100;
const SPEECH_DB_ABOVE_FLOOR = 12;   // how far above the ambient floor counts as speech
const MIN_SPEECH_DB = -40;          // absolute minimum (dBFS) so a silent room never triggers
const SPEECH_SAMPLES_NEEDED = 4;    // ≈400ms of voiced sound within the window
const WINDOW_SAMPLES = 10;          // ≈1s window
const FLOOR_ADAPT = 0.05;

let recorder: AudioRecorder | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let stopping = false;

export async function startSoundWake(onSpeech: () => void): Promise<void> {
    if (recorder || timer) return;
    stopping = false;
    try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        const r = new AudioModule.AudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
        await r.prepareToRecordAsync();
        if (stopping) { r.release(); return; }
        r.record();
        recorder = r;
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        recorder = null;
        return;
    }

    let floor = -60;
    const window: boolean[] = [];
    timer = setInterval(() => {
        const r = recorder;
        if (!r) return;
        let level: number | undefined;
        try { level = r.getStatus().metering; } catch { return; }
        if (typeof level !== 'number' || !isFinite(level)) return;
        // Adapt the floor only on quiet samples so speech does not raise it.
        if (level < floor + SPEECH_DB_ABOVE_FLOOR) floor = floor + (level - floor) * FLOOR_ADAPT;
        const voiced = level > MIN_SPEECH_DB && level > floor + SPEECH_DB_ABOVE_FLOOR;
        window.push(voiced);
        if (window.length > WINDOW_SAMPLES) window.shift();
        const count = window.filter(Boolean).length;
        if (count >= SPEECH_SAMPLES_NEEDED) {
            window.length = 0;
            void stopSoundWake().then(onSpeech);
        }
    }, SAMPLE_MS);
}

export async function stopSoundWake(): Promise<void> {
    stopping = true;
    if (timer) { clearInterval(timer); timer = null; }
    const r = recorder;
    recorder = null;
    if (!r) return;
    try { await r.stop(); } catch { /* not recording */ }
    try { r.release(); } catch { /* already released */ }
}

export function isSoundWakeListening(): boolean {
    return recorder !== null;
}
