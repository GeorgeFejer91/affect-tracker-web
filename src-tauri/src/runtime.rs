use crate::domain::{
    Action, AffectEngine, AffectMatrixCell, AffectSnapshot, AffectTraversalMode, FeatureAction,
    SnapshotContext,
};
use crate::error::CommandError;
use crate::lsl_service::LslService;
use crate::settings::{self, Settings};
use affect_tracker_study_core::{
    RunEventPayloadV1, RunEventV1, CONTRACT_VERSION_V1, RUN_EVENT_SCHEMA_V1,
};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MARKER_CAPACITY: usize = 1_024;
const STUDY_MARKER_ID_MAX_BYTES: usize = 64;
const STUDY_MARKER_MAX_BYTES: usize = 512;

#[derive(Debug, Clone)]
struct LslStatus {
    state: &'static str,
    message: String,
}

impl Default for LslStatus {
    fn default() -> Self {
        Self {
            state: "starting",
            message: "LSL starting…".into(),
        }
    }
}

pub struct Runtime {
    engine: Mutex<AffectEngine>,
    settings: RwLock<Settings>,
    input_hook: Mutex<Option<monio::Hook>>,
    markers: Mutex<VecDeque<String>>,
    lsl_revision: AtomicU64,
    lsl_status: Mutex<LslStatus>,
    overlay_visible: AtomicBool,
    overlay_editing: AtomicBool,
    quitting: AtomicBool,
    shutdown: AtomicBool,
    settings_path: PathBuf,
}

