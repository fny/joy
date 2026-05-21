# Mod 00: Mods Page

## What It Is

A "Mods" settings page at `/settings/mods` that replaces the old "Personal" page. Each mod is listed with a toggle switch so it can be enabled or disabled at runtime without a rebuild.

## Changes

### 1. `packages/happy-app/sources/sync/settings.ts`

Add 4 boolean mod toggles (defaults shown):
- `modAudioEnabled: true` — Mod 01
- `modXhighEnabled: false` — Mod 02
- `modSessionDefaultsEnabled: false` — Mod 03
- `modHideModesEnabled: false` — Mod 04

Also add:
- `defaultModelMode: z.string().nullable()` — used by Mod 03
- `defaultEffortLevel: z.string().nullable()` — used by Mod 03

### 2. `packages/happy-app/sources/app/(app)/settings/mods.tsx` (new)

The Mods page. Each mod is an `ItemGroup` with a toggle `Item` at the top. Mod 03 expands inline to show its sub-settings when enabled.

### 3. `packages/happy-app/sources/components/SettingsView.tsx`

Replace "Personal" entry (person-outline icon) with "Mods" entry (construct-outline icon) pointing to `/settings/mods`.

### 4. `packages/happy-app/sources/text/_default.ts` + all translation files

- `settings.personal` / `settings.personalSubtitle` → `settings.mods` / `settings.modsSubtitle`
- `settingsPersonal` section → `settingsMods` section with new keys for each mod

## Why Not Upstream

Upstream has no personal settings page. Rebase conflict likely only if upstream adds a similarly named settings section.
