pub mod chatgpt;
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
use tauri::Manager;

pub const ZOOM_LADDER: [f64; 8] = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    builder =
        builder
            .manage(exec::ExecManager::default())
            .invoke_handler(tauri::generate_handler![
                // Runtime
                storage::lh_runtime_init,
                // Chats & Practice & FSRS
                storage::chats::lh_list_chats,
                storage::chats::lh_load_chat,
                storage::chats::lh_save_chat,
                storage::chats::lh_delete_chat,
                storage::chats::lh_search_chats,
                storage::chats::lh_save_image_snapshot,
                storage::chats::lh_save_chat_image,
                storage::chats::lh_get_image_snapshot,
                storage::chats::lh_list_practice_records,
                // Graph & FSRS
                storage::graph::lh_graph_append_node,
                storage::graph::lh_graph_read_nodes,
                storage::graph::lh_graph_append_chain,
                storage::graph::lh_graph_read_chains,
                storage::graph::lh_graph_append_checkpoint,
                storage::graph::lh_graph_read_checkpoints,
                storage::graph::lh_graph_append_coverage,
                storage::graph::lh_graph_read_coverage,
                storage::graph::lh_graph_append_regroup,
                storage::graph::lh_graph_read_regroups,
                storage::graph::lh_graph_upsert_source,
                storage::graph::lh_graph_save_source,
                storage::graph::lh_graph_read_sources,
                storage::graph::lh_graph_delete_sources,
                storage::graph::lh_graph_delete_source,
                storage::graph::lh_graph_append_source_usage,
                storage::graph::lh_graph_read_positions,
                storage::graph::lh_graph_write_positions,
                storage::graph::lh_graph_save_positions,
                storage::graph::lh_graph_rewrite_ledgers,
                storage::graph::lh_read_graph,
                storage::graph::lh_graph_load_snapshot,
                storage::graph::lh_save_graph,
                storage::graph::lh_graph_revision,
                storage::graph::lh_get_graph_revision,
                storage::graph::lh_search_nodes,
                storage::graph::lh_read_practice_history,
                storage::graph::lh_read_fsrs_cards,
                storage::graph::lh_list_fsrs_cards,
                storage::graph::lh_upsert_fsrs_cards,
                storage::graph::lh_save_fsrs_cards,
                storage::graph::lh_recompute_fsrs_cards,
                storage::graph::lh_graph_clear_all,
                storage::graph::lh_append_graph_events,
                storage::graph::lh_read_graph_events,
                // Jobs
                storage::jobs::lh_job_save,
                storage::jobs::lh_save_job,
                storage::jobs::lh_job_get,
                storage::jobs::lh_get_job,
                storage::jobs::lh_job_list,
                storage::jobs::lh_list_jobs,
                storage::jobs::lh_job_find_by_tool_call,
                storage::jobs::lh_job_delete_for_chat,
                storage::jobs::lh_delete_job,
                // KV, Study, Prompts & Auth
                storage::kv::lh_kv_get,
                storage::kv::lh_kv_set,
                storage::kv::lh_study_read_intervals,
                storage::kv::lh_study_list_intervals,
                storage::kv::lh_study_append_intervals,
                storage::kv::lh_study_append_interval,
                storage::kv::lh_list_study_materials,
                storage::kv::lh_save_study_materials,
                storage::kv::lh_prompt_override_list,
                storage::kv::lh_prompts_list_overrides,
                storage::kv::lh_list_prompt_overrides,
                storage::kv::lh_prompt_override_read,
                storage::kv::lh_prompts_get_override,
                storage::kv::lh_get_prompt_override,
                storage::kv::lh_prompt_override_write,
                storage::kv::lh_prompts_set_override,
                storage::kv::lh_set_prompt_override,
                storage::kv::lh_prompt_override_delete,
                storage::kv::lh_prompts_delete_override,
                storage::kv::lh_auth_read,
                storage::kv::lh_auth_write,
                // FS Bridge & Host Info
                fs_bridge::lh_get_host_dirs,
                fs_bridge::lh_fs_read_external,
                fs_bridge::lh_fs_stat_external,
                fs_bridge::lh_fs_list_external_dir,
                fs_bridge::lh_fs_walk_external,
                fs_bridge::lh_quaderno_write_pdf,
                fs_bridge::lh_quaderno_list_pdfs,
                fs_bridge::lh_debug_write,
                // Other bridges
                chatgpt::lh_chatgpt_control,
                chatgpt::lh_chatgpt_models,
                chatgpt::lh_chatgpt_snapshot,
                chatgpt::lh_chatgpt_stream_start,
                chatgpt::lh_chatgpt_stream_prepare,
                chatgpt::lh_chatgpt_stream_cancel,
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
        let db_state =
            storage::init_storage(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
        let chatgpt = chatgpt::ChatGptOwner::new(db_state.user_data_dir.clone())
            .map_err(std::io::Error::other)?;
        app.manage(chatgpt);
        app.manage(db_state);

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