impl Runtime {
    pub fn new(settings: Settings, settings_path: PathBuf) -> Arc<Self> {
        let overlay_visible = settings.overlay.visible;
        Arc::new(Self {
            engine: Mutex::new(AffectEngine::new(
                settings.input_mode,
                settings.step_size,
                settings.continuous_speed,
                settings.response,
                settings.visual.animation_speed,
            )),
            settings: RwLock::new(settings),
            input_hook: Mutex::new(None),
            markers: Mutex::new(VecDeque::with_capacity(MARKER_CAPACITY)),
            lsl_revision: AtomicU64::new(0),
            lsl_status: Mutex::new(LslStatus::default()),
            overlay_visible: AtomicBool::new(overlay_visible),
            overlay_editing: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            settings_path,
        })
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn replace_settings(&self, value: Settings) {
        {
            let mut engine = self
                .engine
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            engine.configure(
                value.input_mode,
                value.step_size,
                value.continuous_speed,
                value.response,
                value.visual.animation_speed,
            );
        }
        self.overlay_visible
            .store(value.overlay.visible, Ordering::Relaxed);
        *self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = value;
        self.lsl_revision.fetch_add(1, Ordering::Relaxed);
        self.push_marker("system:settings_changed");
    }

    pub fn persist_settings(&self) -> Result<(), CommandError> {
        settings::save(&self.settings_path, &self.settings())
    }

    pub fn update_overlay_position(&self, x: i32, y: i32) {
        {
            let mut value = self
                .settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            value.overlay.x = x;
            value.overlay.y = y;
        }
        let _ = self.persist_settings();
        self.push_marker(&format!("overlay:moved:{x}:{y}"));
    }

    pub fn set_input_hook(&self, hook: monio::Hook) {
        *self
            .input_hook
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(hook);
    }

    pub fn action_for_binding(&self, token: &str) -> Option<Action> {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .bindings
            .iter()
            .find_map(|(action, binding)| binding.eq_ignore_ascii_case(token).then_some(*action))
    }

    pub fn feature_action_for_binding(&self, token: &str) -> Option<FeatureAction> {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .advanced_bindings
            .iter()
            .find_map(|(action, binding)| binding.eq_ignore_ascii_case(token).then_some(*action))
    }

    pub fn adjust_feature(&self, action: FeatureAction, source: &str) {
        let animation_speed = {
            let mut value = self
                .settings
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            value.adjust_feature(action);
            value.visual.animation_speed
        };
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_animation_speed(animation_speed);
        let _ = self.persist_settings();
        self.push_marker(&format!("{source}:advanced:{}", action.marker_name()));
    }

    pub fn handle_direction(&self, action: Action, pressed: bool, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_action(action, pressed);
        self.push_marker(&format!(
            "{source}:{}:{}",
            action.marker_name(),
            if pressed { "pressed" } else { "released" }
        ));
    }

    pub fn nudge(&self, action: Action, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .nudge(action);
        self.push_marker(&format!("{source}:{}:nudge", action.marker_name()));
    }

    pub fn reset(&self, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .reset();
        self.push_marker(&format!("{source}:reset"));
    }

    pub fn set_target(&self, x: f32, y: f32, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_target(x, y);
        self.push_marker(&format!("{source}:set_target:{x:.4}:{y:.4}"));
    }

    pub fn set_traversal_mode(&self, mode: AffectTraversalMode, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .set_traversal_mode(mode);
        let label = match mode {
            AffectTraversalMode::Continuous => "continuous",
            AffectTraversalMode::Matrix => "matrix",
        };
        self.push_marker(&format!("{source}:traversal_mode:{label}"));
    }

    pub fn traverse_matrix(
        &self,
        target: AffectMatrixCell,
        steps_per_second: f32,
        source: &str,
    ) -> bool {
        let started = self
            .engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .start_matrix_traversal(target, steps_per_second);
        if started {
            self.push_marker(&format!(
                "{source}:matrix_target:{}:{}:{steps_per_second:.2}",
                target.column, target.row
            ));
        }
        started
    }

    pub fn stop_matrix_traversal(&self, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .stop_matrix_traversal();
        self.push_marker(&format!("{source}:matrix_stopped"));
    }

    pub fn toggle_pause(&self, source: &str) {
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .toggle_pause();
        self.push_marker(&format!("{source}:toggle_pause"));
    }

    pub fn snapshot(&self) -> AffectSnapshot {
        let status = self
            .lsl_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let settings = self.settings();
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot(SnapshotContext {
                overlay_visible: self.overlay_visible.load(Ordering::Relaxed),
                overlay_editing: self.overlay_editing.load(Ordering::Relaxed),
                overlay_opacity: settings.overlay.opacity,
                overlay_size: settings.overlay.size,
                animation_speed: settings.visual.animation_speed,
                amplitude_scale: settings.visual.amplitude_scale,
                disorder_scale: settings.visual.disorder_scale,
                base_shape: settings.visual.base_shape,
                palette: settings.palette,
                lsl_state: status.state,
                lsl_message: &status.message,
            })
    }

    pub fn set_overlay_visible(&self, visible: bool) {
        self.overlay_visible.store(visible, Ordering::Relaxed);
        self.settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .overlay
            .visible = visible;
        let _ = self.persist_settings();
        self.push_marker(if visible {
            "overlay:shown"
        } else {
            "overlay:hidden"
        });
    }

    pub fn overlay_visible(&self) -> bool {
        self.overlay_visible.load(Ordering::Relaxed)
    }

    pub fn set_overlay_editing(&self, editing: bool) {
        self.overlay_editing.store(editing, Ordering::Relaxed);
        self.push_marker(if editing {
            "overlay:editing_started"
        } else {
            "overlay:editing_finished"
        });
    }

    pub fn overlay_editing(&self) -> bool {
        self.overlay_editing.load(Ordering::Relaxed)
    }

    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::Relaxed);
        self.shutdown.store(true, Ordering::Relaxed);
        self.push_marker("system:session_ended");
        if let Some(hook) = self
            .input_hook
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            let _ = hook.stop();
        }
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::Relaxed)
    }

    fn push_marker(&self, marker: &str) {
        let mut queue = self
            .markers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if queue.len() == MARKER_CAPACITY {
            queue.pop_front();
        }
        queue.push_back(marker.to_owned());
    }

    /// Enqueues only the fixed, non-sensitive study lifecycle projection.
    ///
    /// The reducer's event payload remains authoritative in the durable study
    /// record. This LSL projection deliberately excludes questionnaire answers,
    /// affect values, reason text, health/stall codes, hashes, and other
    /// caller-authored payload strings. Invalid event envelopes or identifiers
    /// fail closed and produce no marker.
    pub fn publish_study_lifecycle_markers(&self, events: &[RunEventV1]) -> usize {
        let markers: Vec<String> = events.iter().filter_map(study_lifecycle_marker).collect();
        let count = markers.len();
        for marker in markers {
            self.push_marker(&marker);
        }
        count
    }

    pub fn push_input_marker(&self, device: &str, event: &str, control: &str, value: &str) {
        self.push_marker(&format!("input:{device}:{event}:{control}:{value}"));
    }

    pub(crate) fn drain_markers(&self) -> Vec<String> {
        self.markers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect()
    }

    fn set_lsl_status(&self, state: &'static str, message: impl Into<String>) {
        *self
            .lsl_status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = LslStatus {
            state,
            message: message.into(),
        };
    }

    pub fn start_background(self: &Arc<Self>, app: AppHandle) {
        let runtime = Arc::clone(self);
        thread::spawn(move || {
            let mut previous = Instant::now();
            let mut emit_accumulator = 0.0_f32;
            let mut lsl_accumulator = 0.0_f32;
            let mut active_revision = u64::MAX;
            let mut lsl_service: Option<LslService> = None;
            let mut next_lsl_retry = Instant::now();
            runtime.push_marker("system:session_started");

            while !runtime.shutdown.load(Ordering::Relaxed) {
                let now = Instant::now();
                let dt = now.duration_since(previous).as_secs_f32().min(0.05);
                previous = now;
                runtime
                    .engine
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .tick(dt);
                emit_accumulator += dt;
                lsl_accumulator += dt;

                let revision = runtime.lsl_revision.load(Ordering::Relaxed);
                if active_revision != revision || (lsl_service.is_none() && now >= next_lsl_retry) {
                    lsl_service = None;
                    runtime.set_lsl_status("starting", "Starting LSL…");
                    let config = runtime.settings();
                    let session_id = runtime.snapshot().session_id;
                    match LslService::start(&config.lsl, &session_id) {
                        Ok(service) => {
                            lsl_service = Some(service);
                            runtime.set_lsl_status(
                                "running",
                                format!("LSL running at {} Hz", config.lsl.sample_rate),
                            );
                        }
                        Err(message) => runtime.set_lsl_status("error", message),
                    }
                    if lsl_service.is_none() {
                        next_lsl_retry = now + Duration::from_secs(5);
                    }
                    active_revision = revision;
                    lsl_accumulator = 0.0;
                }

                let config = runtime.settings();
                let sample_interval = 1.0 / config.lsl.sample_rate as f32;
                if lsl_accumulator >= sample_interval {
                    lsl_accumulator %= sample_interval;
                    if let Some(service) = &lsl_service {
                        let snapshot = runtime.snapshot();
                        if let Err(message) = service.push_state(&snapshot) {
                            runtime.set_lsl_status("error", message);
                            lsl_service = None;
                        }
                    }
                }

                if let Some(service) = &lsl_service {
                    let marker_error = runtime
                        .drain_markers()
                        .into_iter()
                        .find_map(|marker| service.push_marker(&marker).err());
                    if let Some(message) = marker_error {
                        runtime.set_lsl_status("error", message);
                        lsl_service = None;
                        next_lsl_retry = now + Duration::from_secs(5);
                    }
                } else if runtime
                    .markers
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .len()
                    > MARKER_CAPACITY / 2
                {
                    runtime.drain_markers();
                }

                if emit_accumulator >= 1.0 / 30.0 {
                    emit_accumulator %= 1.0 / 30.0;
                    let _ = app.emit("affect://snapshot", runtime.snapshot());
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
    }
}

fn study_lifecycle_marker(event: &RunEventV1) -> Option<String> {
    if event.schema != RUN_EVENT_SCHEMA_V1
        || event.version != CONTRACT_VERSION_V1
        || event.authority_generation == 0
        || event.revision == 0
        || event.sequence == 0
        || !is_study_marker_id(&event.run_id)
        || !event.section_id.as_deref().is_none_or(is_study_marker_id)
        || !event.trial_id.as_deref().is_none_or(is_study_marker_id)
        || !event.block_id.as_deref().is_none_or(is_study_marker_id)
    {
        return None;
    }

    let (event_name, media_position_ms, requires_block) = match &event.payload {
        RunEventPayloadV1::Prepared => ("prepared", None, false),
        RunEventPayloadV1::Armed => ("armed", None, false),
        RunEventPayloadV1::RunStarted => ("started", None, false),
        RunEventPayloadV1::RunPaused { .. } => ("paused", None, false),
        RunEventPayloadV1::RunResumed => ("resumed", None, false),
        RunEventPayloadV1::BlockEntered => ("block_entered", None, true),
        RunEventPayloadV1::BlockCompleted => ("block_completed", None, true),
        RunEventPayloadV1::QuestionnaireSubmitted { .. } => ("questionnaire_submitted", None, true),
        RunEventPayloadV1::MediaTimelineUpdated { anchor } => (
            if anchor.playing {
                "media_playing"
            } else {
                "media_paused"
            },
            Some(anchor.media_position_ms),
            true,
        ),
        RunEventPayloadV1::RunReadyToFinalize => ("ready_to_finalize", None, false),
        RunEventPayloadV1::RunStopped { .. } => ("stopped_early", None, false),
        RunEventPayloadV1::RunFinalized => ("completed", None, false),
        RunEventPayloadV1::RunAborted { .. } => ("aborted", None, false),
        RunEventPayloadV1::SettingsApplied { .. }
        | RunEventPayloadV1::AffectCalibrationSet { .. }
        | RunEventPayloadV1::AffectReset { .. }
        | RunEventPayloadV1::BlockRetried { .. }
        | RunEventPayloadV1::TrialBranchDecided { .. }
        | RunEventPayloadV1::TrialSkipped { .. }
        | RunEventPayloadV1::AffectSampleRecorded { .. }
        | RunEventPayloadV1::HealthUpdated { .. }
        | RunEventPayloadV1::StallReported { .. }
        | RunEventPayloadV1::StallCleared => return None,
    };
    if requires_block && event.block_id.is_none() {
        return None;
    }

    let mut marker = format!(
        "affect-tracker:study:v1:{event_name}:run={}:generation={}:revision={}:sequence={}",
        event.run_id, event.authority_generation, event.revision, event.sequence
    );
    if let Some(section_id) = &event.section_id {
        marker.push_str(":section=");
        marker.push_str(section_id);
    }
    if let Some(trial_id) = &event.trial_id {
        marker.push_str(":trial=");
        marker.push_str(trial_id);
    }
    if let Some(block_id) = &event.block_id {
        marker.push_str(":block=");
        marker.push_str(block_id);
    }
    if let Some(position_ms) = media_position_ms {
        marker.push_str(":position_ms=");
        marker.push_str(&position_ms.to_string());
    }
    (marker.len() <= STUDY_MARKER_MAX_BYTES).then_some(marker)
}

fn is_study_marker_id(value: &str) -> bool {
    if value.is_empty() || value.len() > STUDY_MARKER_ID_MAX_BYTES {
        return false;
    }
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use affect_tracker_study_core::{
        MediaTimelineAnchorV1, QuestionnaireAnswerV1, TrialRunConditionV1,
    };

    fn event(sequence: u64, payload: RunEventPayloadV1) -> RunEventV1 {
        RunEventV1 {
            schema: RUN_EVENT_SCHEMA_V1.to_owned(),
            version: CONTRACT_VERSION_V1,
            sequence,
            authority_generation: 7,
            revision: sequence,
            action_id: format!("action-{sequence}"),
            run_id: "run-1".to_owned(),
            section_id: Some("section-1".to_owned()),
            trial_id: Some("trial-1".to_owned()),
            block_id: Some("block-1".to_owned()),
            monotonic_ms: sequence * 100,
            wall_time_utc: "2026-01-02T03:04:05.000Z".to_owned(),
            payload,
        }
    }

    fn test_runtime() -> Arc<Runtime> {
        Runtime::new(Settings::default(), PathBuf::from("unused-settings.json"))
    }

    #[test]
    fn fixed_study_lifecycle_events_have_structured_markers() {
        let runtime = test_runtime();
        let payloads = vec![
            RunEventPayloadV1::Prepared,
            RunEventPayloadV1::Armed,
            RunEventPayloadV1::RunStarted,
            RunEventPayloadV1::RunPaused {
                reason_code: "researcher-request".to_owned(),
            },
            RunEventPayloadV1::RunResumed,
            RunEventPayloadV1::BlockEntered,
            RunEventPayloadV1::BlockCompleted,
            RunEventPayloadV1::MediaTimelineUpdated {
                anchor: MediaTimelineAnchorV1 {
                    media_position_ms: 250,
                    observed_monotonic_ms: 700,
                    playing: true,
                    playback_rate: 1.0,
                },
            },
            RunEventPayloadV1::MediaTimelineUpdated {
                anchor: MediaTimelineAnchorV1 {
                    media_position_ms: 750,
                    observed_monotonic_ms: 800,
                    playing: false,
                    playback_rate: 1.0,
                },
            },
            RunEventPayloadV1::RunReadyToFinalize,
            RunEventPayloadV1::RunStopped {
                reason_code: "researcher-request".to_owned(),
            },
            RunEventPayloadV1::RunFinalized,
            RunEventPayloadV1::RunAborted {
                reason_code: "researcher-request".to_owned(),
            },
        ];
        let events: Vec<_> = payloads
            .into_iter()
            .enumerate()
            .map(|(index, payload)| event(index as u64 + 1, payload))
            .collect();

        assert_eq!(runtime.publish_study_lifecycle_markers(&events), 13);
        let markers = runtime.drain_markers();
        let event_names: Vec<_> = markers
            .iter()
            .map(|marker| marker.split(':').nth(3).unwrap())
            .collect();
        assert_eq!(
            event_names,
            [
                "prepared",
                "armed",
                "started",
                "paused",
                "resumed",
                "block_entered",
                "block_completed",
                "media_playing",
                "media_paused",
                "ready_to_finalize",
                "stopped_early",
                "completed",
                "aborted",
            ]
        );
        assert_eq!(
            markers[0],
            "affect-tracker:study:v1:prepared:run=run-1:generation=7:revision=1:sequence=1:section=section-1:trial=trial-1:block=block-1"
        );
        assert!(markers[7].ends_with(":position_ms=250"));
        assert!(markers[8].ends_with(":position_ms=750"));
    }

    #[test]
    fn questionnaire_answers_and_arbitrary_payload_text_never_enter_markers() {
        let runtime = test_runtime();
        let events = vec![
            event(
                1,
                RunEventPayloadV1::QuestionnaireSubmitted {
                    questionnaire_id: "secret-questionnaire-id".to_owned(),
                    answers: vec![QuestionnaireAnswerV1::SingleChoice {
                        item_id: "secret-item-id".to_owned(),
                        option_id: "secret-answer-value".to_owned(),
                    }],
                },
            ),
            event(
                2,
                RunEventPayloadV1::RunPaused {
                    reason_code: "secret-pause-reason".to_owned(),
                },
            ),
            event(
                3,
                RunEventPayloadV1::BlockRetried {
                    reason_code: "secret-retry-reason".to_owned(),
                },
            ),
            event(
                4,
                RunEventPayloadV1::TrialBranchDecided {
                    condition: TrialRunConditionV1::Contains {
                        questionnaire_block_id: "source-block".to_owned(),
                        item_id: "source-item".to_owned(),
                        option_id: "secret-condition-value".to_owned(),
                    },
                    observed_answer: QuestionnaireAnswerV1::SingleChoice {
                        item_id: "source-item".to_owned(),
                        option_id: "secret-observed-answer".to_owned(),
                    },
                    eligible: true,
                },
            ),
            event(
                5,
                RunEventPayloadV1::RunAborted {
                    reason_code: "secret-abort-reason".to_owned(),
                },
            ),
        ];

        assert_eq!(runtime.publish_study_lifecycle_markers(&events), 3);
        let markers = runtime.drain_markers();
        assert_eq!(markers.len(), 3);
        assert!(markers[0].contains(":questionnaire_submitted:"));
        assert!(markers[1].contains(":paused:"));
        assert!(markers[2].contains(":aborted:"));
        assert!(!markers.join("|").contains("secret"));
    }

    #[test]
    fn malformed_event_identifiers_fail_closed() {
        let runtime = test_runtime();
        let mut malformed = event(1, RunEventPayloadV1::RunStarted);
        malformed.run_id = "run:payload=leak".to_owned();
        assert_eq!(runtime.publish_study_lifecycle_markers(&[malformed]), 0);
        assert!(runtime.drain_markers().is_empty());
    }
}
