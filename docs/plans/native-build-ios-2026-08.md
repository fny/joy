# iOS native build plan — approved 2026-08-16

Scope approved by Faraz ("we want all of this, forget the android stuff").
Everything below requires a native build (new runtime version); nothing here
ships via OTA. Once built, the features that ride on it can iterate OTA.

## Targets (new native processes)

1. **Widget extension (WidgetKit + ActivityKit)** — one target covers both:
   - **Live Activity** (lock screen + Dynamic Island), priority order:
     RAM high → disk high → Claude limit ≥90% → Codex limit ≥90% →
     ready-state jobs count (green) → periodic 30-day spend (from the daemon's
     usage cache). Refresh cadence 4h.
   - Home-screen widgets: limits/spend at a glance (same data plumbing).
   - Updates: Live Activity **push tokens** → daemon sends ActivityKit updates
     via APNs directly (daemon half — threshold detection + alert pushes —
     already shipped in `domain/resourceAlerts.ts`).
2. **Notification Service Extension** — decrypt push payloads on-device with
   the account key so notifications can carry real E2E content (session names,
   message previews) instead of plaintext-only headlines.
3. **Share extension** *(later phase, approved)* — share files/images/text
   from any app into a joy session.
4. **Watch app / complications** *(later phase, approved)* — glanceable
   limits + alerts.

## Entitlements & capabilities

- **App Group** (`group.vip.voltai.joy`) — shared container for widget/NSE/
  share targets (MMKV/SQLite state handoff).
- **Keychain access group** — extensions read the account key for decryption.
- **Background modes**: `remote-notification`, `processing`, `fetch`
  (expo-background-task 4h cycle), `audio` (voice sessions in background —
  verify whether already present).
- **Associated domains** — universal links for `joy.expo.app` (+ auth handoff).
- **Time-sensitive notifications** — interruption level on the 90% alerts
  (config only). **Critical alerts** — file the Apple entitlement request in
  parallel (approval takes time); enables bypass-mute for quota/resource
  alarms.

## Build-time config (no extension needed)

- **Actionable notification categories**: Approve/Deny on permission-prompt
  pushes; quick-reply on "agent waiting" pushes. Daemon/relay side sets the
  category on the push; app registers handlers.
- **Usage strings**: Face ID (`NSFaceIDUsageDescription` — app lock via the
  already-bundled expo-local-authentication), local network + Bonjour
  (`NSLocalNetworkUsageDescription` — future LAN direct-connect to the
  daemon's local HTTP API).
- **New native npm deps to bake in**: `expo-sqlite` (FTS5 offline session
  search + durable caches), `expo-background-task` + `expo-task-manager`,
  `expo-quick-actions` (icon long-press: New session / Limits).
  Already bundled, no action: skia, webview, local-auth, audio, sharing,
  document-picker, haptics.
- **App Intents** (Siri / Shortcuts / Spotlight / Action button): "new session
  in <project>", "read my limits", limit surfacing automations.

## Sequencing

1. Config-plugin work in-repo (expo-apple-targets or config plugins for the
   widget + NSE targets; App Group/Keychain/entitlements in app.json).
2. `eas build` (iOS) → new runtime version; TestFlight/dev install.
3. Post-build OTA work: Live Activity JS wiring, FTS5 search index,
   background-task refresh loop, quick actions, notification categories.
4. Parallel: file the critical-alerts entitlement request with Apple.
5. Later phases: share extension, watch app.

Android explicitly out of scope for this pass.
