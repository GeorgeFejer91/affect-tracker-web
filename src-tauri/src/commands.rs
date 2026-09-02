use crate::domain::{
    Action, AffectMatrixCell, AffectSnapshot, AffectTraversalMode, MAX_MATRIX_STEPS_PER_SECOND,
    MIN_MATRIX_STEPS_PER_SECOND,
};
use crate::error::CommandError;
use crate::runtime::Runtime;
use crate::settings::Settings;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

fn settings_window_only(window: &WebviewWindow) -> Result<(), CommandError> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err(CommandError::forbidden())
    }
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
pub fn set_affect_target(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    x: f32,
    y: f32,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.set_target(x, y, "feature-space");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn set_traversal_mode(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    mode: AffectTraversalMode,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.set_traversal_mode(mode, "panel");
    Ok(state.snapshot())
}

#[tauri::command]
pub fn traverse_affect_matrix(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
    column: u8,
    row: u8,
    steps_per_second: f32,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    let Some(target) = AffectMatrixCell::new(column, row) else {
        return Err(CommandError::new(
            "invalid_matrix_cell",
            "Matrix column and row must each be between 0 and 10.",
        ));
    };
    if !steps_per_second.is_finite()
        || !(MIN_MATRIX_STEPS_PER_SECOND..=MAX_MATRIX_STEPS_PER_SECOND).contains(&steps_per_second)
    {
        return Err(CommandError::new(
            "invalid_matrix_rate",
            "Matrix traversal rate must be between 0.5 and 10 states per second.",
        ));
    }
    if !state.traverse_matrix(target, steps_per_second, "panel") {
        return Err(CommandError::new(
            "invalid_matrix_rate",
            "Matrix traversal rate must be finite and in the supported range.",
        ));
    }
    Ok(state.snapshot())
}

#[tauri::command]
pub fn stop_matrix_traversal(
    window: WebviewWindow,
    state: State<'_, Arc<Runtime>>,
) -> Result<AffectSnapshot, CommandError> {
    settings_window_only(&window)?;
    state.stop_matrix_traversal("panel");
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
