/**
 * Floating-promise checker (the app has no eslint setup, so this stands in
 * for @typescript-eslint/no-floating-promises). Run from the package dir:
 *
 *     pnpm lint:promises            # every site
 *     pnpm lint:promises -- path/   # only files whose path contains `path/`
 *
 * Reports every ExpressionStatement whose value is thenable and is neither
 * awaited, `void`ed, returned, nor terminated by `.catch(...)` /
 * `.then(ok, fail)`, and every statement-level `.then(...)` chain without a
 * rejection handler. Exits 1 when anything is reported.
 */
import ts from 'typescript';
import path from 'node:path';

const appDir = path.resolve(__dirname, '../..');
const configPath = path.join(appDir, 'tsconfig.json');
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    { incremental: false, noEmit: true },
    {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => {
            throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
        },
    },
);
if (!parsed) throw new Error(`could not read ${configPath}`);

const { plugins: _plugins, ...options } = parsed.options as ts.CompilerOptions & { plugins?: unknown };
const program = ts.createProgram({ rootNames: parsed.fileNames, options });
const checker = program.getTypeChecker();

type Finding = { file: string; line: number; col: number; kind: 'floating-promise' | 'then-without-catch'; text: string };
const findings: Finding[] = [];

function isThenableType(type: ts.Type, at: ts.Node, depth = 0): boolean {
    if (depth > 4) return false;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion() || type.isIntersection()) return type.types.some((t) => isThenableType(t, at, depth + 1));
    const then = type.getProperty('then');
    if (!then) return false;
    const thenType = checker.getTypeOfSymbolAtLocation(then, at);
    return thenType.getCallSignatures().length > 0;
}

/** `p.catch(f)`, `p.then(a, b)`, or either of those followed by `.finally(...)`. */
function terminalHandled(expr: ts.Expression): boolean {
    let e: ts.Expression = expr;
    while (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
        const name = e.expression.name.text;
        if (name === 'catch') return e.arguments.length >= 1;
        if (name === 'then') return e.arguments.length >= 2 && e.arguments[1].kind !== ts.SyntaxKind.UndefinedKeyword;
        if (name === 'finally') { e = e.expression.expression; continue; }
        return false;
    }
    return false;
}

function outermostIsThen(expr: ts.Expression): boolean {
    return ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression) && expr.expression.name.text === 'then';
}

function isAssignment(expr: ts.Expression): boolean {
    if (!ts.isBinaryExpression(expr)) return false;
    const k = expr.operatorToken.kind;
    return k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;
}

function checkStatement(stmt: ts.ExpressionStatement, sf: ts.SourceFile): void {
    let expr = stmt.expression;
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    if (ts.isAwaitExpression(expr) || ts.isVoidExpression(expr)) return;
    if (isAssignment(expr)) return; // the promise is stored; whoever reads it owns it
    if (terminalHandled(expr)) return;
    const type = checker.getTypeAtLocation(expr);
    if (!isThenableType(type, expr)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
    const text = stmt.getText(sf).replace(/\s+/g, ' ').trim();
    findings.push({
        file: path.relative(appDir, sf.fileName),
        line: line + 1,
        col: character + 1,
        kind: outermostIsThen(expr) ? 'then-without-catch' : 'floating-promise',
        text: text.length > 110 ? `${text.slice(0, 107)}...` : text,
    });
}

for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const rel = path.relative(appDir, sf.fileName);
    if (rel.startsWith('..') || rel.includes('node_modules') || rel.startsWith('sources/trash')) continue;
    if (filters.length > 0 && !filters.some((f) => rel.includes(f))) continue;
    const visit = (node: ts.Node): void => {
        if (ts.isExpressionStatement(node)) checkStatement(node, sf);
        ts.forEachChild(node, visit);
    };
    visit(sf);
}

findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.col}  ${f.kind}  ${f.text}`);
}
const byFile = new Set(findings.map((f) => f.file)).size;
console.log(`\n${findings.length} floating promise${findings.length === 1 ? '' : 's'} in ${byFile} file${byFile === 1 ? '' : 's'}`);
process.exit(findings.length > 0 ? 1 : 0);
