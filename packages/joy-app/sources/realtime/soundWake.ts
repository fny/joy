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

/**
 * expo-audio has no metering without a file, and one recording ran on until
 * stop — an armed phone left idle for hours filled its cache with audio
 * nobody wanted (#345). The recording is rotated on this period: a fresh
 * recorder takes over and the old file is deleted, so at most one bounded
 * file exists (LOW_QUALITY is 64 kbit/s ≈ 2.4 MB per period).
 */
export const SOUND_WAKE_ROTATE_MS = 5 * 60_000;
/** A rotation that failed to open a recorder is retried after this. */
export const SOUND_WAKE_RETRY_MS = 10_000;

let recorder: AudioRecorder | null = null;
let recordingSince = 0;
let rotating = false;
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
        r = await openRecorder(gen);
        if (!r) return; // stopped (or restarted) while preparing
        if (recorder || timer) {
            await discardRecorder(r);
            return;
        }
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        return;
    }
    recorder = r;
    recordingSince = Date.now();

    const d = new SpeechDetector(lastFloor ?? undefined);
    detector = d;
    timer = setInterval(() => {
        if (rotating) return;
        const rec = recorder;
        const period = rec ? SOUND_WAKE_ROTATE_MS : SOUND_WAKE_RETRY_MS;
        if (Date.now() - recordingSince >= period) {
            void rotateRecording(gen);
            return;
        }
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
 * A prepared, recording recorder for generation `gen`, or null when the
 * generation was retired while preparing. The allocation happens before it
 * reaches `recorder`, and Expo's registry keeps it (and any file prepare
 * created) until it is released explicitly, so every exit that does not
 * hand the recorder back discards it (#346).
 */
async function openRecorder(gen: number): Promise<AudioRecorder | null> {
    let r: AudioRecorder | null = null;
    try {
        r = new AudioModule.AudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
        await r.prepareToRecordAsync();
        if (!isLatest(KEY, gen)) {
            await discardRecorder(r);
            return null;
        }
        r.record();
        return r;
    } catch (e) {
        if (r) await discardRecorder(r);
        throw e;
    }
}

/**
 * Swap the current recording for a fresh one (#345). Sequential — stop and
 * delete the old before opening the new — because two recorders on the
 * microphone at once is not something every Android MediaRecorder allows.
 * The ticks in between see no recorder and skip; the detector window is
 * one second, so nothing is lost that a wake would need. A failed open
 * leaves the ticks blind and is retried after SOUND_WAKE_RETRY_MS.
 */
async function rotateRecording(gen: number): Promise<void> {
    if (rotating) return;
    rotating = true;
    try {
        const old = recorder;
        recorder = null;
        if (old) await discardRecorder(old);
        if (!isLatest(KEY, gen)) return;
        const fresh = await openRecorder(gen);
        if (!fresh) return;
        if (!isLatest(KEY, gen) || timer === null) {
            // Stopped while opening.
            await discardRecorder(fresh);
            return;
        }
        recorder = fresh;
    } catch (e) {
        console.warn('[voice] sound wake: recording not rotated:', e);
    } finally {
        recordingSince = Date.now();
        rotating = false;
    }
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
    if (uri) deleteRecording(uri);
}

/** Delete a recording file. Nothing at the uri — prepare failed before
 *  writing, or the file is already gone — is the outcome we want; any other
 *  failure is a file that will sit in the cache, so it is reported. */
function deleteRecording(uri: string): void {
    try {
        const file = new File(uri);
        if (!file.exists) return;
        file.delete();
    } catch (e) {
        console.warn('[voice] sound wake: throwaway recording not deleted:', uri, e);
    }
}

export function isSoundWakeListening(): boolean {
    return timer !== null;
}
