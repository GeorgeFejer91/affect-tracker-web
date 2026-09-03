use crate::asset_vault::{
    AssetVault, ImportStudyAssetOutcomeV1, ImportStudyAssetRequestV1, RemoveStudyAssetOutcomeV1,
    StudyAssetCatalogV1,
};
use crate::domain::{
    Action, AffectMatrixCell, AffectSnapshot, AffectTraversalMode, MAX_MATRIX_STEPS_PER_SECOND,
    MIN_MATRIX_STEPS_PER_SECOND,
};
use crate::error::CommandError;
use crate::runtime::Runtime;
use crate::settings::Settings;
use crate::study_runtime::{StudyRuntime, StudyValidationV1};
use affect_tracker_study_core::{
    ReducerOutcomeV1, RunConfigurationV1, RunStateV1, StudyActionV1, StudyDefinitionV1,
};
use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

fn settings_window_only(window: &WebviewWindow) -> Result<(), CommandError> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err(CommandError::forbidden())
    }
}

fn study_window_label_only(label: &str) -> Result<(), CommandError> {
    if label == "study" {
        Ok(())
    } else {
        Err(CommandError::new(
            "forbidden_window",
            "This operation is available only in the Study Studio window.",
        ))
    }
}

fn study_window_only(window: &WebviewWindow) -> Result<(), CommandError> {
    study_window_label_only(window.label())
}

async fn run_study_operation<T, F>(operation: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| {
            CommandError::new(
                "study_runtime_failure",
                "The native study authority operation did not complete.",
            )
        })?
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
pub fn open_study_studio(app: AppHandle, window: WebviewWindow) -> Result<(), CommandError> {
    settings_window_only(&window)?;
    if let Some(study) = app.get_webview_window("study") {
        study.unminimize().map_err(|_| {
            CommandError::new("study_window", "Study Studio could not be restored.")
        })?;
        study
            .show()
            .map_err(|_| CommandError::new("study_window", "Study Studio could not be shown."))?;
        study.set_focus().map_err(|_| {
            CommandError::new("study_window", "Study Studio could not receive focus.")
        })?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "study", WebviewUrl::App("study.html".into()))
        .title("Affect Tracker Study Studio")
        .inner_size(1180.0, 820.0)
        .min_inner_size(720.0, 620.0)
        .center()
        .build()
        .map_err(|_| CommandError::new("study_window", "Study Studio could not be opened."))?;
    Ok(())
}

#[tauri::command]
pub async fn validate_study_json(
    window: WebviewWindow,
    state: State<'_, Arc<StudyRuntime>>,
    study_json: String,
) -> Result<StudyValidationV1, CommandError> {
    study_window_only(&window)?;
    let runtime = Arc::clone(state.inner());
    run_study_operation(move || runtime.validate_study_json(&study_json)).await
}

#[tauri::command]
pub async fn publish_study_json(
    window: WebviewWindow,
    state: State<'_, Arc<StudyRuntime>>,
    study_json: String,
) -> Result<StudyDefinitionV1, CommandError> {
    study_window_only(&window)?;
    let runtime = Arc::clone(state.inner());
    run_study_operation(move || runtime.publish_study_json(&study_json)).await
}

#[tauri::command]
pub async fn prepare_study_run(
    window: WebviewWindow,
    state: State<'_, Arc<StudyRuntime>>,
    study_id: String,
    study_revision: u32,
    configuration: RunConfigurationV1,
    authority_generation: Option<u64>,
) -> Result<RunStateV1, CommandError> {
    study_window_only(&window)?;
    let runtime = Arc::clone(state.inner());
    run_study_operation(move || {
        runtime.prepare_run(
            &study_id,
            study_revision,
            configuration,
            authority_generation,
        )
    })
    .await
}

#[tauri::command]
pub async fn get_study_run_state(
    window: WebviewWindow,
    state: State<'_, Arc<StudyRuntime>>,
) -> Result<RunStateV1, CommandError> {
    study_window_only(&window)?;
    let runtime = Arc::clone(state.inner());
    run_study_operation(move || runtime.state()).await
}

#[tauri::command]
pub async fn apply_study_action(
    window: WebviewWindow,
    study_state: State<'_, Arc<StudyRuntime>>,
    runtime_state: State<'_, Arc<Runtime>>,
    action: StudyActionV1,
) -> Result<ReducerOutcomeV1, CommandError> {
    study_window_only(&window)?;
    let study_runtime = Arc::clone(study_state.inner());
    let runtime = Arc::clone(runtime_state.inner());
    let outcome = run_study_operation(move || study_runtime.apply(action)).await;
    publish_successful_study_outcome(&runtime, outcome)
}

fn publish_successful_study_outcome(
    runtime: &Runtime,
    outcome: Result<ReducerOutcomeV1, CommandError>,
) -> Result<ReducerOutcomeV1, CommandError> {
    let outcome = outcome?;
    runtime.publish_study_lifecycle_markers(&outcome.events);
    Ok(outcome)
}

#[tauri::command]
pub async fn import_study_asset(
    window: WebviewWindow,
    state: State<'_, Arc<AssetVault>>,
    request: ImportStudyAssetRequestV1,
) -> Result<ImportStudyAssetOutcomeV1, CommandError> {
    study_window_only(&window)?;
    let vault = Arc::clone(state.inner());
    run_study_operation(move || vault.import(request)).await
}

#[tauri::command]
pub fn list_study_assets(
    window: WebviewWindow,
    state: State<'_, Arc<AssetVault>>,
) -> Result<StudyAssetCatalogV1, CommandError> {
    study_window_only(&window)?;
    Ok(state.catalog())
}

#[tauri::command]
pub async fn remove_study_asset(
    window: WebviewWindow,
    state: State<'_, Arc<AssetVault>>,
    asset_id: String,
) -> Result<RemoveStudyAssetOutcomeV1, CommandError> {
    study_window_only(&window)?;
    let vault = Arc::clone(state.inner());
    run_study_operation(move || vault.remove(&asset_id)).await
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

#[cfg(test)]
mod tests {
    use super::{publish_successful_study_outcome, study_window_label_only};
    use crate::error::CommandError;
    use crate::runtime::Runtime;
    use crate::settings::Settings;
    use std::path::PathBuf;

    #[test]
    fn native_study_authority_is_restricted_to_the_study_window() {
        study_window_label_only("study").unwrap();
        assert_eq!(
            study_window_label_only("settings").unwrap_err().code,
            "forbidden_window"
        );
        assert_eq!(
            study_window_label_only("overlay").unwrap_err().code,
            "forbidden_window"
        );
    }

    #[test]
    fn failed_study_apply_does_not_enqueue_lsl_side_effects() {
        let runtime = Runtime::new(Settings::default(), PathBuf::from("unused-settings.json"));
        let error = publish_successful_study_outcome(
            &runtime,
            Err(CommandError::new(
                "invalid_study_transition",
                "The reducer rejected this action.",
            )),
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_study_transition");
        assert!(runtime.drain_markers().is_empty());
    }
}
