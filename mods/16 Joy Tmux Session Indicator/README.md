# Mod 16: Joy Tmux Session Indicator

Sessions launched by joy-tmux now show a small terminal badge and get joy-specific actions in the long-press popover.

## Changes

### packages/joy-tmux/relay.ts
- Add `source: 'joy-tmux'` and `joySessionId` to session creation metadata so the app can identify and interact with joy sessions.

### packages/happy-app/sources/sync/storageTypes.ts
- Add `source` and `joySessionId` optional fields to `MetadataSchema`.

### packages/happy-app/sources/sync/storage.ts
- Add `isJoyTmux: boolean` and `joySessionId: string | null` to `SessionRowData`.
- Populate from `session.metadata?.source === 'joy-tmux'`.

### packages/happy-app/sources/components/SessionsList.tsx
- Render a small `>_` terminal icon (color: textSecondary, size 11) after session name when `session.isJoyTmux`.

### packages/happy-app/sources/hooks/useSessionQuickActions.ts
- When `session.metadata?.source === 'joy-tmux'`, add a "View Pane" action that fetches pane content from the joy-tmux server and shows it in a modal.

### packages/happy-app/sources/text/_default.ts + all translations
- Add `settingsSessions.viewPane` key.
