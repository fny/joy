import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Two workers, not one per core: a daemon/app worker can reach ~3 GB, and
// several agents run these suites at once on the same box — on 2026-09-11 three
// concurrent runs exhausted a 10 GB machine and the OOM killer took agent
// sessions down with them.
export default defineConfig({
    test: {
        maxWorkers: 2,
        globals: false,
        environment: 'node',
        include: ['sources/**/*.{spec,test}.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
                'node_modules/**',
                'dist/**',
                '**/*.d.ts',
                '**/*.config.*',
                '**/mockData/**',
            ],
        },
    },
    resolve: {
        alias: {
            '@': resolve('./sources'),
        },
    },
})