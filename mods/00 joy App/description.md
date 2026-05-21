# Mod 00 — joy App

## What
Personal build of Happy with a separate app identifier and mobile icon.

## Changes
- `src-tauri/tauri.joy.conf.json` — overrides productName, identifier (`com.farazyashar.joy`), and icon to use `icon-joy.icns`
- `src-tauri/icons/icon-joy.icns` — generated from `sources/assets/images/icon.png` (the 1024×1024 mobile icon) via `iconutil`
- `package.json` — adds `tauri:joy` (dev) and `tauri:build:joy` (release) scripts

## Why Not Upstream
No conflicts expected — all new files. `package.json` scripts section may drift if upstream adds new tauri scripts nearby.
