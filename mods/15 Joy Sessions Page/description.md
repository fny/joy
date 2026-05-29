# Mod 15: Joy Sessions Page

Adds a Settings → Joy Sessions page for managing joy-tmux sessions directly from the app.

## Features

- **List active sessions**: Shows all non-ended joy-tmux sessions with their working directory and status.
- **Create session**: Prompts for a working directory path, then creates a new tmux-based Claude session.
- **Kill session**: Trash-button per row with a destructive confirmation modal.
- **Continue session**: Tapping a session navigates to its relay session chat view.

## Settings dependency

Reads `joy__tmuxServerUrl` setting (default: `http://localhost:4997`) to locate the joy-tmux server.

## Implementation

- `useJoyTmuxSessions(serverUrl)` hook — polls `/sessions` every 5 s on focus, exposes `createSession` / `killSession`.
- `settings/sessions.tsx` page — `killingIdRef` pattern for stable per-item kill action.
- New `joy__tmuxServerUrl` field added to Settings schema.
- Navigation entry in `(app)/_layout.tsx` and link in `SettingsView.tsx`.
- All 10 language files updated with `settings.sessions`, `settings.sessionsSubtitle`, and full `settingsSessions.*` section.
