import { useSyncExternalStore } from 'react';
import assets from './assets.json';
let total = 1;
let loaded = new Map<string, number>();
let percent = 0;
const listeners = new Set<() => void>();
export function resetPocketProgress(voice: string) {
    const selected = assets.voices.includes(voice) ? voice : 'alba';
    total = Object.entries(assets.files).filter(([name]) => !name.endsWith('.safetensors') || name === selected + '.safetensors').reduce((n, [, file]) => n + file.size, 0);
    loaded = new Map(); percent = 0; listeners.forEach(fn => fn());
}
export function reportPocketProgress(file: string, bytes: number) {
    loaded.set(file, bytes);
    percent = Math.min(100, Math.floor([...loaded.values()].reduce((a, b) => a + b, 0) * 100 / total));
    listeners.forEach(fn => fn());
}
export const usePocketProgress = () => useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => percent,
    () => 0,
);
