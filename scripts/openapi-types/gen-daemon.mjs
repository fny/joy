// Response schemas for the joy-daemon's operation catalog, from the return
// types TypeScript infers for each op's handler (domain/operations.ts).
// Writes packages/joy-daemon/src/transports/openapi.types.json, which
// transports/openapi.ts reads for every op without a hand-written `result`.
//
//   node scripts/openapi-types/gen-daemon.mjs           write the file
//   node scripts/openapi-types/gen-daemon.mjs --check   exit 1 if it is stale
//
// Request params are not generated: handlers take `Record<string, unknown>`,
// so there is no request type to read.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { SchemaBuilder, programFor, stableJson } from "./tsToSchema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = path.join(root, "packages/joy-daemon");
const opsFile = path.join(pkg, "src/domain/operations.ts");
const outFile = path.join(pkg, "src/transports/openapi.types.json");

export function generateDaemonTypes() {
    const program = programFor(path.join(pkg, "tsconfig.json"), [opsFile]);
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(opsFile);
    if (!source) throw new Error(`not in the program: ${opsFile}`);
    const builder = new SchemaBuilder(checker);
    const results = {};

    const prop = (obj, name) => obj.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === name);
    const visit = (node) => {
        if (ts.isObjectLiteralExpression(node)) {
            const nameProp = prop(node, "name");
            const scopeProp = prop(node, "scope");
            const handlerProp = prop(node, "handler");
            if (nameProp && scopeProp && handlerProp && ts.isPropertyAssignment(nameProp) && ts.isStringLiteral(nameProp.initializer)) {
                const handlerNode = ts.isPropertyAssignment(handlerProp) ? handlerProp.initializer
                    : ts.isMethodDeclaration(handlerProp) ? handlerProp : null;
                if (handlerNode) {
                    const sig = checker.getSignaturesOfType(checker.getTypeAtLocation(handlerNode), ts.SignatureKind.Call)[0];
                    if (sig) results[nameProp.initializer.text] = builder.schema(sig.getReturnType());
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    const schemas = Object.fromEntries(Object.keys(builder.components).sort().map((k) => [k, builder.components[k]]));
    const sortedResults = Object.fromEntries(Object.keys(results).sort().map((k) => [k, results[k]]));
    return { generatedBy: "scripts/openapi-types/gen-daemon.mjs", results: sortedResults, schemas };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const next = stableJson(generateDaemonTypes());
    if (process.argv.includes("--check")) {
        const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
        if (current !== next) { console.error(`${path.relative(root, outFile)} is stale: run node scripts/openapi-types/gen-daemon.mjs`); process.exit(1); }
        console.log("daemon OpenAPI types are up to date");
    } else {
        fs.writeFileSync(outFile, next);
        const parsed = JSON.parse(next);
        console.log(`wrote ${path.relative(root, outFile)}: ${Object.keys(parsed.results).length} op results, ${Object.keys(parsed.schemas).length} named schemas`);
    }
}
