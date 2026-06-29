// Mod 12: Window > Keep on Top menu toggle, persisted via tauri-plugin-store.
//
// Tauri auto-generates a default macOS app menu when no menu is set. There is
// no clean API in Tauri 2.x to inject a single item into that default menu,
// so this mod builds a replacement menu that mirrors the standard macOS
// conventions (Happy / Edit / Window submenus via `PredefinedMenuItem`) and
// inserts a `CheckMenuItem` "Keep on Top" inside the Window submenu.
//
// The toggle state is persisted to `joy.json` via `tauri-plugin-store` and
// re-applied on next launch.

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, SubmenuBuilder};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "joy.json";
const KEEP_ON_TOP_KEY: &str = "joy__keepOnTop";
const MENU_ID_KEEP_ON_TOP: &str = "joy:keep-on-top";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Load persisted Keep-on-Top state (defaults to false on first launch
            // or if the value is missing/wrong type).
            let store = app.store(STORE_FILE)?;
            let keep_on_top: bool = store
                .get(KEEP_ON_TOP_KEY)
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Apply to the main window so the setting takes effect immediately
            // on app launch, before the user opens the Window menu.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(keep_on_top);
            }

            let keep_on_top_item = CheckMenuItemBuilder::with_id(MENU_ID_KEEP_ON_TOP, "Keep on Top")
                .checked(keep_on_top)
                .build(app)?;

            let app_submenu = SubmenuBuilder::new(app, "Happy")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_submenu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .item(&keep_on_top_item)
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_submenu, &edit_submenu, &window_submenu])
                .build()?;

            app.set_menu(menu)?;

            // Toggle handler: flip the check, flip the window state, persist.
            let keep_on_top_item_for_event = keep_on_top_item.clone();
            app.on_menu_event(move |app, event| {
                if event.id().as_ref() == MENU_ID_KEEP_ON_TOP {
                    let new_state = !keep_on_top_item_for_event.is_checked().unwrap_or(false);
                    let _ = keep_on_top_item_for_event.set_checked(new_state);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_always_on_top(new_state);
                    }
                    if let Ok(store) = app.store(STORE_FILE) {
                        store.set(KEEP_ON_TOP_KEY, serde_json::json!(new_state));
                        let _ = store.save();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
