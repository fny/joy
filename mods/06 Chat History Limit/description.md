# Mod 06: Chat History Limit

## What It Does

Caps the number of messages rendered per conversation. Gated by `joy__chatHistoryLimit != null` — set a number to enable, clear to disable. Default: **null (off)**.

## Changes

### 1. `packages/happy-app/sources/sync/settings.ts`

Setting added:
- `joy__chatHistoryLimit: z.number().nullable()` (default `null`)

### 2. `packages/happy-app/sources/components/ChatList.tsx`

When `joy__chatHistoryLimit` is non-null, `messages.slice(0, joy__chatHistoryLimit)` is passed to the internal list instead of the full message array.

### 3. `packages/happy-app/sources/app/(app)/settings/mods.tsx`

New `ItemGroup` ("05 · Chat History Limit") with a single Item that opens a numeric prompt. Clearing the prompt sets the value back to `null`.

## Why Not Upstream

Personal preference for trimming long conversations to improve scroll performance on the desktop build. Upstream has no notion of message capping.
