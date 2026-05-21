# Mod 02: xhigh Effort

## What It Does

Adds an `xhigh` effort level between `high` and `max` for Claude. Gated behind `modXhighEnabled` — when disabled the xhigh option is filtered out of the effort picker. Default: **disabled**.

## Changes

### 1. `packages/happy-app/sources/components/modelModeOptions.ts`

`getClaudeEffortLevels()` already returns `xhigh` between `high` and `max`. No change needed here — filtering is done at the call sites.

### 2. `packages/happy-app/sources/app/(app)/new/index.tsx`

`effortLevels` memo filters out `xhigh` when `modXhighEnabled` is false.

### 3. `packages/happy-app/sources/-session/SessionView.tsx`

`availableEffortLevels` memo filters out `xhigh` when `modXhighEnabled` is false.

## Why Not Upstream

Upstream `getClaudeEffortLevels` has 4 entries (no xhigh). Conflict only if upstream adds xhigh themselves. The server must accept `"xhigh"` as an effort value — verify before enabling in production.
