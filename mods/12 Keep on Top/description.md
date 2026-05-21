# Mod 12: Keep on Top

## What It Does

Adds a **Window > Keep on Top** toggle to the Tauri app's macOS menu bar. When checked, the Happy window stays above all other windows (`NSWindow.level = .floating`). The state is persisted via `tauri-plugin-store` and re-applied on every launch.

Useful for chatting with an agent in a side window while you're working in another app — no more alt-tabbing.

## Mechanism

- The setting is a single boolean stored under `joy__keepOnTop` in a Tauri-managed JSON store file (`joy.json` under the OS app-data directory). `tauri-plugin-store` handles read/write/persist.
- The menu item is a `CheckMenuItem` whose initial `checked` state reflects the stored value.
- The menu event handler flips the check, calls `window.set_always_on_top(...)`, and writes back to the store.

## Changes

### 1. `packages/happy-app/src-tauri/Cargo.toml`

Add the store plugin dependency:

```toml
tauri-plugin-store = "2"
```

### 2. `packages/happy-app/src-tauri/src/lib.rs`

Full rewrite of the `run()` function to:

1. Register `tauri_plugin_store`.
2. On setup, read `joy__keepOnTop` from the store and call `window.set_always_on_top(...)`.
3. Build a custom macOS app menu (Happy / Edit / Window submenus, mostly populated by `PredefinedMenuItem` so cut/copy/paste/Cmd+Q/etc. all work) and insert a `CheckMenuItem` "Keep on Top" inside Window.
4. Register `on_menu_event` to toggle the window's always-on-top state, flip the check, and persist.

### Why replace the default menu rather than inject?

Tauri 2.x doesn't expose a clean way to mutate the auto-generated default macOS menu (no public API to look up the existing Window submenu and append to it). Replacing the whole menu via `app.set_menu(...)` is the documented path, and `PredefinedMenuItem` covers all the standard items (about / hide / quit / undo / redo / cut / copy / paste / minimize / close) so nothing important is lost.

What we **do** lose from the auto-generated menu, that could be added back manually if desired:
- "Bring All to Front" in Window
- File submenu (we never had real File actions, but some users expect the slot)
- View submenu (Tauri's default View has "Enter Full Screen", etc.)

If any of these matter, add them via `PredefinedMenuItem::fullscreen()` etc. in `lib.rs`.

## How To Use

1. `pnpm tauri:joy` (or `pnpm tauri:build:joy` for the release binary).
2. Top-of-screen menu bar → **Window** → **Keep on Top**. Click to toggle.
3. The window now floats above other windows. The check appears in the menu and the setting survives app restart.

## Why Not Upstream

Personal-build affordance. Most users don't care, and upstream prefers the system's default menu unmodified.

## Rebase Notes

- `Cargo.toml`: easy — just keep the `tauri-plugin-store = "2"` line.
- `src-tauri/src/lib.rs`: this mod overwrites the whole `run()` body, which makes upstream `run()` changes more likely to conflict. When rebasing:
  1. Take upstream's new `run()` as the base.
  2. Re-add the `.plugin(tauri_plugin_store::Builder::default().build())` registration line.
  3. Re-insert the store-load → window apply → menu build → event handler block inside the `setup` closure.
- Store file location is `joy.json` under the Tauri app-data dir. If you rename the bundle identifier upstream, the store moves automatically — no manual data migration needed.
