#!/usr/bin/env node
import { register } from 'tsx/esm/api';
register();
import('../src/index.ts').then((m) => m.main?.()).catch((e) => {
    console.error(e);
    process.exit(1);
});
