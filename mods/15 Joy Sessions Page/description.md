# Mod 15: Joy Sessions Page

Adds a Settings → Joy Sessions page for managing joy-tmux sessions via RPC through the relay.

## Features

- **Machine picker**: Selects which connected machine is running joy-tmux. Auto-selects the first online machine.
- **List active sessions**: Shows all non-ended joy-tmux sessions with status and working directory.
- **Create session**: Prompts for a working directory, then creates a new tmux-based Claude session via RPC.
- **Kill session**: Trash-button per row with a destructive confirmation modal.
- **Pane screenshot**: Terminal-icon button fetches and displays current tmux pane content in a modal.
- **Continue session**: Tapping a session navigates to its relay session chat view.

## Architecture

Uses `machineRPC` through the relay — no direct HTTP to the joy-tmux server. All operations go through the standard RPC channel:
- `joy-list-sessions` — list active sessions
- `joy-create-session` — spawn a new session
- `joy-kill-session` — terminate a session
- `joy-pane` — capture current tmux pane text
- `joy-send` — send a message to a session

## Implementation

- `useJoyRpcSessions(machineId)` hook — polls every 5s on focus, exposes `createSession` / `killSession` / `fetchPane` via RPC.
- `settings/sessions.tsx` page — machine picker + session list.
- Navigation entry in `(app)/_layout.tsx` and link in `SettingsView.tsx`.
- All 10 language files updated with `settingsSessions.machine/machineFooter/noMachine/selectMachine`.

## joy-tmux side

`relay.ts` gains RPC handler support: `registerRpcHandler`, `encryptRpc`/`decryptRpc` (matching happy-cli's `encryptWithDataKey` format), and `rpc-request` socket listener. Handlers registered at startup in `server.ts`.
