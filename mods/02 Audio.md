# Mod 01: Audio

## What It Does

Enables macOS microphone access in the Tauri desktop build, and gates the voice input button in the app UI behind the mod toggle (`modAudioEnabled`). Default: **enabled**.

## Changes

### 1. `packages/happy-app/src-tauri/entitlements.plist` (new)

Grants `com.apple.security.device.audio-input` entitlement so the sandboxed macOS app can access the microphone.

### 2. `packages/happy-app/src-tauri/info.plist` (new)

`NSMicrophoneUsageDescription` key with user-facing permission prompt text.

### 3. `packages/happy-app/src-tauri/tauri.conf.json`

`bundle.macOS` block pointing to both plist files.

### 4. Runtime toggle (`modAudioEnabled`)

When disabled, the voice button is hidden. The entitlement remains in the build regardless — the toggle only controls UI visibility.

## Why Not Upstream

Upstream `tauri.conf.json` has no `bundle.macOS` block. Conflict only if upstream adds one.
