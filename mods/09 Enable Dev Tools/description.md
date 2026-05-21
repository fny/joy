# Mod 09: Enable Dev Tools

## What It Does

Enables the WebKit web inspector (right-click → Inspect Element) in release Tauri builds. By default Tauri v2 disables devtools in release builds for security; with this mod the inspector ships with the `Happy.app` produced by `pnpm tauri:build:joy`. Always on — no runtime toggle.

Dev builds (`pnpm tauri:joy`, `pnpm tauri:build:dev`) already have the inspector and are unaffected by this change.

## Changes

### 1. `packages/happy-app/src-tauri/Cargo.toml`

Added the `devtools` Cargo feature to the `tauri` crate dependency:

```toml
tauri = { version = "~2.9", features = ["devtools"] }
```

This compiles the WebKit inspector into release binaries.

## Why Not Upstream

Upstream ships release builds to end users and doesn't want them poking at the webview. For the personal joy build this is fine — and far easier than running a dev build when investigating layout/perf in the actual production-style binary.
