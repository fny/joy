# Mod 04: Hide Permission Modes

## What It Does

Filters the Claude permission mode selector to show only **Plan** and **Yolo** (bypassPermissions). Gated behind `modHideModesEnabled`. Default: **disabled**.

## Changes

### 1. `packages/happy-app/sources/app/(app)/new/index.tsx`

`permissionModes` memo filters to `plan` and `bypassPermissions` when `modHideModesEnabled` is true and agent is `claude`.

### 2. `packages/happy-app/sources/-session/SessionView.tsx`

`availableModes` memo filters to `plan` and `bypassPermissions` when `modHideModesEnabled` is true and flavor is `claude` (or unset).

## Why Not Upstream

Upstream always shows all permission modes. No conflict expected unless upstream adds similar filtering.
