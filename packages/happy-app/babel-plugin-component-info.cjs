/**
 * Adds `data-component` / `data-source` info to JSX elements so the rendered
 * DOM tells you which React component (and which file:line) produced each
 * node. Active only when this plugin is registered — see babel.config.js,
 * which only registers it for web in non-production builds.
 *
 * How attributes are emitted depends on the JSX tag:
 *
 * - Lowercase intrinsics (`<div>`, `<span>`): literal `data-component`,
 *   `data-source` JSX attributes. React DOM passes these through unchanged.
 * - Capitalised JSX whose tag was statically imported from a known RN-web-
 *   aware module (see RN_DATASET_MODULES): `dataSet={{ component, source }}`.
 *   react-native-web's `createDOMProps` translates `dataSet` into `data-*`
 *   on the underlying DOM element via its prop allowlist.
 * - Anything else (third-party web React components, local components whose
 *   provenance can't be proven safe, etc.) is skipped. Otherwise React DOM
 *   warns "does not recognize the `dataSet` prop on a DOM element" when
 *   such a component spreads our injected prop onto a `<div>`.
 *
 * Trade-off: we lose attribution on the outermost wrapper of locally
 * defined components, but the JSX *inside* those components is still
 * annotated, so the inner DOM nodes still carry the right info.
 */
const path = require('node:path');

// Modules whose exports either (a) forward `dataSet` through to the DOM
// (react-native-web's whole API does this) or (b) compose on top of those
// exports (reanimated, gesture-handler, safe-area-context, etc.).
const RN_DATASET_MODULES = new Set([
    'react-native',
    'react-native-web',
    'react-native-reanimated',
    'react-native-gesture-handler',
    'react-native-safe-area-context',
    'react-native-screens',
    'react-native-svg',
]);

// React Refresh wraps each component expression in `_c = ...` so it can swap
// fresh instances on reload. We climb past those rather than reporting them
// as the component name.
const REFRESH_TEMP_NAME = /^_c\d*$/;

function findEnclosingComponentName(jsxPath, t) {
    const fn = jsxPath.findParent((p) =>
        p.isFunctionDeclaration() ||
        p.isFunctionExpression() ||
        p.isArrowFunctionExpression() ||
        p.isClassDeclaration()
    );
    if (!fn) return null;

    if ((fn.isFunctionDeclaration() || fn.isClassDeclaration()) && fn.node.id) {
        return fn.node.id.name;
    }

    let cursor = fn.parentPath;
    while (cursor && !cursor.isProgram()) {
        if (cursor.isVariableDeclarator() && t.isIdentifier(cursor.node.id)) {
            const name = cursor.node.id.name;
            if (!REFRESH_TEMP_NAME.test(name)) return name;
        }
        if (cursor.isAssignmentExpression() && t.isIdentifier(cursor.node.left)) {
            const name = cursor.node.left.name;
            if (!REFRESH_TEMP_NAME.test(name)) return name;
        }
        if (cursor.isObjectProperty() && t.isIdentifier(cursor.node.key)) {
            const name = cursor.node.key.name;
            if (!REFRESH_TEMP_NAME.test(name)) return name;
        }
        cursor = cursor.parentPath;
    }
    return null;
}

function hasJsxAttr(openingNode, name, t) {
    return openingNode.attributes.some(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === name
    );
}

// React.Fragment / Fragment / Foo.Fragment only accept `key` and `children`.
// `<></>` parses as JSXFragment and never reaches this visitor.
function isFragmentLikeName(nameNode, t) {
    if (t.isJSXIdentifier(nameNode)) {
        return nameNode.name === 'Fragment';
    }
    if (t.isJSXMemberExpression(nameNode) && t.isJSXIdentifier(nameNode.property)) {
        return nameNode.property.name === 'Fragment';
    }
    return false;
}

function collectRnNames(programNode, t) {
    const names = new Set();
    for (const node of programNode.body) {
        if (!t.isImportDeclaration(node)) continue;
        if (!RN_DATASET_MODULES.has(node.source.value)) continue;
        for (const spec of node.specifiers) {
            // import X from 'foo'   /   import { X } from 'foo'  /  import * as X from 'foo'
            if (spec.local && t.isIdentifier(spec.local)) {
                names.add(spec.local.name);
            }
        }
    }
    return names;
}

