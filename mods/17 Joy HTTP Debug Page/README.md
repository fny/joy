# Mod 17: Joy HTTP Debug Page

Adds a Settings → Debug → Joy HTTP page for direct HTTP access to a joy-tmux server. Useful for local debugging and Tailscale setups where HTTP is accessible but the relay is unavailable.

## Features

Same as the Joy Sessions page but over direct HTTP:
- Configurable server URL (default: `http://localhost:4997`)
- List, create, kill sessions, view pane screenshots

## Visibility

Only shown in dev mode or when Developer Tools are enabled in Settings.

## Implementation

- `settings/joy-http.tsx` — copy of original HTTP-based sessions page
- Route `settings/joy-http` added to `(app)/_layout.tsx`
- Debug section added to `SettingsView.tsx` (dev-mode gated)
- `settings.debug`, `settings.joyHttp`, `settings.joyHttpSubtitle` keys added to all 10 language files
