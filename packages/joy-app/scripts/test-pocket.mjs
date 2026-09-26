// Real WASM inference smoke test. Uses pre-downloaded, pinned assets only.
// node scripts/test-pocket.mjs /path/to/model-files /tmp/pocket.wav
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as ort from 'onnxruntime-web/wasm';
import { PocketEngine } from '../sources/realtime/pocket/core.js';
import assets from '../sources/realtime/pocket/assets.json' with { type: 'json' };
import bundle from '../sources/realtime/pocket/bundle.json' with { type: 'json' };
const directory = process.argv[2], output = process.argv[3];
if (!directory || !output) throw new Error('Usage: node scripts/test-pocket.mjs MODEL_DIRECTORY OUTPUT.wav');
ort.env.wasm.numThreads = 1;
const load = async name => {
    const data = await fs.readFile(path.join(directory, name));
    const asset = assets.files[name];
    if (data.length !== asset.size || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error(`Invalid ${name}`);
    return new Uint8Array(data);
};
const engine = new PocketEngine(ort, bundle, load, { executionProviders: ['wasm'] });
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 180_000);
try {
    const started = performance.now();
    await engine.prepare('alba', controller.signal, () => {});
    console.log(`Model loaded in ${((performance.now() - started) / 1000).toFixed(2)}s`);
    const generation = performance.now();
    const wav = await engine.generate('Hello Chris. Pocket speech is running inside Joy.', controller.signal);
    const seconds = (wav.length - 44) / 48000;
    if (seconds < 0.5) throw new Error('Generated audio is unexpectedly short.');
    const view = new DataView(wav.buffer);
    let energy = 0;
    for (let i = 44; i < wav.length; i += 2) energy += (view.getInt16(i, true) / 32768) ** 2;
    const rms = Math.sqrt(energy / ((wav.length - 44) / 2));
    if (rms < 0.001) throw new Error('Generated audio is silent.');
    await fs.writeFile(output, wav);
    console.log(JSON.stringify({ output, audioSeconds: seconds, generationSeconds: (performance.now() - generation) / 1000, rms, rssMiB: process.memoryUsage().rss / 1048576 }));
} finally { clearTimeout(timeout); await engine.dispose(); }
