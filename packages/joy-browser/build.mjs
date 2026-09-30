#!/usr/bin/env node
// Assemble the two loadable extensions from the one source tree.
//
//   node build.mjs            → dist/chrome/  dist/firefox/
//
// Chrome can also load this directory unpacked as it stands; the build exists
// because Firefox needs its own manifest (Manifest V2 — the only way Firefox
// will run a script handed to it as a string) under the name manifest.json.
import { cpSync, mkdirSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const SHARED = ['background.js', 'content.js', 'popup.html', 'popup.js', 'src', 'vendor'];
const version = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')).version;
if (JSON.parse(readFileSync(join(root, 'manifest.firefox.json'), 'utf8')).version !== version) { console.error('manifest.json and manifest.firefox.json disagree on the version'); process.exit(1); }

for (const [target, manifest, extra] of [['chrome', 'manifest.json', ['offscreen.html', 'offscreen.js']], ['firefox', 'manifest.firefox.json', ['background.html']]]) {
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
  for (const f of [...SHARED, ...extra]) cpSync(join(root, f), join(out, f), { recursive: true });
  copyFileSync(join(root, manifest), join(out, 'manifest.json'));
  console.log(`dist/${target}  (${version})`);
}
