// Integrated browser smoke test. All HTTP requests stay on loopback; API replies
// are protocol fixtures, not tests of a real STT or language model's accuracy.
// Usage: node scripts/test-voice-browser.cjs [LOCAL_POCKET_MODEL_DIRECTORY]
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const esbuild = require('esbuild');

const appRoot = path.resolve(__dirname, '..');
const sources = path.join(appRoot, 'sources/realtime');
const publicRoot = path.join(appRoot, 'public');
const modelDir = path.resolve(process.argv[2] || '/tmp/joy-pocket-models');
const haveModels = fs.existsSync(path.join(modelDir, 'alba.safetensors'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const requests = { stt: [], openai: [], anthropic: [], preflight: 0, models: 0 };

function wavFixture(file) {
    const rate = 48000;
    // Chrome loops this file. Two distinct voiced bursts leave ample trailing
    // silence for Joy's real 900 ms end-of-phrase detector.
    const sequence = [[0, 0.8], [440, 0.9], [0, 1.5], [660, 0.9], [0, 1.5]];
    const count = Math.round(sequence.reduce((n, [, seconds]) => n + seconds, 0) * rate);
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    let sample = 0;
    for (const [frequency, seconds] of sequence) {
        const length = Math.round(seconds * rate);
        for (let i = 0; i < length; i++, sample++) {
            const value = frequency ? Math.sin(2 * Math.PI * frequency * i / rate) * 0.6 : 0;
            wav.writeInt16LE(Math.round(value * 32767), 44 + sample * 2);
        }
    }
    fs.writeFileSync(file, wav);
}

const api = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') { requests.preflight++; res.writeHead(204); res.end(); return; }
    const body = Buffer.concat(await (async () => { const parts = []; for await (const part of req) parts.push(part); return parts; })());
    const json = () => JSON.parse(body.toString('utf8'));
    const send = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.url === '/stt/v1/audio/transcriptions') {
        assert(req.headers.authorization === 'Bearer fixture-stt-key', 'STT bearer header missing');
        assert(String(req.headers['content-type']).includes('multipart/form-data'), 'STT multipart form missing');
        assert(body.includes(Buffer.from('name="model"')) && body.includes(Buffer.from('fixture-stt')), 'STT model missing');
        assert(body.includes(Buffer.from('name="file"')) && body.length > 1000, 'STT audio file missing');
        requests.stt.push({ bytes: body.length });
        send({ text: `Joy, fixture phrase ${requests.stt.length}` });
    } else if (req.url === '/openai/v1/chat/completions') {
        assert(req.headers.authorization === 'Bearer fixture-openai-key', 'OpenAI bearer header missing');
        const value = json(); requests.openai.push(value);
        assert(value.model === 'fixture-openai' && value.messages?.[0]?.role === 'system', 'OpenAI request shape invalid');
        if (requests.openai.length === 1) {
            assert(value.tools?.some(t => t.function.name === 'fixture_action'), 'OpenAI tool schema missing');
            send({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'fixture_action', arguments: '{"value":"openai"}' } }] } }] });
        } else {
            assert(value.messages?.some(m => m.role === 'tool' && m.tool_call_id === 'call-1' && m.content === 'executed'), 'OpenAI tool result missing');
            send({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OpenAI fixture complete.' } }] });
        }
    } else if (req.url === '/anthropic/v1/messages') {
        assert(req.headers['x-api-key'] === 'fixture-anthropic-key', 'Anthropic key header missing');
        assert(req.headers['anthropic-version'], 'Anthropic version header missing');
        const value = json(); requests.anthropic.push(value);
        assert(value.model === 'fixture-anthropic' && typeof value.system === 'string', 'Anthropic request shape invalid');
        if (requests.anthropic.length === 1) {
            assert(value.tools?.some(t => t.name === 'fixture_action'), 'Anthropic tool schema missing');
            send({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'fixture_action', input: { value: 'anthropic' } }] });
        } else {
            assert(value.messages?.some(m => m.role === 'user' && m.content?.some(c => c.type === 'tool_result' && c.tool_use_id === 'tool-1' && c.content === 'executed')), 'Anthropic tool result missing');
            send({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Anthropic fixture complete.' }] });
        }
    } else { res.writeHead(404); res.end(); }
});

