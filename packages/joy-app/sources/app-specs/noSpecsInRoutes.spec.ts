import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No test file may live under `sources/app/`.
 *
 * Expo Router builds its route table from `require.context(APP_ROOT, true,
 * /…\.[tj]sx?$/)` — a regex baked into the package with no config hook — and
 * `getRoutes` LOADS every module it matches while building the tree. A
 * `*.test.ts` beside a route is therefore imported by the running app, which
 * pulls `vitest` into the bundle, and vitest throws the moment it is imported
 * outside its own runner:
 *
 *     Vitest failed to access its internal state.
 *
 * That is not a failing test — it is the whole app failing to boot, on device
 * and in the browser, with a stack that points at expo-router rather than at
 * the file that caused it. Six specs had accumulated under `sources/app/`
 * since 2026-09-06 before anyone hit it.
 *
 * Specs for route modules and their helpers live here instead, mirroring the
 * route path and importing through the `@/` alias. This test is the fence:
 * it fails at test time, with a message naming the file, instead of at boot.
 */
const APP_ROOT = join(__dirname, '..', 'app');
const IS_SPEC = /\.(test|spec)\.[tj]sx?$/;

function specsUnder(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            specsUnder(path, found);
        } else if (IS_SPEC.test(entry)) {
            found.push(path.slice(path.indexOf('sources/')));
        }
    }
    return found;
}

describe('the routes directory', () => {
    it('contains no test files — expo-router would load them into the app', () => {
        const strays = specsUnder(APP_ROOT);
        expect(
            strays,
            strays.length === 0 ? '' : `move these to sources/app-specs/ — expo-router loads every module under sources/app/, so a spec there imports vitest into the running app and it fails to boot:\n  ${strays.join('\n  ')}`,
        ).toEqual([]);
    });
});
