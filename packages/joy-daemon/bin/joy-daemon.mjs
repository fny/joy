#!/usr/bin/env node
import('../src/index.ts').then((m) => m.main?.()).catch((e) => {
    console.error(e);
    process.exit(1);
});