function jsxBaseName(nameNode, t) {
    if (t.isJSXIdentifier(nameNode)) return nameNode.name;
    if (t.isJSXMemberExpression(nameNode)) {
        let cursor = nameNode.object;
        while (t.isJSXMemberExpression(cursor)) cursor = cursor.object;
        if (t.isJSXIdentifier(cursor)) return cursor.name;
    }
    return null;
}

function pushPlainDataAttrs(openingNode, t, componentName, source) {
    if (componentName && !hasJsxAttr(openingNode, 'data-component', t)) {
        openingNode.attributes.push(
            t.jsxAttribute(t.jsxIdentifier('data-component'), t.stringLiteral(componentName)),
        );
    }
    if (!hasJsxAttr(openingNode, 'data-source', t)) {
        openingNode.attributes.push(
            t.jsxAttribute(t.jsxIdentifier('data-source'), t.stringLiteral(source)),
        );
    }
}

function pushDataSetAttrs(openingNode, t, componentName, source) {
    const existing = openingNode.attributes.find(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'dataSet',
    );

    if (!existing) {
        const props = [];
        if (componentName) {
            props.push(t.objectProperty(t.identifier('component'), t.stringLiteral(componentName)));
        }
        props.push(t.objectProperty(t.identifier('source'), t.stringLiteral(source)));
        openingNode.attributes.push(
            t.jsxAttribute(
                t.jsxIdentifier('dataSet'),
                t.jsxExpressionContainer(t.objectExpression(props)),
            ),
        );
        return;
    }

    // Only merge when the existing dataSet is a plain object literal we can safely augment.
    if (
        !existing.value ||
        !t.isJSXExpressionContainer(existing.value) ||
        !t.isObjectExpression(existing.value.expression)
    ) {
        return;
    }

    const obj = existing.value.expression;
    const hasKey = (key) =>
        obj.properties.some(
            (p) =>
                t.isObjectProperty(p) &&
                !p.computed &&
                ((t.isIdentifier(p.key) && p.key.name === key) ||
                    (t.isStringLiteral(p.key) && p.key.value === key)),
        );

    if (componentName && !hasKey('component')) {
        obj.properties.push(
            t.objectProperty(t.identifier('component'), t.stringLiteral(componentName)),
        );
    }
    if (!hasKey('source')) {
        obj.properties.push(t.objectProperty(t.identifier('source'), t.stringLiteral(source)));
    }
}

module.exports = function ({ types: t }) {
    return {
        name: 'component-info',
        visitor: {
            Program(programPath, state) {
                state.rnNames = collectRnNames(programPath.node, t);
            },
            JSXOpeningElement(openingPath, state) {
                const filename = state.filename || '';
                if (!filename || filename.includes('node_modules')) return;
                if (isFragmentLikeName(openingPath.node.name, t)) return;

                const loc = openingPath.node.loc;
                if (!loc) return;

                const nameNode = openingPath.node.name;
                const componentName = findEnclosingComponentName(openingPath, t);
                const rel = path.relative(state.cwd || process.cwd(), filename);
                const source = `${rel}:${loc.start.line}`;

                // Lowercase intrinsic — React DOM passes data-* through directly.
                if (t.isJSXIdentifier(nameNode) && /^[a-z]/.test(nameNode.name)) {
                    pushPlainDataAttrs(openingPath.node, t, componentName, source);
                    return;
                }

                // Capitalised: only emit when we can prove the tag came from an
                // RN-web-aware module. Anything else is skipped to avoid the
                // "React does not recognize the `dataSet` prop" warning that
                // fires when a third-party React component spreads our injected
                // prop onto a `<div>`.
                const base = jsxBaseName(nameNode, t);
                if (base && state.rnNames && state.rnNames.has(base)) {
                    pushDataSetAttrs(openingPath.node, t, componentName, source);
                }
            },
        },
    };
};
