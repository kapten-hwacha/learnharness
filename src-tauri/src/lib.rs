pub mod exec;
pub mod fs_bridge;
pub mod http_bridge;
pub mod oauth;
pub mod storage;
pub mod window;

#[cfg(not(target_os = "ios"))]
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(not(target_os = "ios"))]
use std::sync::Arc;
#[cfg(not(target_os = "ios"))]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
#[cfg(not(target_os = "ios"))]
use tauri::Emitter;

pub const ZOOM_LADDER: [f64; 8] = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    builder =
        builder
            .manage(exec::ExecManager::default())
            .invoke_handler(tauri::generate_handler![
                fs_bridge::lh_fs_hydrate,
                fs_bridge::lh_fs_sync,
                fs_bridge::lh_fs_read_external,
                http_bridge::lh_http_fetch,
                http_bridge::lh_open_external,
                oauth::lh_oauth_listen_start,
                oauth::lh_oauth_listen_close,
                oauth::lh_oauth_respond,
                exec::lh_exec_command,
                exec::lh_spawn_daemon,
                exec::lh_kill_daemon,
                exec::lh_kill_process,
                window::lh_expand_window,
                window::lh_set_zoom,
            ]);

    builder = builder.setup(|app| {
        #[cfg(not(target_os = "ios"))]
        {
            let current_zoom_index = Arc::new(AtomicUsize::new(2)); // index 2 is 1.0

            // Build Menu
            let app_handle = app.handle();
            let app_menu = SubmenuBuilder::new(app_handle, "LearnHarness")
                .item(&PredefinedMenuItem::about(
                    app_handle,
                    Some("About LearnHarness"),
                    None,
                )?)
                .separator()
                .item(&PredefinedMenuItem::hide(
                    app_handle,
                    Some("Hide LearnHarness"),
                )?)
                .item(&PredefinedMenuItem::hide_others(
                    app_handle,
                    Some("Hide Others"),
                )?)
                .item(&PredefinedMenuItem::show_all(app_handle, Some("Show All"))?)
                .separator()
                .item(&PredefinedMenuItem::quit(
                    app_handle,
                    Some("Quit LearnHarness"),
                )?)
                .build()?;

            let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_menu = SubmenuBuilder::new(app_handle, "View")
                .item(
                    &MenuItemBuilder::with_id("zoom_actual", "Actual Size")
                        .accelerator("CmdOrCtrl+0")
                        .build(app_handle)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_in", "Zoom In")
                        .accelerator("CmdOrCtrl+Plus")
                        .build(app_handle)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_out", "Zoom Out")
                        .accelerator("CmdOrCtrl+-")
                        .build(app_handle)?,
                )
                .separator()
                .fullscreen()
                .build()?;

            let window_menu = SubmenuBuilder::new(app_handle, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app_handle)
                .items(&[&app_menu, &edit_menu, &view_menu, &window_menu])
                .build()?;

            app.set_menu(menu)?;

            let zoom_idx_clone = current_zoom_index.clone();
            app.on_menu_event(move |app_h, event| match event.id().as_ref() {
                "zoom_actual" => {
                    zoom_idx_clone.store(2, Ordering::SeqCst);
                    let _ = app_h.emit("lh://zoom", 1.0);
                }
                "zoom_in" => {
                    let prev = zoom_idx_clone.load(Ordering::SeqCst);
                    let next = (prev + 1).min(ZOOM_LADDER.len() - 1);
                    zoom_idx_clone.store(next, Ordering::SeqCst);
                    let _ = app_h.emit("lh://zoom", ZOOM_LADDER[next]);
                }
                "zoom_out" => {
                    let prev = zoom_idx_clone.load(Ordering::SeqCst);
                    let next = prev.saturating_sub(1);
                    zoom_idx_clone.store(next, Ordering::SeqCst);
                    let _ = app_h.emit("lh://zoom", ZOOM_LADDER[next]);
                }
                _ => {}
            });
        }

        #[cfg(target_os = "ios")]
        {
            let _ = app;
        }

        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
