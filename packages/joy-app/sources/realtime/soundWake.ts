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
let timer: ReturnType<typeof setInterval> | null = null;
let detector: SpeechDetector | null = null;
// The ambient floor survives restarts so a noisy room does not re-trigger on
// every return to idle (#347).
let lastFloor: number | null = null;

// Every recorder being opened or released. A recorder taken out of
// `recorder` still owns the microphone until its stop settles: a stop
// returning before that let the next startVoice (which awaits stopSoundWake
// for exactly this) or the next startSoundWake open a second live recorder
// beside it (#345). stopSoundWake returns only once all of these have
// settled, and startSoundWake opens nothing before they have.
const inFlight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    const done = () => { inFlight.delete(work); };
    work.then(done, done);
    return work;
}

async function settled(): Promise<void> {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export async function startSoundWake(onSpeech: () => void): Promise<void> {
    if (recorder || timer) return;
    const gen = nextGen(KEY);
    try {
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        if (!isLatest(KEY, gen)) return;
        await settled(); // a recorder still being released owns the mic
        if (!isLatest(KEY, gen)) return;
        if (!await openRecorder(gen)) return; // stopped (or restarted) while preparing
    } catch (e) {
        console.warn('[voice] sound wake unavailable:', e);
        return;
    }
    // openRecorder publishes the recorder itself; a stop that landed between
    // its return and this continuation has already retired the generation
    // and released it, and must not be undone by publishing a timer (#345).
    if (!isLatest(KEY, gen)) return;

    const d = new SpeechDetector(lastFloor ?? undefined);
    detector = d;
    let rotating = false;
    timer = setInterval(() => {
        if (rotating) return;
        const rec = recorder;
        const period = rec ? SOUND_WAKE_ROTATE_MS : SOUND_WAKE_RETRY_MS;
        if (Date.now() - recordingSince >= period) {
            rotating = true;
            void rotateRecording(gen).finally(() => { rotating = false; });
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

/**
 * Stop listening. Resolves once every recorder — the published one, and any
 * a rotation or a superseded start is still releasing — has let go of the
 * microphone, so the caller can take it (#345).
 */
export async function stopSoundWake(): Promise<void> {
    retire(KEY); // a start still preparing must not take the mic
    if (timer) { clearInterval(timer); timer = null; }
    if (detector) { lastFloor = detector.floor; detector = null; }
    const r = recorder;
    recorder = null;
    if (r) void releaseRecorder(r);
    await settled();
}

/**
 * Prepare a recorder for generation `gen` and publish it as `recorder` the
 * moment it records; false when the generation was retired while preparing.
 * Publishing here, synchronously with record(), leaves no gap in which a
 * stop can miss a recorder that is already live (#345). The allocation
 * happens before it reaches `recorder`, and Expo's registry keeps it (and
 * any file prepare created) until it is released explicitly, so every exit
 * that does not publish the recorder releases it (#346).
 */
function openRecorder(gen: number): Promise<boolean> {
    return track((async () => {
        let r: AudioRecorder | null = null;
        try {
            r = new AudioModule.AudioRecorder({ ...RecordingPresets.LOW_QUALITY, isMeteringEnabled: true });
            await r.prepareToRecordAsync();
            if (!isLatest(KEY, gen)) {
                await releaseRecorder(r);
                return false;
            }
            r.record();
            recorder = r;
            recordingSince = Date.now();
            return true;
        } catch (e) {
            if (r) await releaseRecorder(r);
            throw e;
        }
    })());
}

/**
 * Swap the current recording for a fresh one (#345). Sequential — stop and
 * delete the old before opening the new — because two recorders on the
 * microphone at once is not something every Android MediaRecorder allows.
 * The ticks in between see no recorder and skip; the detector window is
 * one second, so nothing is lost that a wake would need. A failed open
 * leaves the ticks blind and is retried after SOUND_WAKE_RETRY_MS.
 *
 * A stop during the rotation retires `gen`: the old recorder is still
 * released (stopSoundWake waits for it), the fresh one is released by
 * openRecorder, and nothing here touches state that is no longer ours.
 */
async function rotateRecording(gen: number): Promise<void> {
    const old = recorder;
    recorder = null;
    try {
        if (old) await releaseRecorder(old);
        if (!isLatest(KEY, gen)) return;
        await openRecorder(gen);
    } catch (e) {
        console.warn('[voice] sound wake: recording not rotated:', e);
    } finally {
        // Blind after a failed open: the retry period starts now.
        if (isLatest(KEY, gen) && !recorder) recordingSince = Date.now();
    }
}

/** Release a recorder that has left `recorder`, tracked so a stop or a start
 *  waits for the microphone to be free (#345). Never rejects. */
function releaseRecorder(r: AudioRecorder): Promise<void> {
    return track(discardRecorder(r));
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
