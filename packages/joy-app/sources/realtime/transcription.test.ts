import { beforeEach, expect, test, vi } from 'vitest';
const platform = vi.hoisted(() => ({ OS: 'web' }));
vi.mock('react-native', () => ({ Platform: platform }));
import { transcribe } from './transcription';
const config = { baseUrl: 'https://speech.test/v1/', model: 'stt', apiKey: 'secret' };
const clip = { uri: 'blob:audio', mimeType: 'audio/webm', name: 'speech.webm', dispose: vi.fn() };
beforeEach(() => { vi.restoreAllMocks(); platform.OS = 'web'; });
test('uploads the actual recorded audio as multipart with configurable model and credentials', async () => {
    const audio = new Blob(['recording'], { type: 'audio/webm' });
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(audio)).mockResolvedValueOnce(Response.json({ text: ' Hello Joy ' }));
    expect(await transcribe(config, clip, new AbortController().signal)).toBe('Hello Joy');
    const [url, options] = fetcher.mock.calls[1];
    expect(url).toBe('https://speech.test/v1/audio/transcriptions');
    expect(options?.headers).toEqual({ Authorization: 'Bearer secret' });
    const body = options?.body as FormData;
    expect(body.get('model')).toBe('stt');
    const file = body.get('file') as File;
    expect(file.name).toBe('speech.webm'); expect(await file.text()).toBe('recording');
    expect(clip.dispose).not.toHaveBeenCalled(); // Recorder lifecycle owns cleanup.
});
test('accepts silence but rejects a missing text result', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    fetcher.mockResolvedValueOnce(new Response('audio')).mockResolvedValueOnce(Response.json({ text: '' }));
    expect(await transcribe(config, clip, new AbortController().signal)).toBe('');
    fetcher.mockResolvedValueOnce(new Response('audio')).mockResolvedValueOnce(Response.json({ error: 'bad' }));
    await expect(transcribe(config, clip, new AbortController().signal)).rejects.toThrow('Invalid transcription');
});
test('cancellation before upload does not send microphone audio', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch'); const abort = new AbortController(); abort.abort();
    await expect(transcribe(config, clip, abort.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
});
