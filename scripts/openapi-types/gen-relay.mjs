// Request and response schemas for the joy relay's /joy/v2 routes, from the
// TypeScript types of the app code that calls them. The relay is plain
// JavaScript, so its clients' types are the only typed account of its
// payloads. Writes packages/joy-relay/src/openapi.types.json, which
// src/docs.mjs matches against the live route table.
//
//   node scripts/openapi-types/gen-relay.mjs           write the file
//   node scripts/openapi-types/gen-relay.mjs --check   exit 1 if it is stale
//
// What counts as a type for a route:
//   request  — the type of the body argument at the call (v2fetch's body,
//              fetch's JSON.stringify(x), axios' data);
//   response — the DECLARED return type of the function the call is directly
//              returned from. A function that reshapes the response (returns
//              one field of it, a boolean…) does not describe the wire, so it
//              is skipped rather than guessed at.
// Routes only the daemon calls (/daemon/*) have no TypeScript types anywhere
// and stay undescribed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SchemaBuilder, programFor, stableJson } from "./tsToSchema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const app = path.join(root, "packages/joy-app");
const outFile = path.join(root, "packages/joy-relay/src/openapi.types.json");

/** App files that talk to the relay (grep '/joy/v2' and v2fetch). */
function relayCallerFiles() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!["node_modules", "trash", "app-specs"].includes(e.name)) walk(p); continue; }
            if (!/\.tsx?$/.test(e.name) || /\.(test|spec)\.tsx?$/.test(e.name)) continue;
            const text = fs.readFileSync(p, "utf8");
            if (text.includes("/joy/v2") || text.includes("v2fetch")) out.push(p);
        }
    };
    walk(path.join(app, "sources"));
    return out.sort();
}

/** Path text of a string / template expression, `{}` for each substitution. */
function pathText(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => "{}" + s.literal.text).join("");
    return null;
}

/** "/sessions/{}{}?x" → "/sessions/{}" : a substitution not right after "/"
 *  is a query or suffix, not a path segment. */
function normalizePath(raw) {
    let p = raw.split("?")[0];
    p = p.replace(/([^/])\{\}/g, "$1").replace(/\{\}\{\}/g, "{}");
    return p.replace(/\/+$/, "") || "/";
}

function enclosingFunction(node) {
    for (let n = node.parent; n; n = n.parent) {
        if (ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return n;
    }
    return null;
}

/** Is `call` the value its function returns (arrow body, `return call`, `return await call`)? */
function isReturnedDirectly(call, fn) {
    let n = call;
    while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent;
    if (ts.isArrowFunction(fn) && fn.body === n) return true;
    return Boolean(n.parent && ts.isReturnStatement(n.parent) && enclosingFunction(n.parent) === fn);
}

export function generateRelayTypes() {
    const files = relayCallerFiles();
    const program = programFor(path.join(app, "tsconfig.json"), files);
    const checker = program.getTypeChecker();
    const builder = new SchemaBuilder(checker);
    const routes = new Map(); // "METHOD /path" → entry

    const record = (method, rawPath, bodyNode, call, file) => {
        if (rawPath == null) return;
        const p = normalizePath(rawPath);
        if (!p.startsWith("/")) return;
        const key = `${method} ${p}`;
        const entry = routes.get(key) ?? { method, path: p, samplePath: p.replace(/\{\}/g, "x0"), sources: [] };
        const line = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1;
        entry.sources.push(`${path.relative(root, file)}:${line}`);
        if (bodyNode && !entry.body) {
            const t = checker.getTypeAtLocation(bodyNode);
            const s = builder.schema(t);
            if (Object.keys(s).length) entry.body = s;
        }
        const fn = enclosingFunction(call);
        if (fn && fn.type && isReturnedDirectly(call, fn) && !entry.result) {
            const s = builder.schema(checker.getTypeFromTypeNode(fn.type));
            if (Object.keys(s).length && !(s.type === "object" && s.additionalProperties && !s.properties && Object.keys(s.additionalProperties).length === 0)) entry.result = s;
        }
        routes.set(key, entry);
    };

    for (const file of files) {
        const sf = program.getSourceFile(file);
        if (!sf) continue;
        const visit = (node) => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                const name = ts.isIdentifier(callee) ? callee.text
                    : ts.isPropertyAccessExpression(callee) ? `${callee.expression.getText(sf)}.${callee.name.text}` : "";
                const args = node.arguments;
                if ((name === "v2fetch" || name === "v2fetchAt") && args.length >= 2) {
                    const o = name === "v2fetchAt" ? 1 : 0;
                    const m = args[o] && ts.isStringLiteral(args[o]) ? args[o].text : null;
                    if (m) record(m, pathText(args[o + 1]), args[o + 2], node, file);
                } else if ((name === "fetch" || /^axios\.(get|post|put|patch|delete)$/.test(name)) && args[0]) {
                    const raw = pathText(args[0]);
                    const at = raw?.indexOf("/joy/v2") ?? -1;
                    if (raw && at >= 0) {
                        const rel = raw.slice(at + "/joy/v2".length);
                        if (name === "fetch") {
                            const init = args[1] && ts.isObjectLiteralExpression(args[1]) ? args[1] : null;
                            const prop = (k) => init?.properties.find((pp) => ts.isPropertyAssignment(pp) && pp.name.getText(sf) === k);
                            const mp = prop("method");
                            const method = mp && ts.isStringLiteral(mp.initializer) ? mp.initializer.text.toUpperCase() : "GET";
                            const bp = prop("body");
                            const bodyArg = bp && ts.isCallExpression(bp.initializer) && bp.initializer.expression.getText(sf) === "JSON.stringify" ? bp.initializer.arguments[0] : undefined;
                            record(method, rel, bodyArg, node, file);
                        } else {
                            const method = name.split(".")[1].toUpperCase();
                            record(method, rel, ["POST", "PUT", "PATCH"].includes(method) ? args[1] : undefined, node, file);
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    const list = [...routes.values()].sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
    const schemas = Object.fromEntries(Object.keys(builder.components).sort().map((k) => [k, builder.components[k]]));
    return { generatedBy: "scripts/openapi-types/gen-relay.mjs", routes: list, schemas };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const next = stableJson(generateRelayTypes());
    if (process.argv.includes("--check")) {
        const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
        if (current !== next) { console.error(`${path.relative(root, outFile)} is stale: run node scripts/openapi-types/gen-relay.mjs`); process.exit(1); }
        console.log("relay OpenAPI types are up to date");
    } else {
        fs.writeFileSync(outFile, next);
        const parsed = JSON.parse(next);
        const withBody = parsed.routes.filter((r) => r.body).length;
        const withResult = parsed.routes.filter((r) => r.result).length;
        console.log(`wrote ${path.relative(root, outFile)}: ${parsed.routes.length} called routes, ${withBody} with a request type, ${withResult} with a response type, ${Object.keys(parsed.schemas).length} named schemas`);
    }
}
