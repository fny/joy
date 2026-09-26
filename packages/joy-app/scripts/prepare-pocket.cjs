// Copies our worker and the installed, pinned WASM runtime. No network/install.
const fs = require('node:fs');
const path = require('node:path');
const app = path.resolve(__dirname, '..');
const source = path.join(app, 'sources/realtime/pocket');
const target = path.join(app, 'public/pocket');
const noticeFiles = ['NOTICE.md', 'LICENSE', 'LICENSE-ONNX-RUNTIME', 'LICENSE-APACHE-2.0', 'LICENSE-CC-BY-4.0'];
const notices = noticeFiles.map(name => ({ name, lines: fs.readFileSync(path.join(source, name), 'utf8').trimEnd().split(/\r?\n/) }));
fs.writeFileSync(path.join(source, 'notices.json'), JSON.stringify(notices, null, 2) + '\n');
let runtime = path.dirname(require.resolve('onnxruntime-web'));
while (!fs.existsSync(path.join(runtime, 'package.json'))) {
    const parent = path.dirname(runtime);
    if (parent === runtime) throw new Error('Cannot locate ONNX Runtime');
    runtime = parent;
}
const pkg = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
if (pkg.version !== '1.24.3') throw new Error('Unexpected ONNX Runtime version');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'ort'), { recursive: true });
for (const name of ['worker.js', 'core.js', 'tokenizer.js', 'binary.js', 'assets.json', 'bundle.json', 'LICENSE', 'LICENSE-APACHE-2.0', 'LICENSE-CC-BY-4.0', 'NOTICE.md']) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
}
const dist = path.join(runtime, 'dist');
// The WASM-only CPU entry uses these exact files (no GPU/JSPI variants).
for (const name of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
    fs.copyFileSync(path.join(dist, name), path.join(target, 'ort', name));
}
fs.copyFileSync(path.join(source, 'LICENSE-ONNX-RUNTIME'), path.join(target, 'ort', 'LICENSE'));