let bundle;
const page = `<!doctype html><button id="go">Run voice smoke test</button><pre id="result"></pre><script type="module">
import { createSpeechInput, transcribe, VoiceConversation, createPocketSpeech, createSpeechOutput } from '/bundle.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
document.querySelector('#go').onclick = async () => {
  const result = { ok: false, capture: [], conversation: [], pocket: null };
  const fail = error => { throw error instanceof Error ? error : new Error(String(error)); };
  const timeout = (promise, ms, label) => Promise.race([promise, wait(ms).then(() => fail(label + ' timed out'))]);
  let input, pocket, output, decoder;
  try {
    decoder = new AudioContext(); await decoder.resume();
    const api = 'http://127.0.0.1:__API_PORT__';
    const clips = [];
    const openedStreams = [];
    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await originalGetUserMedia(...args); openedStreams.push(stream); return stream;
    };
    input = createSpeechInput({
      onSpeechStart() {},
      onRecording(recording) { clips.push(recording); },
      onError(error) { result.captureError = error.stack || String(error); },
    });
    await input.start();
    const deadline = Date.now() + 18000;
    while (clips.length < 2 && Date.now() < deadline) await wait(100);
    if (result.captureError) fail(result.captureError);
    if (clips.length < 2) fail('Only ' + clips.length + ' capture segments arrived');
    await input.stop();
    if (!openedStreams.length || openedStreams.some(stream => stream.getTracks().some(track => track.readyState !== 'ended'))) fail('Capture tracks remained live after stop');
    for (const clip of clips.slice(0, 2)) {
      const blob = await (await fetch(clip.uri)).blob();
      const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
      const samples = decoded.getChannelData(0);
      const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
      if (decoded.duration < 0.5 || peak < 0.05) fail('Captured segment is silent or undecodable');
      const text = await transcribe({ baseUrl: api + '/stt/v1', model: 'fixture-stt', apiKey: 'fixture-stt-key' }, clip, new AbortController().signal);
      result.capture.push({ duration: decoded.duration, peak, mimeType: clip.mimeType, text });
      await clip.dispose();
    }
    for (const clip of clips.slice(2)) await clip.dispose();
    result.captureStopped = true;
    result.stoppedTracks = openedStreams.flatMap(stream => stream.getTracks()).length;
    const tools = [{ name: 'fixture_action', description: 'Fixture action', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }];
    for (const [style, model, key] of [['openai', 'fixture-openai', 'fixture-openai-key'], ['anthropic', 'fixture-anthropic', 'fixture-anthropic-key']]) {
      const actions = [];
      const conversation = new VoiceConversation({ apiStyle: style, baseUrl: api + '/' + style + '/v1', model, apiKey: key }, 'Fixture system prompt', tools, async (name, args) => { actions.push({ name, args }); return 'executed'; });
      conversation.updateContext('Focused session: fixture');
      const reply = await conversation.respond('Joy, run the fixture action', 'user', new AbortController().signal);
      if (!reply.text.includes(style === 'openai' ? 'OpenAI fixture complete.' : 'Anthropic fixture complete.') || actions.length !== 1 || actions[0].args.value !== style) fail(style + ' conversation failed');
      result.conversation.push({ style, text: reply.text, actions });
    }
    if (__HAVE_MODELS__) {
      pocket = createPocketSpeech(); output = createSpeechOutput(); await output.prepare();
      const prepareStarted = performance.now();
      await timeout(pocket.prepare('alba'), 120000, 'Pocket prepare');
      const synthesisStarted = performance.now();
      const wav = await timeout(pocket.generate('Joy voice browser test.', new AbortController().signal), 120000, 'Pocket synthesis');
      const synthesizedAt = performance.now();
      const audio = await decoder.decodeAudioData(wav.slice().buffer);
      if (audio.duration < 0.2) fail('Pocket output too short');
      await timeout(output.play(wav, new AbortController().signal), 30000, 'Pocket playback');
      const interrupt = new AbortController();
      const interrupted = output.play(wav, interrupt.signal);
      setTimeout(() => interrupt.abort(), 50);
      await timeout(interrupted, 1000, 'Playback cancellation');
      result.pocket = { audioSeconds: audio.duration, sampleRate: audio.sampleRate, played: true, cancelled: true,
        prepareMs: Math.round(synthesisStarted - prepareStarted), synthesisMs: Math.round(synthesizedAt - synthesisStarted) };
    } else result.pocket = { skipped: 'local Pocket model assets unavailable' };
    result.ok = true;
  } catch (error) { result.error = error.stack || String(error); }
  finally { try { await input?.stop(); } catch {} pocket?.dispose(); await output?.dispose(); if (decoder) await decoder.close(); window.voiceResult = result; document.querySelector('#result').textContent = JSON.stringify(result); }
};</script>`;

