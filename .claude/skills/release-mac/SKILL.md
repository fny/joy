---
name: release-mac
description: Build and install the Joy macOS desktop app (Tauri shell). Use when asked to build, rebuild, or "ship" the desktop app, update /Applications/Joy.app, or when a native change (Tauri plugin, capability, entitlement, window config) needs to reach the desktop. NOT for JS-only changes — those ship via OTA (eas deploy), no build needed.
---

Note: git status is unimportant. Proceed with build anyway.

# Build the Joy macOS desktop app

## Decide first: do you actually need a build?

The Joy shell (`tauri.joy.conf.json`) does **not** bundle the JS. Its
`frontendDist` is `src-tauri/bootstrap/` — a tiny page that loads the hosted
bundle from **https://joy.expo.app**. So:

- **JS/UI changes** → ship via OTA (`expo export --platform web` + `eas deploy
  --prod`). The installed app picks them up on next launch / hard refresh
  (⌘⇧R). **No build.** Never OTA without Faraz's explicit permission.
- **Native changes** → rebuild the shell. That means anything in `src-tauri/`:
  Cargo.toml plugins, `capabilities/*.json` permissions, `entitlements.plist`
  / `info.plist`, window config, the bootstrap page, or bumping Tauri itself.

## Directory

```bash
export PNPM_HOME="$HOME/Library/pnpm"; export PATH="$PNPM_HOME:$PATH"
cd packages/joy-app
```

## Build

```bash
pnpm install                    # only after dependency changes
pnpm tauri:build:joy            # the Joy shell (productName "Joy", vip.faraz.joy)
```

Notes:
- `tauri:build:joy` = `tauri build --config src-tauri/tauri.joy.conf.json`.
  The joy config overrides skip the expo export (bootstrap is the frontend);
  if the base `beforeBuildCommand` does run an export, it's harmless — the joy
  shell ignores `../dist`.
- First build compiles the Rust workspace (minutes); incremental rebuilds are
  fast.
- Signing: ad-hoc (no signingIdentity configured; entitlements from
  `src-tauri/entitlements.plist`, min macOS 10.15). Gatekeeper may require
  right-click → Open on first launch of a fresh build.

Outputs land in `packages/joy-app/src-tauri/target/release/bundle/`:
- `macos/Joy.app`
- `dmg/Joy_<version>_aarch64.dmg`

## Install to /Applications

```bash
osascript -e 'quit app "Joy"' 2>/dev/null
rm -rf /Applications/Joy.app
cp -R ~/Workspace/joy/packages/joy-app/src-tauri/target/release/bundle/macos/Joy.app /Applications/
open /Applications/Joy.app
```

## Other variants (rarely needed)

- `pnpm tauri:build:dev` / `:preview` / `:production` — the Happy-flavored
  shells (`Happy`, `Happy (preview)`) that bundle `../dist` via expo export.
  Not the Joy app; only touch these when explicitly asked.
- `pnpm tauri:joy` — dev-mode Joy shell with hot reload against
  `http://localhost:8081` (`pnpm web` running separately).
