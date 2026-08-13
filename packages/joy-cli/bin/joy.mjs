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

register();

await import(new URL('../src/cli.ts', import.meta.url).href);
