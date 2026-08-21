use crate::domain::{Action, AffectEngine, AffectSnapshot, FeatureAction, SnapshotContext};
use crate::error::CommandError;
use crate::lsl_service::LslService;
use crate::settings::{self, Settings};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MARKER_CAPACITY: usize = 1_024;

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

    pub fn push_input_marker(&self, device: &str, event: &str, control: &str, value: &str) {
        self.push_marker(&format!("input:{device}:{event}:{control}:{value}"));
    }

    fn drain_markers(&self) -> Vec<String> {
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
