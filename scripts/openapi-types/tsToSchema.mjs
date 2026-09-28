// TypeScript type → JSON Schema (OpenAPI 3.1 flavour), from the type
// checker's own view of a type. Shared by gen-daemon.mjs and gen-relay.mjs.
//
// Only what JSON can carry is described: functions are dropped, `undefined`
// makes a property optional, Date is a date-time string. Types declared in
// the project (not in node_modules or TypeScript's lib) become named
// components referenced by $ref, so a session record is defined once and
// every route that returns one points at it.
import ts from "typescript";

export class SchemaBuilder {
    /** @param {ts.TypeChecker} checker */
    constructor(checker) {
        this.checker = checker;
        /** name → schema */
        this.components = {};
        /** type id → component name */
        this.named = new Map();
        /** anonymous types on the current path, to cut cycles */
        this.stack = new Set();
    }

    /** @param {ts.Type} type */
    schema(type, depth = 0) {
        const c = this.checker;
        const f = type.flags;
        if (depth > 12) return {};
        if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
        if (f & ts.TypeFlags.Never) return { not: {} };
        if (f & ts.TypeFlags.StringLiteral) return { type: "string", const: type.value };
        if (f & ts.TypeFlags.NumberLiteral) return { type: "number", const: type.value };
        if (f & ts.TypeFlags.BooleanLiteral) return { type: "boolean", const: c.typeToString(type) === "true" };
        if (f & ts.TypeFlags.String) return { type: "string" };
        if (f & ts.TypeFlags.Number) return { type: "number" };
        if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
        if (f & ts.TypeFlags.BigInt) return { type: "integer" };
        if (f & ts.TypeFlags.Null) return { type: "null" };
        if (f & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return {};
        if (f & ts.TypeFlags.NonPrimitive) return { type: "object" };

        const awaited = c.getAwaitedType(type);
        if (awaited && awaited !== type) return this.schema(awaited, depth);

        if (type.isUnion()) return this.union(type, depth);
        if (c.isTupleType(type)) {
            const args = c.getTypeArguments(type);
            return { type: "array", prefixItems: args.map((a) => this.schema(a, depth + 1)), minItems: args.length };
        }
        if (c.isArrayType(type)) {
            const [item] = c.getTypeArguments(type);
            return { type: "array", items: item ? this.schema(item, depth + 1) : {} };
        }
        const symName = type.getSymbol()?.getName();
        if (symName === "Date") return { type: "string", format: "date-time" };
        if (symName === "Map" || symName === "Set" || symName === "WeakMap") return {};
        if (symName === "Uint8Array" || symName === "Buffer") return { type: "string", description: "binary" };

        const name = this.componentName(type);
        if (name) {
            if (!this.components[name]) {
                this.components[name] = {}; // placeholder: recursive references resolve to the $ref
                this.components[name] = this.object(type, depth + 1);
            }
            return { $ref: `#/components/schemas/${name}` };
        }
        if (this.stack.has(type.id)) return {};
        this.stack.add(type.id);
        try { return this.object(type, depth + 1); } finally { this.stack.delete(type.id); }
    }

    union(type, depth) {
        const c = this.checker;
        const parts = type.types.filter((t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)));
        // boolean is true|false inside a union
        const bools = parts.filter((t) => t.flags & ts.TypeFlags.BooleanLiteral);
        let rest = parts.filter((t) => !(t.flags & ts.TypeFlags.BooleanLiteral));
        const out = [];
        if (bools.length === 2) out.push({ type: "boolean" });
        else for (const b of bools) out.push(this.schema(b, depth + 1));
        const strLits = rest.filter((t) => t.flags & ts.TypeFlags.StringLiteral);
        const numLits = rest.filter((t) => t.flags & ts.TypeFlags.NumberLiteral);
        if (strLits.length > 1) { out.push({ type: "string", enum: strLits.map((t) => t.value) }); rest = rest.filter((t) => !strLits.includes(t)); }
        if (numLits.length > 1) { out.push({ type: "number", enum: numLits.map((t) => t.value) }); rest = rest.filter((t) => !numLits.includes(t)); }
        for (const t of rest) out.push(this.schema(t, depth + 1));
        const uniq = dedupe(out);
        if (uniq.length === 0) return {};
        if (uniq.length === 1) return uniq[0];
        // A nullable scalar reads best as a type list.
        const nul = uniq.findIndex((s) => s.type === "null" && Object.keys(s).length === 1);
        if (uniq.length === 2 && nul >= 0) {
            const other = uniq[1 - nul];
            if (typeof other.type === "string" && !other.$ref) return { ...other, type: [other.type, "null"] };
        }
        return { anyOf: uniq };
    }

