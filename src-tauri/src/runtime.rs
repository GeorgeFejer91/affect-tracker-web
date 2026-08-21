use crate::domain::{Action, AffectEngine, AffectSnapshot};
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
use tauri_plugin_global_shortcut::Shortcut;

const MARKER_CAPACITY: usize = 1_024;

#[derive(Debug, Clone)]
struct LslStatus {
    state: &'static str,
    message: String,
}

impl Default for LslStatus {
    fn default() -> Self {
        Self {
            state: "stopped",
            message: "LSL stopped".into(),
        }
    }
}

pub struct Runtime {
    engine: Mutex<AffectEngine>,
    settings: RwLock<Settings>,
    shortcuts: RwLock<Vec<(Shortcut, Action)>>,
    markers: Mutex<VecDeque<String>>,
    lsl_requested: AtomicBool,
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
        let start_lsl = settings.lsl.start_enabled;
        let overlay_visible = settings.overlay.visible;
        Arc::new(Self {
            engine: Mutex::new(AffectEngine::new(
                settings.input_mode,
                settings.step_size,
                settings.continuous_speed,
                settings.response,
            )),
            settings: RwLock::new(settings),
            shortcuts: RwLock::new(Vec::new()),
            markers: Mutex::new(VecDeque::with_capacity(MARKER_CAPACITY)),
            lsl_requested: AtomicBool::new(start_lsl),
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

    pub fn set_shortcuts(&self, shortcuts: Vec<(Shortcut, Action)>) {
        *self
            .shortcuts
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = shortcuts;
    }

    pub fn action_for_shortcut(&self, shortcut: &Shortcut) -> Option<Action> {
        self.shortcuts
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find_map(|(candidate, action)| (candidate == shortcut).then_some(*action))
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
        let opacity = self
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .overlay
            .opacity;
        self.engine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .snapshot(
                self.overlay_visible.load(Ordering::Relaxed),
                self.overlay_editing.load(Ordering::Relaxed),
                opacity,
                status.state,
                &status.message,
            )
    }

    pub fn set_lsl_requested(&self, enabled: bool) {
        self.lsl_requested.store(enabled, Ordering::Relaxed);
        self.lsl_revision.fetch_add(1, Ordering::Relaxed);
        self.push_marker(if enabled {
            "system:lsl_start_requested"
        } else {
            "system:lsl_stop_requested"
        });
    }

    pub fn lsl_requested(&self) -> bool {
        self.lsl_requested.load(Ordering::Relaxed)
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
                let requested = runtime.lsl_requested();
                if !requested {
                    if lsl_service.take().is_some() {
                        runtime.set_lsl_status("stopped", "LSL stopped");
                    }
                    active_revision = revision;
                } else if active_revision != revision
                    || (lsl_service.is_none() && now >= next_lsl_retry)
                {
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
                if requested && lsl_accumulator >= sample_interval {
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
