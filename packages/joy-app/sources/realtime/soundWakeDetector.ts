// The "is someone talking?" heuristic shared by the native (expo-audio
// metering) and web (AnalyserNode RMS) idle detectors. Pure: it is fed one
// dBFS level per sample and answers "speech now?".
//
// It is sound-LEVEL detection, not word recognition: a TV or a nearby
// conversation can wake it. What it must never do is wake on a constant
// hum, which the previous version did (#347): the floor started at -60 dBFS
// and only ever adapted on samples BELOW floor + margin, so in steady -35 dB
// road noise every sample counted as speech, the detector fired, and each
// return to idle reset the floor and fired again.
//
// Three changes fix that:
//   1. CALIBRATION — the first few samples set the floor without any wake
//      decision, so the detector learns the room before it listens.
//   2. UPWARD ADAPTATION — loud samples move the floor too, slowly; real
//      speech triggers long before it matters, a hum that starts mid-listen
//      is absorbed instead of firing on every return to idle.
//   3. PRESERVED FLOOR — the caller hands the last floor to the next
//      detector, so a restart after a wake or hang-up does not start from
//      -60 in a noisy room.

export const SOUND_WAKE = {
    /** Sampling period both detectors use. */
    SAMPLE_MS: 100,
    /** How far above the ambient floor counts as speech. */
    SPEECH_DB_ABOVE_FLOOR: 12,
    /** Absolute minimum (dBFS) so a silent room never triggers. */
    MIN_SPEECH_DB: -40,
    /** ≈400 ms of voiced sound within the window. */
    SPEECH_SAMPLES_NEEDED: 4,
    /** ≈1 s window. */
    WINDOW_SAMPLES: 10,
    /** Floor adaptation rate on quiet samples. */
    FLOOR_ADAPT_DOWN: 0.05,
    /** Floor adaptation rate on loud samples: slow, so speech barely moves it. */
    FLOOR_ADAPT_UP: 0.02,
    /** Samples spent learning the room before any wake decision (≈500 ms). */
    CALIBRATION_SAMPLES: 5,
    /** Rate during calibration: five samples reach ~97% of a steady level. */
    CALIBRATION_ADAPT: 0.5,
    /** Starting floor when nothing is known about the room. */
    DEFAULT_FLOOR: -60,
} as const;

export class SpeechDetector {
    private floorValue: number;
    private samples = 0;
    private window: boolean[] = [];

    /** `initialFloor` is the previous detector's floor, when there was one. */
    constructor(initialFloor: number = SOUND_WAKE.DEFAULT_FLOOR) {
        this.floorValue = Number.isFinite(initialFloor) ? initialFloor : SOUND_WAKE.DEFAULT_FLOOR;
    }

    /** Current ambient floor estimate (dBFS). Hand it to the next detector. */
    get floor(): number {
        return this.floorValue;
    }

    /** False while the first CALIBRATION_SAMPLES are being absorbed. */
    get calibrated(): boolean {
        return this.samples >= SOUND_WAKE.CALIBRATION_SAMPLES;
    }

    /**
     * Feed one level sample (dBFS). Returns true exactly on the sample that
     * completes a speech burst; the window is then cleared so the next burst
     * needs SPEECH_SAMPLES_NEEDED fresh voiced samples.
     */
    push(level: number): boolean {
        if (typeof level !== 'number' || !Number.isFinite(level)) return false;
        if (!this.calibrated) {
            this.samples++;
            this.floorValue += (level - this.floorValue) * SOUND_WAKE.CALIBRATION_ADAPT;
            return false;
        }
        const threshold = this.floorValue + SOUND_WAKE.SPEECH_DB_ABOVE_FLOOR;
        const rate = level < threshold ? SOUND_WAKE.FLOOR_ADAPT_DOWN : SOUND_WAKE.FLOOR_ADAPT_UP;
        this.floorValue += (level - this.floorValue) * rate;
        const voiced = level > SOUND_WAKE.MIN_SPEECH_DB && level > threshold;
        this.window.push(voiced);
        if (this.window.length > SOUND_WAKE.WINDOW_SAMPLES) this.window.shift();
        let count = 0;
        for (const v of this.window) if (v) count++;
        if (count >= SOUND_WAKE.SPEECH_SAMPLES_NEEDED) {
            this.window.length = 0;
            return true;
        }
        return false;
    }
}
