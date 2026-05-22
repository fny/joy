# mod(14): Edit raw settings payload

## What It Does

Adds an **08 · Raw Settings** entry to the Mods settings page that opens a
full‑screen JSON editor for the entire settings payload. Saving **replaces** the
whole settings object rather than merging it, so keys you remove — including
deprecated/unknown keys that no toggle controls — are actually dropped, both
locally and on the Happy server.

## Why

The normal settings mutation path (`applySettings`) only ever merges deltas and
fills defaults; it can never delete a key. Deprecated or stray keys that linger
in the synced payload (e.g. settings from a removed feature, or leftover keys
from an older build) therefore stick around forever. A raw editor that replaces
the payload is the simplest way to clean them up.

## Changes

### 1. `packages/happy-app/sources/sync/storage.ts`
New `applySettingsRaw(settings)` store action — wholesale replace of
`state.settings` (no merge with the previous object), keeping the current
`settingsVersion`, and persisting locally.

### 2. `packages/happy-app/sources/sync/sync.ts`
New `sync.replaceSettings(raw)`:
- runs `settingsParse(raw)` so known fields keep their defaults and any kept
  unknown keys are preserved verbatim, while keys the user removed stay removed;
- calls `applySettingsRaw(parsed)`;
- replaces `pendingSettings` wholesale (so a stale delta can't re‑introduce a
  removed key) and invalidates the settings sync, which POSTs the cleaned
  payload to the server.

### 3. `packages/happy-app/sources/app/(app)/settings/raw.tsx` (new)
The editor screen: shows `JSON.stringify(settings, null, 2)` in a multiline
input with **Reset** and **Save**. Save validates JSON (must be an object),
confirms via `Modal` (never RN `Alert`), then calls `sync.replaceSettings()` and
navigates back. Dev/debug page → strings are intentionally not i18n'd.

### 4. `packages/happy-app/sources/app/(app)/_layout.tsx`
Registers the `settings/raw` route with header title "Raw Settings".

### 5. `packages/happy-app/sources/app/(app)/settings/mods.tsx`
Adds the "08 · Raw Settings" `ItemGroup` linking to `/settings/raw`.

## Why Not Upstream

Power‑user/debug affordance for the personal `joy` build. Upstream prefers users
not hand‑edit the encrypted settings payload.

## Rebase Notes

- `storage.ts` / `sync.ts`: the new methods are additive; conflicts only if
  upstream restructures the settings store/sync. Re‑add `applySettingsRaw` next
  to `applySettings`, and `replaceSettings` next to `applySettings` in the sync
  class.
- `mods.tsx` is mod(01)'s file; this appends one `ItemGroup`.
