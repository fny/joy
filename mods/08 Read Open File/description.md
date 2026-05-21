# Mod 08: Read Open File

## What It Does

For `Read` tool calls, renders an "Open file" button in the tool view that navigates to Happy's in-app file viewer (`/session/{id}/file?path=…`). The viewer fetches file bytes from the machine where Claude is running via the same `sessionReadFile` RPC over the session socket that the File Diff Sidebar and Edit/MultiEdit/Write file routes use. Works even when the desktop/mobile app is on a different machine from Claude. Gated by `joy__readOpenFileEnabled`. Default: **disabled**.

Only applies to `Read` — Edit/Write/MultiEdit already make their whole tool row pressable to the same file route. Bash and similar tools don't have a single file path to open.

## Changes

### 1. `packages/happy-app/sources/sync/settings.ts`

Setting added:
- `joy__readOpenFileEnabled: z.boolean()` (default `false`)

### 2. `packages/happy-app/sources/components/tools/ToolView.tsx`

- New `readFilePath` derived from `tool.input.file_path` when `tool.name === 'Read'`.
- New `handleOpenReadFile` callback that `router.push`es to `/session/{sessionId}/file?path={base64(path)}` — the exact route Edit/MultiEdit/Write already use.
- Default fallback view (used for tools without a custom view) renders a `ToolSectionView` containing an "Open file" button between the input dump and the output dump when the setting is on, the path is known, and we have a `sessionId`.

### 3. `packages/happy-app/sources/components/tools/ToolFullView.tsx`

Same idea on the full-screen view: when a Read call is rendered (no specialized view) and the mod is on, an "Open file" button appears directly below the "Input Parameters" section. Passes `sessionId` in from `messageId.tsx`.

## Why Not Upstream

Niche personal convenience — upstream's Edit/MultiEdit/Write rows are already pressable; adding it to Read isn't a clear win for everyone.
