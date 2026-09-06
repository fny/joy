/**
 * Test seam for the Sync class in sync.ts, whose module graph (react-native,
 * expo, storage, modals) cannot load under vitest. Named class members are
 * lifted out of the REAL source with the TypeScript AST, transpiled, and
 * re-assembled into a class whose free identifiers (module imports such as
 * `storage`, `log`, `v2MessagesAfter`) are injected by the test. The code
 * under test is therefore sync.ts as committed, not a copy of it.
 */
import ts from 'typescript';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SYNC_FILE = fileURLToPath(new URL('./sync.ts', import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncSubset = new () => any;

export function buildSyncSubset(members: string[], injections: Record<string, unknown>): SyncSubset {
    const src = fs.readFileSync(SYNC_FILE, 'utf8');
    const sf = ts.createSourceFile('sync.ts', src, ts.ScriptTarget.Latest, true);
    const cls = sf.statements.find((n): n is ts.ClassDeclaration => ts.isClassDeclaration(n) && n.name?.text === 'Sync');
    if (!cls) throw new Error('class Sync not found in sync.ts');
    const wanted = new Set(members);
    const picked = cls.members.filter((m) => {
        const name = m.name?.getText(sf);
        if (!name) return false;
        const isStatic = ts.canHaveModifiers(m) && (ts.getModifiers(m) ?? []).some(x => x.kind === ts.SyntaxKind.StaticKeyword);
        return wanted.has(name) || isStatic; // statics ride along: methods read Sync.MAX_*
    });
    const missing = members.filter(name => !picked.some(m => m.name?.getText(sf) === name));
    if (missing.length) throw new Error(`Sync members not found: ${missing.join(', ')}`);
    const code = 'class Sync {\n' + picked.map(m => m.getText(sf)).join('\n\n') + '\n}\nreturn Sync;';
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const names = Object.keys(injections);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(...names, js)(...names.map(n => injections[n])) as SyncSubset;
}
