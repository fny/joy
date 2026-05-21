# Mod 07: Double Tap

## What It Does

Requires a second tap within 2 seconds to commit a selection on assistant-presented choice options. Prevents accidental taps from sending unintended answers. Gated by `joy__doubleTapEnabled`. Default: **disabled**.

Applies to:
- `AskUserQuestion` tool — both option buttons and the Submit button.
- Inline `<options>` choice blocks parsed out of assistant markdown (rendered by `RenderOptionsBlock` in `MarkdownView.tsx`).

Other tool calls (Edit, Write, Bash, etc.) are unaffected — the user can introspect their input before approving them, so an accidental single tap is less consequential there.

## Changes

### 1. `packages/happy-app/sources/sync/settings.ts`

Setting added:
- `joy__doubleTapEnabled: z.boolean()` (default `false`)

### 2. `packages/happy-app/sources/hooks/useDoubleTap.ts` (new file)

Shared hook returning `{ enabled, armedKey, requireDoubleTap }`. Tracks an `armedKey` and a 2-second auto-disarm timer. When the mod is off, `requireDoubleTap` is a pass-through.

### 3. `packages/happy-app/sources/components/tools/views/AskUserQuestionView.tsx`

Uses `useDoubleTap()` to gate option toggling and Submit. Armed option gets a thicker accent border; armed Submit dims and switches its label to "Tap again to submit".

### 4. `packages/happy-app/sources/components/markdown/MarkdownView.tsx`

`RenderOptionsBlock` uses `useDoubleTap()` to gate `onOptionPress`. Armed option gets a thicker accent border and its label is replaced with `"Tap again: <label>"`.

## Why Not Upstream

Strictly personal — most users don't want a second tap. Upstream has no reason to add this.
