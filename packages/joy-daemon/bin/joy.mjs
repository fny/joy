#!/usr/bin/env node
// Global-install entrypoint for the `joy` CLI.
//
// We ship TypeScript and run it through tsx. A naive bin of `src/cli.ts` with a
// `#!/usr/bin/env -S node --import tsx` shebang breaks when installed globally:
// `--import tsx` resolves the loader relative to the caller's CWD, so running
// `joy` from anywhere but the package dir throws ERR_MODULE_NOT_FOUND for tsx.
//
// Instead, register tsx's ESM loader via a STATIC import here — that resolves
// `tsx` relative to THIS file (the package's own node_modules), regardless of
// CWD — then hand off to the real CLI.
import { register } from 'tsx/esm/api';

// node:sqlite (the ledger) prints "ExperimentalWarning: SQLite is an
// experimental feature" to stderr on EVERY CLI call under Node 22-24. An
// agent running `joy ask` from a shell saw that as an error and re-ran the
// command to separate stdout from stderr (lab 4, 2026-09-11). Drop that one
// class of warning here, before anything loads the module; every other
// warning still prints.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const name = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : rest[0]?.type) : warning?.name;
  if (name === 'ExperimentalWarning') return;
  return emitWarning.call(process, warning, ...rest);
};

register();

await import(new URL('../src/cli.ts', import.meta.url).href);
