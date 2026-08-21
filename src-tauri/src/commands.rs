use crate::domain::{Action, AffectSnapshot};
use crate::error::CommandError;
use crate::runtime::Runtime;
use crate::settings::Settings;
use std::str::FromStr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

fn settings_window_only(window: &WebviewWindow) -> Result<(), CommandError> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err(CommandError::forbidden())
    }
}

pub fn parse_shortcuts(settings: &Settings) -> Result<Vec<(Shortcut, Action)>, CommandError> {
    settings.validate()?;
    settings
        .bindings
        .iter()
        .map(|(action, value)| {
            Shortcut::from_str(value)
                .map(|shortcut| (shortcut, *action))
                .map_err(|_| {
                    CommandError::new(
                        "invalid_shortcut",
                        format!("‘{value}’ is not a valid global shortcut."),
                    )
                })
        })
        .collect()
}

pub fn register_shortcuts(
    app: &AppHandle,
    runtime: &Runtime,
    settings: &Settings,
) -> Result<(), CommandError> {
    let parsed = parse_shortcuts(settings)?;
    app.global_shortcut().unregister_all().map_err(|_| {
        CommandError::new(
            "shortcut_unregister",
            "Existing global shortcuts could not be released.",
        )
    })?;
    for (shortcut, _) in &parsed {
        if app.global_shortcut().register(shortcut.clone()).is_err() {
            let _ = app.global_shortcut().unregister_all();
            return Err(CommandError::new(
                "shortcut_registration",
                format!("The shortcut ‘{shortcut}’ is unavailable. Another application may already use it."),
            ));
        }
    }
    runtime.set_shortcuts(parsed);
    Ok(())
}

pub fn apply_overlay_geometry(app: &AppHandle, settings: &Settings) -> Result<(), CommandError> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Err(CommandError::new(
            "overlay_missing",
            "The overlay window is not available.",
        ));
    };
    overlay
        .set_size(PhysicalSize::new(
            settings.overlay.size,
            settings.overlay.size,
        ))
        .map_err(|_| CommandError::new("overlay_size", "The overlay could not be resized."))?;
    overlay
        .set_position(PhysicalPosition::new(
            settings.overlay.x,
            settings.overlay.y,
        ))
        .map_err(|_| {
            CommandError::new("overlay_position", "The overlay could not be repositioned.")
        })?;
    Ok(())
}

pub fn apply_overlay_visibility(
    app: &AppHandle,
    runtime: &Runtime,
    visible: bool,
) -> Result<(), CommandError> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Err(CommandError::new(
            "overlay_missing",
            "The overlay window is not available.",
        ));
    };
    if visible {
        overlay
            .show()
            .map_err(|_| CommandError::new("overlay_show", "The overlay could not be shown."))?;
    } else {
        overlay
            .hide()
            .map_err(|_| CommandError::new("overlay_hide", "The overlay could not be hidden."))?;
    }
    runtime.set_overlay_visible(visible);
    Ok(())
}

pub fn apply_overlay_editing(
    app: &AppHandle,
    runtime: &Runtime,
    editing: bool,
) -> Result<(), CommandError> {
    let Some(overlay) = app.get_webview_window("overlay") else {
        return Err(CommandError::new(
            "overlay_missing",
            "The overlay window is not available.",
        ));
    };
    if editing {
        overlay
            .show()
            .map_err(|_| CommandError::new("overlay_show", "The overlay could not be shown."))?;
        runtime.set_overlay_visible(true);
    }
    overlay.set_ignore_cursor_events(!editing).map_err(|_| {
        CommandError::new(
            "overlay_input",
            "The overlay interaction mode could not be changed.",
        )
    })?;
    runtime.set_overlay_editing(editing);
    let _ = app.emit_to("overlay", "affect://overlay-editing", editing);
    Ok(())
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub fn get_settings(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
) -> Result<Settings, CommandError> {
    settings_window_only(&window)?;
    Ok(state.settings())
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    settings: Settings,
) -> Result<Settings, CommandError> {
    settings_window_only(&window)?;
    settings.validate()?;
    let previous = state.settings();
    if let Err(error) = register_shortcuts(&app, &state, &settings) {
        let _ = register_shortcuts(&app, &state, &previous);
        return Err(error);
    }
    apply_overlay_geometry(&app, &settings)?;
    state.replace_settings(settings.clone());
    state.persist_settings()?;
    apply_overlay_visibility(&app, &state, settings.overlay.visible)?;
    Ok(settings)
}

#[tauri::command]
pub fn get_snapshot(state: State<'_, Arc<Runtime>>) -> AffectSnapshot {
    state.snapshot()
}

#[tauri::command]
pub fn nudge_action(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    action: Action,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    if !action.is_directional() {
        return Err(CommandError::new(
            "invalid_action",
            "Only directional actions can be nudged.",
        ));
    }
    state.nudge(action, "panel");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn reset_affect(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.reset("panel");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn toggle_pause(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.toggle_pause("panel");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn set_lsl_enabled(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    enabled: bool,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.set_lsl_requested(enabled);
    Ok(state.snapshot())
}

#[tauri::command]
pub fn set_overlay_visible(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    visible: bool,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    if !visible && state.overlay_editing() {
        apply_overlay_editing(&app, &state, false)?;
    }
    apply_overlay_visibility(&app, &state, visible)?;
    Ok(state.snapshot())
}

#[tauri::command]
pub fn set_overlay_editing(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    editing: bool,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    apply_overlay_editing(&app, &state, editing)?;
    Ok(state.snapshot())
}
