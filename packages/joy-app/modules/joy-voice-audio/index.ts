import { requireOptionalNativeModule } from 'expo-modules-core';

export interface VoiceAudio {
    preparePlayback(): Promise<void>;
    play(uri: string): Promise<void>;
    stopPlayback(): Promise<void>;
    disposePlayback(): Promise<void>;
    // iOS uses one voice-processing engine for capture and playback. Android
    // capture uses Expo's voice_communication source with this module's output.
    startRecording(): Promise<void>;
    finishRecording(): Promise<string>;
    stopRecording(): Promise<void>;
    addListener(event: 'level', listener: (event: { db: number }) => void): { remove(): void };
    addListener(event: 'error', listener: (event: { message: string }) => void): { remove(): void };
}

export function getVoiceAudio(): VoiceAudio {
    const audio = requireOptionalNativeModule<VoiceAudio>('JoyVoiceAudio');
    if (!audio) throw new Error('Install a current Joy native build to use voice. An app update alone cannot add its audio runtime.');
    return audio;
}
