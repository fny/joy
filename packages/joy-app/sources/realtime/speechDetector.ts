/** Small level-based phrase detector. Levels are dBFS, sampled at 100 ms. */
export const SPEECH_DETECTOR = {
    sampleMs: 100,
    thresholdAboveFloorDb: 12,
    minSpeechDb: -40,
    minSpeechMs: 180,
    trailingSilenceMs: 900,
    ambientRotationMs: 30_000,
    maxClipMs: 30_000,
    floorAdaptation: 0.05,
} as const;

export type SpeechDetectorEvent = 'start' | 'end' | null;

export function shouldFinishSpeechClip(isSpeaking: boolean, elapsedMs: number): boolean {
    return isSpeaking && elapsedMs >= SPEECH_DETECTOR.maxClipMs;
}

export function shouldRotateSilentRecording(isSpeaking: boolean, elapsedMs: number): boolean {
    return !isSpeaking && elapsedMs >= SPEECH_DETECTOR.ambientRotationMs;
}

export class SpeechDetector {
    floor = -60;
    private speechStartedAt: number | null = null;
    private lastSpeechAt: number | null = null;
    private active = false;

    push(level: number, now: number): SpeechDetectorEvent {
        if (!Number.isFinite(level)) return null;
        const voiced = level > SPEECH_DETECTOR.minSpeechDb && level > this.floor + SPEECH_DETECTOR.thresholdAboveFloorDb;
        if (!voiced && level < this.floor + SPEECH_DETECTOR.thresholdAboveFloorDb) {
            this.floor += (level - this.floor) * SPEECH_DETECTOR.floorAdaptation;
        }
        if (voiced) {
            this.lastSpeechAt = now;
            this.speechStartedAt ??= now;
            if (!this.active && now - this.speechStartedAt >= SPEECH_DETECTOR.minSpeechMs) {
                this.active = true;
                return 'start';
            }
            return null;
        }
        if (this.active && this.lastSpeechAt !== null && now - this.lastSpeechAt >= SPEECH_DETECTOR.trailingSilenceMs) {
            this.reset();
            return 'end';
        }
        if (!this.active) this.speechStartedAt = null;
        return null;
    }

    reset(): void {
        this.speechStartedAt = null;
        this.lastSpeechAt = null;
        this.active = false;
    }

    get isSpeaking(): boolean { return this.active; }
}
