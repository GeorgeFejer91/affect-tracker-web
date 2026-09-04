mod research_commands;
mod research_contracts;
mod research_error;
mod research_input;
mod research_lsl;
mod research_native_media;
mod research_runtime;
mod research_timing;
mod research_workspace;

use research_input::ResearchInputService;
use research_native_media::NativeMediaService;
use research_runtime::ResearchRuntime;
use research_workspace::WorkspaceService;
use std::sync::Arc;
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .register_uri_scheme_protocol("research-media", |context, request| {
            if let Some(workspace) = context.app_handle().try_state::<Arc<WorkspaceService>>() {
                workspace.protocol_response(context.webview_label(), request)
            } else {
                let mut response = tauri::http::Response::new(Vec::new());
                *response.status_mut() = tauri::http::StatusCode::SERVICE_UNAVAILABLE;
                response
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let workspace = Arc::new(
                WorkspaceService::new(app_data_dir)
                    .map_err(|error| std::io::Error::other(error.message))?,
            );
            let resource_dir = app.path().resource_dir()?;
            let native_media = Arc::new(NativeMediaService::inspect(&resource_dir));
            // Setup remains operable when the safe hook cannot start. Capability
            // reporting and every test/Start command then fail closed.
            let input = Arc::new(
                ResearchInputService::start()
                    .unwrap_or_else(|_| ResearchInputService::unavailable()),
            );
            let focused = app
                .get_webview_window("research")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            input.set_window_focused(focused);
            let runtime = Arc::new(ResearchRuntime::with_services(
                Arc::clone(&workspace),
                Arc::clone(&native_media),
                Arc::clone(&input),
            ));
            app.manage(workspace);
            app.manage(native_media);
            app.manage(input);
            app.manage(runtime);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "research" {
                if let Some(input) = window.try_state::<Arc<ResearchInputService>>() {
                    match event {
                        WindowEvent::Moved(_) => {
                            if let Ok(position) = window.inner_position() {
                                input.rebase_window_origin(
                                    f64::from(position.x),
                                    f64::from(position.y),
                                );
                            } else {
                                input.clear_regions_after_layout_change();
                            }
                        }
                        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                            input.clear_regions_after_layout_change();
                        }
                        WindowEvent::Focused(focused) => input.set_window_focused(*focused),
                        WindowEvent::Destroyed => input.shutdown(),
                        _ => {}
                    }
                }
                if matches!(event, WindowEvent::Destroyed) {
                    if let Some(runtime) = window.try_state::<Arc<ResearchRuntime>>() {
                        runtime.shutdown();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            research_commands::research_source_capabilities,
            research_commands::research_native_media_capability,
            research_commands::research_input_capability,
            research_commands::research_input_set_region,
            research_commands::research_input_begin_test,
            research_commands::research_input_begin_capture,
            research_commands::research_input_status,
            research_commands::research_input_cancel_setup,
            research_commands::research_choose_workspace,
            research_commands::research_workspace_status,
            research_commands::research_load_settings,
            research_commands::research_rescan_stimuli,
            research_commands::research_import_stimuli,
            research_commands::research_workspace_media_url,
            research_commands::research_attest_workspace_decode,
            research_commands::research_save_settings,
            research_commands::research_storage_readiness,
            research_commands::research_export_assignment_plan,
            research_commands::research_lsl_readiness,
            research_commands::research_start_run,
            research_commands::research_resume_run,
            research_commands::research_finalize_recovery,
            research_commands::research_run_status,
            research_commands::research_set_stimulus_state,
            research_commands::research_finish_run,
            research_commands::research_report_media_failure,
            research_commands::research_recoveries,
            research_commands::research_participant_states,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Affect Research");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Some(runtime) = app.try_state::<Arc<ResearchRuntime>>() {
                runtime.shutdown();
            }
            if let Some(input) = app.try_state::<Arc<ResearchInputService>>() {
                input.shutdown();
            }
        }
    });
}
