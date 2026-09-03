mod asset_vault;
mod commands;
mod domain;
mod error;
mod input_hook;
mod lsl_service;
mod runtime;
mod settings;
mod study_runtime;

use commands::{apply_overlay_editing, apply_overlay_visibility, show_settings};
use runtime::Runtime;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(app, "settings", "Open settings", true, None::<&str>)?;
    let overlay_item =
        MenuItem::with_id(app, "overlay", "Show or hide overlay", true, None::<&str>)?;
    let edit_item = MenuItem::with_id(
        app,
        "edit",
        "Toggle overlay dragging (lock or unlock)",
        true,
        None::<&str>,
    )?;
    let reset_item = MenuItem::with_id(app, "reset", "Reset to neutral", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &overlay_item,
            &edit_item,
            &reset_item,
            &quit_item,
        ],
    )?;

    let mut tray = TrayIconBuilder::new();
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.tooltip("Affect Tracker Desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let Some(runtime) = app.try_state::<Arc<Runtime>>() else {
                return;
            };
            match event.id.as_ref() {
                "settings" => show_settings(app),
                "overlay" => {
                    let _ = apply_overlay_visibility(app, &runtime, !runtime.overlay_visible());
                }
                "edit" => {
                    let _ = apply_overlay_editing(app, &runtime, !runtime.overlay_editing());
                }
                "reset" => runtime.reset("tray"),
                "quit" => {
                    runtime.begin_quit();
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let saved_settings = settings::load(&settings_path);
            let runtime = Runtime::new(saved_settings.clone(), settings_path);
            app.manage(Arc::clone(&runtime));
            let study_assets_dir = app.path().app_data_dir()?.join("study-assets");
            let asset_vault = asset_vault::AssetVault::open(study_assets_dir)
                .map_err(|error| std::io::Error::other(error.message))?;
            app.manage(Arc::clone(&asset_vault));
            let study_records_dir = app.path().app_data_dir()?.join("study-records");
            let study_runtime =
                study_runtime::StudyRuntime::new(study_records_dir, Arc::clone(&asset_vault));
            app.manage(Arc::clone(&study_runtime));

            let overlay =
                WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
                    .title("Affect Tracker Overlay")
                    .inner_size(
                        saved_settings.overlay.size as f64,
                        saved_settings.overlay.size as f64,
                    )
                    .position(
                        saved_settings.overlay.x as f64,
                        saved_settings.overlay.y as f64,
                    )
                    .transparent(true)
                    .decorations(false)
                    .shadow(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .visible(saved_settings.overlay.visible)
                    .build()?;
            overlay.set_ignore_cursor_events(true)?;

            input_hook::start(app.handle().clone(), Arc::clone(&runtime))
                .map_err(std::io::Error::other)?;
            build_tray(app)?;
            runtime.start_background(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(runtime) = window.try_state::<Arc<Runtime>>() else {
                return;
            };
            match event {
                WindowEvent::CloseRequested { .. }
                    if window.label() == "settings" && !runtime.is_quitting() =>
                {
                    runtime.begin_quit();
                    window.app_handle().exit(0);
                }
                WindowEvent::Moved(position) if window.label() == "overlay" => {
                    runtime.update_overlay_position(position.x, position.y);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_study_studio,
            commands::validate_study_json,
            commands::publish_study_json,
            commands::prepare_study_run,
            commands::get_study_run_state,
            commands::apply_study_action,
            commands::import_study_asset,
            commands::list_study_assets,
            commands::remove_study_asset,
            commands::get_settings,
            commands::save_settings,
            commands::get_snapshot,
            commands::nudge_action,
            commands::reset_affect,
            commands::set_affect_target,
            commands::set_traversal_mode,
            commands::traverse_affect_matrix,
            commands::stop_matrix_traversal,
            commands::toggle_pause,
            commands::set_overlay_visible,
            commands::set_overlay_editing,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Affect Tracker Desktop");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Some(runtime) = app.try_state::<Arc<Runtime>>() {
                runtime.begin_quit();
            }
        }
    });
}
