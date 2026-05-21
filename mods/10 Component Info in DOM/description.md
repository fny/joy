# Mod 10: Component Info in DOM

## What It Does

Adds `data-component="..."` and `data-source="path/to/file.tsx:42"` attributes to every JSX element when bundling for **web in non-production** builds. In Chrome / Tauri DevTools, every `<div>` you inspect now tells you which React component rendered it and the exact file:line of the JSX — no React DevTools extension required.

Active only when bundling with `platform=web` and `NODE_ENV !== 'production'`, so:

- `pnpm web`, `pnpm tauri:joy`, `pnpm tauri:dev`, `pnpm tauri:build:dev`, `pnpm tauri:build:preview` — **on**
- `pnpm ios`, `pnpm android` — **off** (no platform=web, so the plugin is never registered; native components never see `data-*` props)
- `pnpm tauri:build:joy`, `pnpm tauri:build:production` — **off** (production env)

## Changes

### 1. `packages/happy-app/babel-plugin-component-info.cjs` (new)

A small custom Babel plugin. For each `JSXOpeningElement` it walks up the AST to find the nearest named function / class / variable declarator and emits two pieces of info:

- `component` — the component identifier (e.g. `NewSessionScreen`)
- `source` — `<repo-relative path>:<line>`

The emission shape depends on the JSX tag:

- **Lowercase intrinsics** (`<div>`, `<span>`, etc.): emit literal `data-component=` / `data-source=` JSX attributes. React DOM passes these through unchanged.
- **Capitalised tags statically imported from a known RN-web-aware module** (`react-native`, `react-native-web`, `react-native-reanimated`, `react-native-gesture-handler`, `react-native-safe-area-context`, `react-native-screens`, `react-native-svg`): emit `dataSet={{ component, source }}`. react-native-web filters incoming props through an allowlist (see `node_modules/react-native-web/dist/modules/forwardedProps`) — raw `data-*` props are dropped, but `dataSet` is honoured and translated to `data-*` attributes on the underlying DOM node.
- **Everything else** (third-party web React components, local component wrappers, etc.): **skipped**. If a component renders a plain `<div>` and spreads our injected `dataSet` onto it, React DOM warns "does not recognize the `dataSet` prop on a DOM element". The plugin can't statically know which capitalised tags are RN-web-aware, so it allowlists by import provenance and stays quiet about everything else. Coverage trade-off: we lose attribution on the outermost wrapper of locally-defined components, but the JSX inside those components is still annotated.

Other skips:

- Files under `node_modules`
- Elements without source locations
- `<Fragment>` / `<React.Fragment>` / `<Foo.Fragment>` — React.Fragment only accepts `key`/`children` and warns on any other prop. (`<></>` parses as `JSXFragment` and never reaches this visitor, so it's safe without an explicit check.)
- React Refresh's synthetic `_c`, `_c2`, … names: the refresh transform wraps each component expression in an inline `_c = ...` assignment so it can hot-swap fresh instances on reload. Reporting those as the component name is useless, so when traversal lands on one we keep climbing to the real declarator.

### 2. `packages/happy-app/babel.config.js`

Detects platform via `api.caller(c => c.platform)` and registers the plugin only when `platform === 'web'` and `api.env('production')` is false. The Babel cache key is `platform:env:pluginMtime` — including the plugin file's mtime guarantees that editing the plugin invalidates per-file cached transforms even when source files themselves haven't changed.

## How To Use

1. Run `pnpm tauri:joy` (or `pnpm start --web` for a plain browser).
2. Right-click any element → Inspect.
3. Read `data-component` / `data-source` directly on the DOM node — or filter the DOM tree with the DevTools search bar (e.g. `[data-component="ChatList"]`).
4. Drop the `data-source` value into your editor's "go to file" prompt to jump straight to the JSX.

Verified: on a fresh load of `pnpm start --web`, headless Chrome shows ~31 of 66 rendered `<div>`s carrying `data-component` / `data-source` (the rest are internal wrapper divs emitted by react-native-web and react-navigation that don't correspond to user JSX). No console warnings — including no "React does not recognize the `dataSet` prop on a DOM element" warnings, which a naïve always-emit-dataSet pass would produce whenever a non-rn-web component spreads its props onto a `<div>`.

## Why Not Upstream

Pure dev-affordance for the personal joy build. Adds two attributes to every rendered element, which is harmless in dev but unnecessary noise upstream — and React DevTools already covers this for users who want it.

## Rebase Notes

- The plugin file is brand new, so it carries cleanly.
- `babel.config.js` is the likely conflict point: if upstream adds new plugins or restructures the cache call, splice `componentInfoPlugin` back into the `plugins` array and re-add the `api.cache.using(...)` line. Don't keep `api.cache(true)` if it returns — that bypasses the platform-keyed cache this mod relies on.
