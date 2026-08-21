mod commands;
mod domain;
mod error;
mod lsl_service;
mod runtime;
mod settings;

use commands::{
    apply_overlay_editing, apply_overlay_visibility, register_shortcuts, show_settings,
};
use domain::Action;
use runtime::Runtime;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(app, "settings", "Open settings", true, None::<&str>)?;
    let overlay_item =
        MenuItem::with_id(app, "overlay", "Show or hide overlay", true, None::<&str>)?;
    let edit_item = MenuItem::with_id(app, "edit", "Edit or lock overlay", true, None::<&str>)?;
    let reset_item = MenuItem::with_id(app, "reset", "Reset to neutral", true, None::<&str>)?;
    let lsl_item = MenuItem::with_id(app, "lsl", "Start or stop LSL", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &settings_item,
            &overlay_item,
            &edit_item,
            &reset_item,
            &lsl_item,
            &quit_item,
        ],
    )?;

    TrayIconBuilder::new()
        .tooltip("Affect Tracker Desktop")
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
                "lsl" => runtime.set_lsl_requested(!runtime.lsl_requested()),
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

fn handle_shortcut(app: &tauri::AppHandle, runtime: &Runtime, action: Action, pressed: bool) {
    if action.is_directional() {
        runtime.handle_direction(action, pressed, "shortcut");
        return;
    }
    if !pressed {
        return;
    }
    match action {
        Action::Reset => runtime.reset("shortcut"),
        Action::TogglePause => runtime.toggle_pause("shortcut"),
        Action::ShowSettings => show_settings(app),
        Action::ToggleOverlayEditing => {
            let _ = apply_overlay_editing(app, runtime, !runtime.overlay_editing());
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let Some(runtime) = app.try_state::<Arc<Runtime>>() else {
                        return;
                    };
                    if let Some(action) = runtime.action_for_shortcut(shortcut) {
                        handle_shortcut(
                            app,
                            &runtime,
                            action,
                            event.state() == ShortcutState::Pressed,
                        );
                    }
                })
                .build(),
        )
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let saved_settings = settings::load(&settings_path);
            let runtime = Runtime::new(saved_settings.clone(), settings_path);
            app.manage(Arc::clone(&runtime));

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
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .resizable(false)
                    .visible(saved_settings.overlay.visible)
                    .build()?;
            overlay.set_ignore_cursor_events(true)?;

            register_shortcuts(app.handle(), &runtime, &saved_settings)
                .map_err(|error| std::io::Error::other(error.message))?;
            build_tray(app)?;
            runtime.start_background(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(runtime) = window.try_state::<Arc<Runtime>>() else {
                return;
            };
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if window.label() == "settings" && !runtime.is_quitting() =>
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                WindowEvent::Moved(position) if window.label() == "overlay" => {
                    runtime.update_overlay_position(position.x, position.y);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_snapshot,
            commands::nudge_action,
            commands::reset_affect,
            commands::toggle_pause,
            commands::set_lsl_enabled,
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
