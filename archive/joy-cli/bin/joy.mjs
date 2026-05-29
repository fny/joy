#!/usr/bin/env node
import { register } from 'tsx/esm/api';
register();
import('../src/index.ts').then((m) => m.main?.(process.argv.slice(2))).catch((e) => {
    console.error(e);
    process.exit(1);
});