    object(type, depth) {
        const c = this.checker;
        const properties = {};
        const required = [];
        for (const prop of c.getPropertiesOfType(type)) {
            const decl = prop.valueDeclaration ?? prop.declarations?.[0];
            const pt = c.getTypeOfSymbol(prop);
            if (pt.getCallSignatures().length > 0 && !(pt.flags & ts.TypeFlags.Union)) continue; // methods
            let optional = Boolean(prop.flags & ts.SymbolFlags.Optional);
            if (pt.isUnion() && pt.types.some((t) => t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void))) optional = true;
            if (pt.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) continue; // always absent in JSON
            const s = this.schema(pt, depth);
            const doc = decl ? ts.displayPartsToString(prop.getDocumentationComment(c)).trim() : "";
            properties[prop.getName()] = doc && !s.$ref ? { ...s, description: doc } : s;
            if (!optional) required.push(prop.getName());
        }
        const out = { type: "object" };
        if (Object.keys(properties).length) out.properties = properties;
        if (required.length) out.required = required;
        const index = c.getIndexInfosOfType(type).find((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number));
        if (index) out.additionalProperties = this.schema(index.type, depth);
        return out;
    }

    /** A project-declared interface, class or type alias gets a component. */
    componentName(type) {
        const sym = type.aliasSymbol ?? type.getSymbol();
        if (!sym) return null;
        if (type.aliasSymbol && type.aliasTypeArguments?.length) return null; // Record<…>, Partial<…>: inline
        const decl = sym.declarations?.[0];
        if (!decl) return null;
        const file = decl.getSourceFile().fileName;
        if (file.includes("/node_modules/")) return null;
        const isAlias = Boolean(type.aliasSymbol);
        const isInterfaceOrClass = ts.isInterfaceDeclaration(decl) || ts.isClassDeclaration(decl);
        if (!isAlias && !isInterfaceOrClass) return null;
        if (type.flags & ts.TypeFlags.Union) return null;
        let name = sym.getName();
        if (!/^[A-Za-z_][\w]*$/.test(name)) return null;
        const existing = this.named.get(type.id);
        if (existing) return existing;
        let n = name; let i = 2;
        while ([...this.named.values()].includes(n)) n = `${name}${i++}`;
        this.named.set(type.id, n);
        return n;
    }
}

function dedupe(list) {
    const seen = new Set();
    return list.filter((s) => { const k = JSON.stringify(s); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A ts.Program for a tsconfig, optionally restricted to some root files.
 *  Resolved from the tsconfig's own directory whatever the caller's cwd: the
 *  repo holds more than one @types/node, and which one a cwd-relative lookup
 *  finds changed the generated types (os.arch() gained or lost its enum). */
export function programFor(tsconfigPath, rootFiles) {
    const dir = tsconfigPath.replace(/\/[^/]+$/, "");
    const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (cfg.error) throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, "\n"));
    const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dir, undefined, tsconfigPath);
    const options = { ...parsed.options, noEmit: true };
    const host = ts.createCompilerHost(options);
    host.getCurrentDirectory = () => dir;
    return ts.createProgram({ rootNames: rootFiles ?? parsed.fileNames, options, host });
}

/** Stable JSON: sorted component names, so regenerating is diff-friendly. */
export function stableJson(value) {
    return JSON.stringify(value, null, 2) + "\n";
}
