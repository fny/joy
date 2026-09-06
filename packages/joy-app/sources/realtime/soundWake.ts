// Local "is someone talking?" detector used while Joy is IDLE (armed but hung
// up). Runs on the device only — nothing is billed, nothing leaves the phone.
// Uses expo-audio's recorder metering (dBFS) so it works on the native build
// we already ship; the recording itself is throwaway and is deleted on stop.
//
// The speech heuristic lives in soundWakeDetector.ts (shared with web).
import { AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { isLatest, nextGen, retire } from '@/utils/latest';
import { SOUND_WAKE, SpeechDetector } from './soundWakeDetector';

// One generation per start: a stop — or a newer start — retires it, so a start
// still inside prepareToRecordAsync releases its recorder instead of
// recording on with no handle. The old `recorder || timer` guard let two
// starts through in that window (hangUp → maybeListenWhileIdle plus an
// AppState 'active' event), and the second overwrote the first's handle
// while the first kept the mic; the next startVoice then failed (#24).
const KEY = 'soundWake.native';

let recorder: AudioRecorder | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let detector: SpeechDetector | null = null;
// The ambient floor survives restarts so a noisy room does not re-trigger on
// every return to idle (#347).
let lastFloor: number | null = null;

export async function startSoundWake(onSpeech: () => void): Promise<void> {
    if (recorder || timer) return;
    const gen = nextGen(KEY);
    let r: AudioRecorder | null = null;
    try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        if (!isLatest(KEY, gen)) return;
        r = new AudioModule.AudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
        await r.prepareToRecordAsync();
        if (!isLatest(KEY, gen) || recorder || timer) {
            // Stopped (or restarted) while preparing.
            await discardRecorder(r);
            return;
        }
        r.record();
        recorder = r;
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        // The allocation happened even though it never reached `recorder`;
        // Expo's registry keeps it (and any file prepare created) until it is
        // released explicitly (#346).
        if (r) await discardRecorder(r);
        return;
    }

    const d = new SpeechDetector(lastFloor ?? undefined);
    detector = d;
    timer = setInterval(() => {
        const rec = recorder;
        if (!rec) return;
        let level: number | undefined;
        try { level = rec.getStatus().metering; } catch { return; }
        if (typeof level !== 'number') return;
        if (d.push(level)) {
            void stopSoundWake().then(onSpeech);
        }
    }, SOUND_WAKE.SAMPLE_MS);
}

export async function stopSoundWake(): Promise<void> {
    retire(KEY); // a start still preparing must not take the mic
    if (timer) { clearInterval(timer); timer = null; }
    if (detector) { lastFloor = detector.floor; detector = null; }
    const r = recorder;
    recorder = null;
    if (!r) return;
    await discardRecorder(r);
}

/**
 * Stop, release and delete the throwaway recording. expo-audio writes each
 * recording to a UUID-named file in the cache directory and deletes it
 * neither on stop nor on release, so idle listening accumulated audio on
 * disk with no bound (#345).
 */
async function discardRecorder(r: AudioRecorder): Promise<void> {
    try { await r.stop(); } catch { /* not recording */ }
    let uri: string | null = null;
    try { uri = r.uri; } catch { /* released */ }
    try { r.release(); } catch { /* already released */ }
    if (!uri) return;
    // delete() throws when there is nothing at the uri — prepare failed before
    // writing, or the file is already gone — which is the outcome we want.
    try { new File(uri).delete(); } catch { /* nothing to delete */ }
}

export function isSoundWakeListening(): boolean {
    return recorder !== null;
}