const app = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(page.replace('__API_PORT__', String(api.address().port)).replace('__HAVE_MODELS__', String(haveModels))); return; }
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle); return; }
    if (req.url === '/pocket/assets.json') {
        const assets = JSON.parse(fs.readFileSync(path.join(publicRoot, 'pocket/assets.json'), 'utf8'));
        for (const [name, asset] of Object.entries(assets.files)) asset.url = `http://127.0.0.1:${app.address().port}/models/${name}`;
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(assets)); return;
    }
    let file;
    if (req.url.startsWith('/models/')) {
        requests.models++;
        file = path.join(modelDir, path.basename(req.url));
        if (!haveModels || !file.startsWith(modelDir + path.sep)) { res.writeHead(404); res.end(); return; }
    } else if (req.url.startsWith('/pocket/')) {
        file = path.join(publicRoot, path.normalize(req.url).replace(/^\/+/, ''));
        if (!file.startsWith(path.join(publicRoot, 'pocket') + path.sep)) { res.writeHead(404); res.end(); return; }
    } else { res.writeHead(404); res.end(); return; }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('content-type', file.endsWith('.wasm') ? 'application/wasm' : /\.(js|mjs)$/.test(file) ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('content-length', fs.statSync(file).size);
    fs.createReadStream(file).pipe(res);
});

let chrome, ws, profile;
(async () => {
    const entry = `
      export { createSpeechInput } from ${JSON.stringify(path.join(sources, 'speechInput.web.ts'))};
      export { transcribe } from ${JSON.stringify(path.join(sources, 'transcription.ts'))};
      export { VoiceConversation } from ${JSON.stringify(path.join(sources, 'voiceConversation.ts'))};
      export { createPocketSpeech } from ${JSON.stringify(path.join(sources, 'pocket/speech.web.ts'))};
      export { createSpeechOutput } from ${JSON.stringify(path.join(sources, 'speechOutput.web.ts'))};`;
    const built = await esbuild.build({ stdin: { contents: entry, resolveDir: appRoot, sourcefile: 'voice-browser-entry.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'react-native-platform', setup(build) {
        build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'react-native-platform', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: "export const Platform = { OS: 'web' };", loader: 'js' }));
    } }] });
    bundle = built.outputFiles[0].text;
    await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'joy-voice-chrome-'));
    const wav = path.join(profile, 'fake-microphone.wav'); wavFixture(wav);
    chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
        '--headless=new', ...(process.env.JOY_VOICE_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
        '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`, `--user-data-dir=${profile}`,
        '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank',
    ], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(profile, 'DevToolsActivePort')); i++) await sleep(100);
    assert(fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome did not start');
    const debugPort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const tasks = new Map(); let id = 0;
    ws.onmessage = event => { const data = JSON.parse(event.data); if (data.id) { const task = tasks.get(data.id); tasks.delete(data.id); data.error ? task.reject(data.error) : task.resolve(data.result); } };
    const call = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id; tasks.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params })); });
    await call('Page.navigate', { url: `http://127.0.0.1:${app.address().port}` });
    await sleep(400);
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 60, y: 20, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 60, y: 20, button: 'left', clickCount: 1 });
    const expression = `new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.voiceResult){clearInterval(timer);resolve(window.voiceResult)}else if(Date.now()-start>180000){clearInterval(timer);reject(new Error('browser smoke test timed out'))}},100)})`;
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const browser = result.result?.value;
    assert(browser, JSON.stringify(result));
    assert(requests.stt.length >= 2, 'Expected two STT uploads');
    assert(requests.openai.length === 2 && requests.anthropic.length === 2, 'Expected two rounds per conversation protocol');
    assert(requests.preflight >= 3, 'Expected browser CORS preflights');
    console.log(JSON.stringify({ browser, fixture: { sttRequests: requests.stt.length, openaiRequests: requests.openai.length, anthropicRequests: requests.anthropic.length, corsPreflights: requests.preflight, pocketModelRequests: requests.models } }));
    if (!browser.ok) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    ws?.close();
    if (chrome) {
        const exited = new Promise(resolve => chrome.once('exit', resolve));
        chrome.kill();
        await Promise.race([exited, sleep(2000)]);
    }
    app.close(); api.close();
    if (profile) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
