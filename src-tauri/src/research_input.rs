use crate::research_contracts::{
    canonical_sha256, AxisInputTokenV1, DigitalDirectionsV1, DigitalInputTokenV1, DirectionV1,
    InputBindingV1, InputKindV1, InputPresetV1,
};
use crate::research_error::{CommandError, ResearchResult};
use crate::research_gamepad::{GamepadBackend, GamepadInputEvent};
use monio::{Button, Event, EventType, Hook, ScrollDirection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const INPUT_TEST_RECEIPT_TTL: Duration = Duration::from_secs(15 * 60);
const INPUT_SERVICE_SCHEMA: &str = "affect-research-native-input";
const CONTINUOUS_TEST_THRESHOLD: f64 = 0.72;
const GAMEPAD_DEADZONE: f64 = 0.12;
type RunInputSink = Arc<dyn Fn(NativeInputUpdate) + Send + Sync>;
type NativeEventToken = (DigitalInputTokenV1, bool, bool, Option<(f64, f64)>);

/// Single native authority for Setup capture/testing and Run rating input.
/// The WebView may render these receipts but cannot manufacture them.
///
/// All callback and authority transitions use the lock order
/// `dispatch_gate -> state -> run sink`. A run sink must never call back into
/// `ResearchInputService`; it may only hand the update to its downstream mailbox.
pub struct ResearchInputService {
    hook: Option<Hook>,
    gamepad: Option<GamepadBackend>,
    dispatch_gate: Arc<Mutex<()>>,
    state: Arc<Mutex<InputServiceState>>,
    test_backend: bool,
    test_gamepad_backend: bool,
}

#[derive(Debug, Clone)]
pub enum NativeInputUpdate {
    Digital(NativeDigitalInput),
    Continuous(NativeContinuousInput),
    AuthorityLost(NativeInputAuthorityLoss),
}

#[derive(Debug, Clone)]
pub struct NativeDigitalInput {
    pub direction: DirectionV1,
    pub detail: String,
    pub apply_step: bool,
    pub input_active: bool,
    pub impulse: bool,
    pub observed_at: Instant,
}

#[derive(Debug, Clone)]
pub struct NativeContinuousInput {
    pub x: f64,
    pub y: f64,
    pub detail: String,
    pub input_active: bool,
    pub observed_at: Instant,
}

#[derive(Debug, Clone)]
pub struct NativeInputAuthorityLoss {
    pub reason_code: &'static str,
    pub observed_at: Instant,
}

impl NativeInputUpdate {
    fn assert_internal_contract(&self) {
        match self {
            Self::Digital(input) => {
                debug_assert!(!input.detail.is_empty());
            }
            Self::Continuous(input) => {
                debug_assert!(input.x.is_finite() && (-1.0..=1.0).contains(&input.x));
                debug_assert!(input.y.is_finite() && (-1.0..=1.0).contains(&input.y));
                debug_assert!(!input.detail.is_empty());
                let _ = input.input_active;
            }
            Self::AuthorityLost(loss) => {
                debug_assert!(!loss.reason_code.is_empty());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NativeInputPhase {
    Idle,
    Capturing,
    Testing,
    Tested,
    RunPrepared,
    Running,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum InputRegionPurpose {
    SetupTest,
    SetupCapture,
    RunFeedback,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeInputRegionRequest {
    pub purpose: InputRegionPurpose,
    pub layout_epoch: u64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInputCapability {
    pub schema: &'static str,
    pub version: u32,
    pub backend: &'static str,
    pub native_authority_ready: bool,
    pub reason_code: Option<&'static str>,
    pub supported_presets: Vec<InputPresetV1>,
    pub unavailable_presets: Vec<UnavailableInputPreset>,
    pub supports_custom_keyboard: bool,
    pub supports_custom_mouse_buttons: bool,
    pub supports_custom_wheel: bool,
    pub supports_custom_gamepad_buttons: bool,
    pub supports_absolute_pointer: bool,
    pub supports_gamepad: bool,
    pub mouse_and_wheel_require_allow_region: bool,
    pub device_epoch: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableInputPreset {
    pub preset: InputPresetV1,
    pub reason_code: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTestReceipt {
    pub receipt_id: String,
    pub binding_sha256: String,
    pub device_epoch: u64,
    pub issued_at_unix_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCaptureResult {
    pub capture_id: String,
    pub binding_sha256: String,
    pub device_epoch: u64,
    pub direction: DirectionV1,
    pub action: DigitalInputTokenV1,
    pub binding: InputBindingV1,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInputObservation {
    pub sequence: u64,
    pub direction: DirectionV1,
    pub detail: String,
    pub apply_step: bool,
    pub input_active: bool,
    pub impulse: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInputStatus {
    pub schema: &'static str,
    pub version: u32,
    pub phase: NativeInputPhase,
    pub device_epoch: u64,
    pub binding_sha256: Option<String>,
    pub tested_directions: Vec<DirectionV1>,
    pub remaining_directions: Vec<DirectionV1>,
    pub receipt: Option<InputTestReceipt>,
    pub capture: Option<NativeCaptureResult>,
    pub capture_error: Option<String>,
    pub last_input: Option<NativeInputObservation>,
    pub run_ready: bool,
}

#[derive(Clone)]
struct StoredReceipt {
    public: InputTestReceipt,
    issued_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct PhysicalRegion {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    layout_epoch: u64,
}

impl PhysicalRegion {
    fn contains(self, x: f64, y: f64) -> bool {
        x.is_finite()
            && y.is_finite()
            && x >= self.left
            && x <= self.right
            && y >= self.top
            && y <= self.bottom
    }

    fn translate(&mut self, dx: f64, dy: f64) {
        self.left += dx;
        self.right += dx;
        self.top += dy;
        self.bottom += dy;
    }

    fn normalize_clamped(self, x: f64, y: f64) -> (f64, f64) {
        let width = self.right - self.left;
        let height = self.bottom - self.top;
        let normalized_x = ((x - self.left) / width * 2.0 - 1.0).clamp(-1.0, 1.0);
        let normalized_y = (1.0 - (y - self.top) / height * 2.0).clamp(-1.0, 1.0);
        (normalized_x, normalized_y)
    }
}

struct InputServiceState {
    phase: NativeInputPhase,
    device_epoch: u64,
    binding: Option<InputBindingV1>,
    binding_sha256: Option<String>,
    tested_directions: HashSet<DirectionV1>,
    receipt: Option<StoredReceipt>,
    capture_direction: Option<DirectionV1>,
    capture_result: Option<NativeCaptureResult>,
    capture_error: Option<String>,
    regions: HashMap<InputRegionPurpose, PhysicalRegion>,
    window_origin: Option<(f64, f64)>,
    held: HashSet<String>,
    accepted_mouse_holds: HashSet<String>,
    pointer_drag_active: bool,
    active_gamepad: Option<u32>,
    gamepad_axes: [f64; 4],
    last_input: Option<NativeInputObservation>,
    input_sequence: u64,
    last_ordered_observed_at: Option<Instant>,
    run_authority_id: Option<String>,
    run_sink: Option<RunInputSink>,
    window_focused: bool,
    pointer_backend_ready: bool,
    gamepad_backend_ready: bool,
}

impl Default for InputServiceState {
    fn default() -> Self {
        Self {
            phase: NativeInputPhase::Idle,
            device_epoch: 1,
            binding: None,
            binding_sha256: None,
            tested_directions: HashSet::new(),
            receipt: None,
            capture_direction: None,
            capture_result: None,
            capture_error: None,
            regions: HashMap::new(),
            window_origin: None,
            held: HashSet::new(),
            accepted_mouse_holds: HashSet::new(),
            pointer_drag_active: false,
            active_gamepad: None,
            gamepad_axes: [0.0; 4],
            last_input: None,
            input_sequence: 0,
            last_ordered_observed_at: None,
            run_authority_id: None,
            run_sink: None,
            window_focused: false,
            pointer_backend_ready: false,
            gamepad_backend_ready: false,
        }
    }
}

impl ResearchInputService {
    pub fn start() -> ResearchResult<Self> {
        let state = Arc::new(Mutex::new(InputServiceState::default()));
        let dispatch_gate = Arc::new(Mutex::new(()));
        let callback_state = Arc::clone(&state);
        let callback_gate = Arc::clone(&dispatch_gate);
        let hook = Hook::new();
        hook.run_async(move |event: &Event| process_event(&callback_state, &callback_gate, event))
            .map_err(|_| {
                CommandError::new(
                    "native_input_unavailable",
                    "The safe native keyboard and mouse input authority could not start.",
                )
            })?;
        let gamepad_state = Arc::clone(&state);
        let gamepad_gate = Arc::clone(&dispatch_gate);
        let gamepad = GamepadBackend::start(Arc::new(move |event| {
            process_gamepad_event(&gamepad_state, &gamepad_gate, event);
        }))
        .ok();
        {
            let mut service_state = lock(&state);
            service_state.pointer_backend_ready = true;
            service_state.gamepad_backend_ready = gamepad.is_some();
        }
        Ok(Self {
            hook: Some(hook),
            gamepad,
            dispatch_gate,
            state,
            test_backend: false,
            test_gamepad_backend: false,
        })
    }

    pub fn unavailable() -> Self {
        Self {
            hook: None,
            gamepad: None,
            dispatch_gate: Arc::new(Mutex::new(())),
            state: Arc::new(Mutex::new(InputServiceState::default())),
            test_backend: false,
            test_gamepad_backend: false,
        }
    }

    #[cfg(test)]
    pub fn for_tests() -> Self {
        let state = InputServiceState {
            window_focused: true,
            pointer_backend_ready: true,
            gamepad_backend_ready: true,
            ..InputServiceState::default()
        };
        Self {
            hook: None,
            gamepad: None,
            dispatch_gate: Arc::new(Mutex::new(())),
            state: Arc::new(Mutex::new(state)),
            test_backend: true,
            test_gamepad_backend: true,
        }
    }

    fn backend_ready(&self) -> bool {
        self.test_backend || self.hook.as_ref().is_some_and(Hook::is_running)
    }

    fn gamepad_backend_ready(&self) -> bool {
        self.test_gamepad_backend
            || self
                .gamepad
                .as_ref()
                .is_some_and(GamepadBackend::is_running)
    }

    pub fn capability(&self) -> NativeInputCapability {
        let device_epoch = lock(&self.state).device_epoch;
        let pointer_ready = self.backend_ready();
        let gamepad_ready = self.gamepad_backend_ready();
        let native_authority_ready = pointer_ready || gamepad_ready;
        let mut supported_presets = Vec::new();
        let mut unavailable_presets = Vec::new();
        if pointer_ready {
            supported_presets.extend([
                InputPresetV1::ArrowKeys,
                InputPresetV1::Wasd,
                InputPresetV1::Ijkl,
                InputPresetV1::Numpad,
                InputPresetV1::PointerGrid,
                InputPresetV1::MouseButtonsWheel,
            ]);
        } else {
            unavailable_presets.extend([
                UnavailableInputPreset {
                    preset: InputPresetV1::PointerGrid,
                    reason_code: "native-pointer-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::ArrowKeys,
                    reason_code: "native-keyboard-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::Wasd,
                    reason_code: "native-keyboard-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::Ijkl,
                    reason_code: "native-keyboard-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::Numpad,
                    reason_code: "native-keyboard-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::MouseButtonsWheel,
                    reason_code: "native-pointer-backend-unavailable",
                },
            ]);
        }
        if gamepad_ready {
            supported_presets.extend([
                InputPresetV1::GamepadDpad,
                InputPresetV1::GamepadLeftStick,
                InputPresetV1::GamepadRightStick,
            ]);
        } else {
            unavailable_presets.extend([
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadDpad,
                    reason_code: "native-gamepad-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadLeftStick,
                    reason_code: "native-gamepad-backend-unavailable",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadRightStick,
                    reason_code: "native-gamepad-backend-unavailable",
                },
            ]);
        }
        if native_authority_ready {
            supported_presets.push(InputPresetV1::Custom);
        }
        NativeInputCapability {
            schema: INPUT_SERVICE_SCHEMA,
            version: 1,
            backend: match (pointer_ready, gamepad_ready) {
                (true, true) => "monio-listen-only+gilrs-xinput",
                (true, false) => "monio-listen-only",
                (false, true) => "gilrs-xinput",
                (false, false) => "unavailable",
            },
            native_authority_ready,
            reason_code: (!native_authority_ready).then_some("native-input-backends-unavailable"),
            supported_presets,
            unavailable_presets,
            supports_custom_keyboard: pointer_ready,
            supports_custom_mouse_buttons: pointer_ready,
            supports_custom_wheel: pointer_ready,
            supports_custom_gamepad_buttons: gamepad_ready,
            supports_absolute_pointer: pointer_ready,
            supports_gamepad: gamepad_ready,
            mouse_and_wheel_require_allow_region: true,
            device_epoch,
        }
    }

    pub fn set_region(
        &self,
        request: NativeInputRegionRequest,
        window_left: f64,
        window_top: f64,
        client_width_physical: f64,
        client_height_physical: f64,
    ) -> ResearchResult<NativeInputStatus> {
        validate_region_request(&request)?;
        if !window_left.is_finite()
            || !window_top.is_finite()
            || !client_width_physical.is_finite()
            || !client_height_physical.is_finite()
            || client_width_physical <= 0.0
            || client_height_physical <= 0.0
        {
            return Err(CommandError::invalid_contract(
                "The native window geometry is unavailable.",
            ));
        }
        let scale_x = client_width_physical / request.viewport_width;
        let scale_y = client_height_physical / request.viewport_height;
        let region = PhysicalRegion {
            left: window_left + request.left * scale_x,
            top: window_top + request.top * scale_y,
            right: window_left + (request.left + request.width) * scale_x,
            bottom: window_top + (request.top + request.height) * scale_y,
            layout_epoch: request.layout_epoch,
        };
        let _dispatch = lock(&self.dispatch_gate);
        let sink_and_input;
        let status;
        {
            let mut state = lock(&self.state);
            authorize_region_phase(&state, request.purpose)?;
            let changed = state.regions.get(&request.purpose) != Some(&region);
            state.regions.insert(request.purpose, region);
            state.window_origin = Some((window_left, window_top));
            if changed && request.purpose == InputRegionPurpose::SetupTest {
                invalidate_test(&mut state);
                if state.phase == NativeInputPhase::Tested {
                    state.phase = NativeInputPhase::Testing;
                }
            }
            sink_and_input = (changed && request.purpose == InputRegionPurpose::RunFeedback)
                .then(|| quiesce_run_input_locked(&mut state, "native:layout-release"))
                .flatten();
            status = status_from_state(&state);
        }
        if let Some((sink, input)) = sink_and_input {
            dispatch_input(&sink, input);
        }
        Ok(status)
    }

    pub fn rebase_window_origin(&self, window_left: f64, window_top: f64) {
        if !window_left.is_finite() || !window_top.is_finite() {
            return;
        }
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        if let Some((old_left, old_top)) = state.window_origin {
            let dx = window_left - old_left;
            let dy = window_top - old_top;
            for region in state.regions.values_mut() {
                region.translate(dx, dy);
            }
        }
        state.window_origin = Some((window_left, window_top));
    }

    pub fn clear_regions_after_layout_change(&self) {
        let _dispatch = lock(&self.dispatch_gate);
        let sink_and_input;
        {
            let mut state = lock(&self.state);
            state.regions.clear();
            state.window_origin = None;
            if matches!(
                state.phase,
                NativeInputPhase::RunPrepared | NativeInputPhase::Running
            ) {
                sink_and_input = quiesce_run_input_locked(&mut state, "native:layout-release");
            } else {
                clear_held(&mut state);
                sink_and_input = None;
            }
            if matches!(
                state.phase,
                NativeInputPhase::Testing | NativeInputPhase::Tested
            ) {
                invalidate_test(&mut state);
                state.phase = NativeInputPhase::Testing;
            }
        }
        if let Some((sink, input)) = sink_and_input {
            dispatch_input(&sink, input);
        }
    }

    pub fn set_window_focused(&self, focused: bool) {
        let _dispatch = lock(&self.dispatch_gate);
        let sink_and_input;
        {
            let mut state = lock(&self.state);
            state.window_focused = focused;
            if !focused
                && matches!(
                    state.phase,
                    NativeInputPhase::Running | NativeInputPhase::RunPrepared
                )
            {
                sink_and_input = quiesce_run_input_locked(&mut state, "native:focus-release");
            } else {
                sink_and_input = None;
            }
            if !focused
                && !matches!(
                    state.phase,
                    NativeInputPhase::Running | NativeInputPhase::RunPrepared
                )
            {
                clear_held(&mut state);
                state.device_epoch = state.device_epoch.saturating_add(1);
                state.phase = NativeInputPhase::Idle;
                state.binding = None;
                state.binding_sha256 = None;
                state.capture_direction = None;
                state.capture_result = None;
                state.capture_error = None;
                state.active_gamepad = None;
                invalidate_test(&mut state);
            }
        }
        if let Some((sink, input)) = sink_and_input {
            dispatch_input(&sink, input);
        }
    }

    pub fn begin_test(&self, binding: InputBindingV1) -> ResearchResult<NativeInputStatus> {
        let (binding, binding_sha256) = self.normalize_supported_binding(binding)?;
        let uses_gamepad = binding_uses_gamepad(&binding);
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        if matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            return Err(CommandError::run_active());
        }
        if binding_requires_region(&binding)
            && !state.regions.contains_key(&InputRegionPurpose::SetupTest)
        {
            return Err(CommandError::new(
                "native_input_region_required",
                "Register the visible Setup input-test region before testing mouse or wheel input.",
            ));
        }
        state.phase = NativeInputPhase::Testing;
        state.binding = Some(binding);
        state.binding_sha256 = Some(binding_sha256);
        state.capture_direction = None;
        state.capture_result = None;
        state.capture_error = None;
        if uses_gamepad {
            state.active_gamepad = None;
        }
        invalidate_test(&mut state);
        clear_held(&mut state);
        Ok(status_from_state(&state))
    }

    pub fn begin_capture(
        &self,
        binding: InputBindingV1,
        direction: DirectionV1,
    ) -> ResearchResult<NativeInputStatus> {
        let (binding, binding_sha256) = self.normalize_supported_binding(binding)?;
        if binding.kind != InputKindV1::Digital {
            return Err(CommandError::invalid_contract(
                "Native capture accepts one digital action at a time.",
            ));
        }
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        if matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            return Err(CommandError::run_active());
        }
        if !state
            .regions
            .contains_key(&InputRegionPurpose::SetupCapture)
        {
            return Err(CommandError::new(
                "native_input_region_required",
                "Register the visible native capture region before capturing an action.",
            ));
        }
        state.phase = NativeInputPhase::Capturing;
        state.binding = Some(binding);
        state.binding_sha256 = Some(binding_sha256);
        state.capture_direction = Some(direction);
        state.capture_result = None;
        state.capture_error = None;
        state.active_gamepad = None;
        invalidate_test(&mut state);
        clear_held(&mut state);
        Ok(status_from_state(&state))
    }

    pub fn cancel_setup(&self) -> NativeInputStatus {
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        if !matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            state.phase = NativeInputPhase::Idle;
            state.capture_direction = None;
            state.capture_error = None;
            state.active_gamepad = None;
            clear_held(&mut state);
        }
        status_from_state(&state)
    }

    pub fn status(&self) -> NativeInputStatus {
        let mut state = lock(&self.state);
        expire_receipt(&mut state);
        status_from_state(&state)
    }

    #[cfg(test)]
    pub fn prepare_run(
        &self,
        binding: InputBindingV1,
        receipt_id: &str,
        on_input: impl Fn(NativeDigitalInput) + Send + Sync + 'static,
    ) -> ResearchResult<String> {
        if binding.kind != InputKindV1::Digital || binding_uses_gamepad(&binding) {
            return Err(CommandError::new(
                "native_input_preset_unavailable",
                "This caller accepts only keyboard, mouse-button, and wheel input.",
            ));
        }
        self.prepare_run_full(binding, receipt_id, move |input| {
            if let NativeInputUpdate::Digital(input) = input {
                on_input(input);
            }
        })
    }

    pub fn prepare_run_full(
        &self,
        binding: InputBindingV1,
        receipt_id: &str,
        on_input: impl Fn(NativeInputUpdate) + Send + Sync + 'static,
    ) -> ResearchResult<String> {
        let (binding, binding_sha256) = self.normalize_supported_binding(binding)?;
        if Uuid::parse_str(receipt_id).is_err() {
            return Err(CommandError::invalid_contract(
                "The native input-test receipt ID is invalid.",
            ));
        }
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        expire_receipt(&mut state);
        if matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            return Err(CommandError::run_active());
        }
        let receipt = state.receipt.as_ref().ok_or_else(|| {
            CommandError::new(
                "native_input_test_required",
                "Run a fresh native input test before starting or resuming.",
            )
        })?;
        if receipt.public.receipt_id != receipt_id
            || receipt.public.binding_sha256 != binding_sha256
            || receipt.public.device_epoch != state.device_epoch
        {
            return Err(CommandError::new(
                "native_input_test_stale",
                "The native input-test receipt does not match this binding and device epoch.",
            ));
        }
        let authority_id = Uuid::new_v4().to_string();
        state.phase = NativeInputPhase::RunPrepared;
        state.binding = Some(binding);
        state.binding_sha256 = Some(binding_sha256);
        state.receipt = None;
        state.tested_directions.clear();
        state.run_authority_id = Some(authority_id.clone());
        state.run_sink = Some(Arc::new(on_input));
        state.capture_direction = None;
        state.capture_result = None;
        state.capture_error = None;
        state.gamepad_axes = [0.0; 4];
        state.last_ordered_observed_at = None;
        state.last_input = None;
        clear_held(&mut state);
        Ok(authority_id)
    }

    pub fn set_run_accepting(&self, authority_id: &str, accepting: bool) -> ResearchResult<()> {
        let _dispatch = lock(&self.dispatch_gate);
        let sink_and_input;
        {
            let mut state = lock(&self.state);
            validate_run_ready(&state, authority_id, accepting)?;
            if accepting {
                state.phase = NativeInputPhase::Running;
                sink_and_input = None;
            } else {
                // The dispatch gate makes this semantic release the final accepted
                // update before the caller freezes the run lifecycle.
                sink_and_input = quiesce_run_input_locked(&mut state, "native:lifecycle-release");
                state.phase = NativeInputPhase::RunPrepared;
            }
        }
        if let Some((sink, input)) = sink_and_input {
            dispatch_input(&sink, input);
        }
        Ok(())
    }

    pub fn ensure_run_ready(&self, authority_id: &str) -> ResearchResult<()> {
        validate_run_ready(&lock(&self.state), authority_id, true)
    }

    pub fn end_run(&self, authority_id: &str) {
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        if state.run_authority_id.as_deref() != Some(authority_id) {
            return;
        }
        state.phase = NativeInputPhase::Idle;
        state.binding = None;
        state.binding_sha256 = None;
        state.run_authority_id = None;
        state.run_sink = None;
        state.active_gamepad = None;
        state.last_ordered_observed_at = None;
        state.regions.remove(&InputRegionPurpose::RunFeedback);
        clear_held(&mut state);
    }

    pub fn shutdown(&self) {
        {
            let _dispatch = lock(&self.dispatch_gate);
            let mut state = lock(&self.state);
            state.phase = NativeInputPhase::Idle;
            state.run_authority_id = None;
            state.run_sink = None;
            state.active_gamepad = None;
            state.last_ordered_observed_at = None;
            clear_held(&mut state);
        }
        if let Some(hook) = &self.hook {
            if hook.is_running() {
                let _ = hook.stop();
            }
        }
        if let Some(gamepad) = &self.gamepad {
            gamepad.shutdown();
        }
    }

    fn normalize_supported_binding(
        &self,
        binding: InputBindingV1,
    ) -> ResearchResult<(InputBindingV1, String)> {
        normalize_supported_binding(binding, self.backend_ready(), self.gamepad_backend_ready())
    }

    #[cfg(test)]
    pub fn issue_test_receipt_for_tests(
        &self,
        binding: InputBindingV1,
    ) -> ResearchResult<InputTestReceipt> {
        let (binding, binding_sha256) = self.normalize_supported_binding(binding)?;
        let _dispatch = lock(&self.dispatch_gate);
        let mut state = lock(&self.state);
        state.binding = Some(binding);
        state.binding_sha256 = Some(binding_sha256.clone());
        state.tested_directions = all_directions().into_iter().collect();
        let receipt = new_receipt(binding_sha256, state.device_epoch);
        state.receipt = Some(receipt.clone());
        state.phase = NativeInputPhase::Tested;
        Ok(receipt.public)
    }
}

impl Drop for ResearchInputService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate_region_request(request: &NativeInputRegionRequest) -> ResearchResult<()> {
    let values = [
        request.left,
        request.top,
        request.width,
        request.height,
        request.viewport_width,
        request.viewport_height,
    ];
    if values.iter().any(|value| !value.is_finite())
        || request.layout_epoch == 0
        || request.left < 0.0
        || request.top < 0.0
        || request.width < 8.0
        || request.height < 8.0
        || request.viewport_width < 64.0
        || request.viewport_height < 64.0
        || request.left + request.width > request.viewport_width + 0.5
        || request.top + request.height > request.viewport_height + 0.5
    {
        return Err(CommandError::invalid_contract(
            "The native input allow-region must be a visible bounded client rectangle.",
        ));
    }
    Ok(())
}

fn authorize_region_phase(
    state: &InputServiceState,
    purpose: InputRegionPurpose,
) -> ResearchResult<()> {
    let authorized = match purpose {
        InputRegionPurpose::SetupTest | InputRegionPurpose::SetupCapture => !matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ),
        InputRegionPurpose::RunFeedback => matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ),
    };
    if authorized {
        Ok(())
    } else {
        Err(CommandError::forbidden(
            "That native input region is not valid in the current input phase.",
        ))
    }
}

fn validate_run_ready(
    state: &InputServiceState,
    authority_id: &str,
    accepting: bool,
) -> ResearchResult<()> {
    if state.run_authority_id.as_deref() != Some(authority_id) {
        return Err(CommandError::forbidden(
            "The native input authority does not match the active run.",
        ));
    }
    if accepting {
        let binding = state.binding.as_ref().ok_or_else(|| {
            CommandError::new(
                "native_input_unavailable",
                "The frozen run binding is missing.",
            )
        })?;
        if binding_requires_region(binding)
            && !state.regions.contains_key(&InputRegionPurpose::RunFeedback)
        {
            return Err(CommandError::new(
                "native_input_region_required",
                "Register the visible Run feedback-stage region before playback.",
            ));
        }
    }
    Ok(())
}

fn normalize_supported_binding(
    mut binding: InputBindingV1,
    pointer_backend_ready: bool,
    gamepad_backend_ready: bool,
) -> ResearchResult<(InputBindingV1, String)> {
    binding.normalize_and_validate()?;
    let contains_pointer_input = binding.kind == InputKindV1::Absolute
        || binding.directions.as_ref().is_some_and(|directions| {
            direction_tokens(directions).into_iter().any(|token| {
                matches!(
                    token,
                    DigitalInputTokenV1::Keyboard { .. }
                        | DigitalInputTokenV1::MouseButton { .. }
                        | DigitalInputTokenV1::Wheel { .. }
                )
            })
        });
    let contains_gamepad = binding.kind == InputKindV1::Analog
        || binding.directions.as_ref().is_some_and(|directions| {
            direction_tokens(directions)
                .into_iter()
                .any(|token| matches!(token, DigitalInputTokenV1::GamepadButton { .. }))
        });
    if (contains_pointer_input && !pointer_backend_ready)
        || (contains_gamepad && !gamepad_backend_ready)
    {
        return Err(CommandError::new(
            "native_input_preset_unavailable",
            "This input preset has no safe native authority in the current Tauri build.",
        ));
    }
    let binding_sha256 = canonical_sha256(&binding, &[])?;
    Ok((binding, binding_sha256))
}

fn binding_requires_region(binding: &InputBindingV1) -> bool {
    binding.kind == InputKindV1::Absolute
        || binding.directions.as_ref().is_some_and(|directions| {
            direction_tokens(directions).into_iter().any(|token| {
                matches!(
                    token,
                    DigitalInputTokenV1::MouseButton { .. } | DigitalInputTokenV1::Wheel { .. }
                )
            })
        })
}

fn binding_uses_gamepad(binding: &InputBindingV1) -> bool {
    binding.kind == InputKindV1::Analog
        || binding.directions.as_ref().is_some_and(|directions| {
            direction_tokens(directions)
                .into_iter()
                .any(|token| matches!(token, DigitalInputTokenV1::GamepadButton { .. }))
        })
}

fn direction_tokens(directions: &DigitalDirectionsV1) -> [&DigitalInputTokenV1; 4] {
    [
        &directions.up,
        &directions.down,
        &directions.left,
        &directions.right,
    ]
}

fn all_directions() -> [DirectionV1; 4] {
    [
        DirectionV1::Up,
        DirectionV1::Down,
        DirectionV1::Left,
        DirectionV1::Right,
    ]
}

fn invalidate_test(state: &mut InputServiceState) {
    state.tested_directions.clear();
    state.receipt = None;
}

fn clear_held(state: &mut InputServiceState) {
    state.held.clear();
    state.accepted_mouse_holds.clear();
    state.pointer_drag_active = false;
    state.gamepad_axes = [0.0; 4];
}

/// Called only while the service dispatch gate and state lock are held. Digital
/// signatures deliberately remain held until their physical release arrives,
/// so an OS repeat after pause/refocus cannot become a fresh rating edge.
fn quiesce_run_input_locked(
    state: &mut InputServiceState,
    detail: &'static str,
) -> Option<(RunInputSink, NativeInputUpdate)> {
    let kind = state.binding.as_ref()?.kind;
    let needs_release = state
        .last_input
        .as_ref()
        .is_some_and(|observation| match kind {
            InputKindV1::Digital => observation.input_active || observation.impulse,
            InputKindV1::Absolute | InputKindV1::Analog => {
                observation.input_active
                    || observation.x.is_some_and(|x| x != 0.0)
                    || observation.y.is_some_and(|y| y != 0.0)
            }
        });
    state.pointer_drag_active = false;
    state.gamepad_axes = [0.0; 4];
    if state.phase != NativeInputPhase::Running || !needs_release {
        return None;
    }
    let sink = state.run_sink.clone()?;
    let observed_at = ordered_observed_at(state, Instant::now());
    match kind {
        InputKindV1::Digital => {
            let direction = state
                .last_input
                .as_ref()
                .map(|observation| observation.direction)
                .unwrap_or(DirectionV1::Up);
            state.input_sequence = state.input_sequence.saturating_add(1);
            state.last_input = Some(NativeInputObservation {
                sequence: state.input_sequence,
                direction,
                detail: detail.to_owned(),
                apply_step: false,
                input_active: false,
                impulse: false,
                x: None,
                y: None,
            });
            Some((
                sink,
                NativeInputUpdate::Digital(NativeDigitalInput {
                    direction,
                    detail: detail.to_owned(),
                    apply_step: false,
                    input_active: false,
                    impulse: false,
                    observed_at,
                }),
            ))
        }
        InputKindV1::Absolute | InputKindV1::Analog => {
            // A lifecycle barrier ends physical input authority; it must not
            // alter the participant's rating. Between-stimulus transitions are
            // the only lifecycle operation that resets the rating to neutral.
            let (x, y) = state
                .last_input
                .as_ref()
                .and_then(|observation| Some((observation.x?, observation.y?)))
                .unwrap_or((0.0, 0.0));
            record_continuous(state, x, y, detail, false, observed_at).or_else(|| {
                debug_assert!(false, "a running input authority must retain its sink");
                None
            })
        }
    }
}

fn expire_receipt(state: &mut InputServiceState) {
    if state
        .receipt
        .as_ref()
        .is_some_and(|receipt| receipt.issued_at.elapsed() > INPUT_TEST_RECEIPT_TTL)
    {
        state.receipt = None;
        state.tested_directions.clear();
        if state.phase == NativeInputPhase::Tested {
            state.phase = NativeInputPhase::Testing;
        }
    }
}

fn new_receipt(binding_sha256: String, device_epoch: u64) -> StoredReceipt {
    StoredReceipt {
        public: InputTestReceipt {
            receipt_id: Uuid::new_v4().to_string(),
            binding_sha256,
            device_epoch,
            issued_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        },
        issued_at: Instant::now(),
    }
}

fn status_from_state(state: &InputServiceState) -> NativeInputStatus {
    let tested_directions = all_directions()
        .into_iter()
        .filter(|direction| state.tested_directions.contains(direction))
        .collect::<Vec<_>>();
    let remaining_directions = all_directions()
        .into_iter()
        .filter(|direction| !state.tested_directions.contains(direction))
        .collect::<Vec<_>>();
    let run_ready = state.phase == NativeInputPhase::Running
        || (state.phase == NativeInputPhase::RunPrepared
            && state.binding.as_ref().is_some_and(|binding| {
                !binding_requires_region(binding)
                    || state.regions.contains_key(&InputRegionPurpose::RunFeedback)
            }));
    NativeInputStatus {
        schema: INPUT_SERVICE_SCHEMA,
        version: 1,
        phase: state.phase,
        device_epoch: state.device_epoch,
        binding_sha256: state.binding_sha256.clone(),
        tested_directions,
        remaining_directions,
        receipt: state.receipt.as_ref().map(|receipt| receipt.public.clone()),
        capture: state.capture_result.clone(),
        capture_error: state.capture_error.clone(),
        last_input: state.last_input.clone(),
        run_ready,
    }
}

fn process_event(
    shared: &Arc<Mutex<InputServiceState>>,
    dispatch_gate: &Arc<Mutex<()>>,
    event: &Event,
) {
    let observed_at = Instant::now();
    let _dispatch = lock(dispatch_gate);
    if process_pointer_event(shared, event, observed_at) {
        return;
    }
    let Some((token, pressed, impulse, screen_position)) = event_token(event) else {
        return;
    };
    let signature = token.signature();
    let sink_and_input;
    {
        let mut state = lock(shared);
        if !state.window_focused {
            // Focus loss already published the semantic release. Still observe
            // physical releases so a held signature cannot survive refocus, but
            // never accept an unfocused press or wheel impulse.
            if !pressed && !impulse {
                state.held.remove(&signature);
                state.accepted_mouse_holds.remove(&signature);
            }
            return;
        }
        let mouse_or_wheel = matches!(
            token,
            DigitalInputTokenV1::MouseButton { .. } | DigitalInputTokenV1::Wheel { .. }
        );
        let region_purpose = match state.phase {
            NativeInputPhase::Capturing => Some(InputRegionPurpose::SetupCapture),
            NativeInputPhase::Testing | NativeInputPhase::Tested => {
                Some(InputRegionPurpose::SetupTest)
            }
            NativeInputPhase::RunPrepared | NativeInputPhase::Running => {
                Some(InputRegionPurpose::RunFeedback)
            }
            NativeInputPhase::Idle => None,
        };
        if mouse_or_wheel {
            let release_of_accepted_hold =
                !pressed && state.accepted_mouse_holds.contains(&signature);
            let inside = region_purpose
                .and_then(|purpose| state.regions.get(&purpose).copied())
                .zip(screen_position)
                .is_some_and(|(region, (x, y))| region.contains(x, y));
            if !inside && !release_of_accepted_hold {
                return;
            }
            if pressed && !impulse {
                state.accepted_mouse_holds.insert(signature.clone());
            } else if !pressed {
                state.accepted_mouse_holds.remove(&signature);
            }
        }

        let observed_at = ordered_observed_at(&mut state, observed_at);
        sink_and_input = process_digital_locked(&mut state, token, pressed, impulse, observed_at);
    }
    if let Some((sink, input)) = sink_and_input {
        dispatch_input(&sink, input);
    }
}

/// Called only while the service dispatch gate is held.
fn process_pointer_event(
    shared: &Arc<Mutex<InputServiceState>>,
    event: &Event,
    observed_at: Instant,
) -> bool {
    if !matches!(
        event.event_type,
        EventType::MousePressed
            | EventType::MouseReleased
            | EventType::MouseMoved
            | EventType::MouseDragged
    ) {
        return false;
    }
    let Some(mouse) = event.mouse.as_ref() else {
        return false;
    };
    let sink_and_input;
    {
        let mut state = lock(shared);
        let absolute_pointer = state.binding.as_ref().is_some_and(|binding| {
            binding.kind == InputKindV1::Absolute && binding.preset == InputPresetV1::PointerGrid
        });
        if !absolute_pointer {
            return false;
        }
        if !state.window_focused {
            if matches!(event.event_type, EventType::MouseReleased)
                && mouse.button == Some(Button::Left)
            {
                state.pointer_drag_active = false;
            }
            return true;
        }
        let Some(region) = active_region(&state) else {
            return true;
        };
        let emit = match event.event_type {
            EventType::MousePressed if mouse.button == Some(Button::Left) => {
                if !region.contains(mouse.x, mouse.y) {
                    return true;
                }
                state.pointer_drag_active = true;
                true
            }
            EventType::MouseDragged | EventType::MouseMoved => state.pointer_drag_active,
            EventType::MouseReleased if mouse.button == Some(Button::Left) => {
                if !state.pointer_drag_active {
                    return true;
                }
                state.pointer_drag_active = false;
                true
            }
            _ => false,
        };
        if !emit {
            return true;
        }
        let (x, y) = region.normalize_clamped(mouse.x, mouse.y);
        let input_active = state.pointer_drag_active;
        let observed_at = ordered_observed_at(&mut state, observed_at);
        sink_and_input = record_continuous(
            &mut state,
            x,
            y,
            "pointer:absolute",
            input_active,
            observed_at,
        );
    }
    if let Some((sink, input)) = sink_and_input {
        dispatch_input(&sink, input);
    }
    true
}

fn process_gamepad_event(
    shared: &Arc<Mutex<InputServiceState>>,
    dispatch_gate: &Arc<Mutex<()>>,
    event: GamepadInputEvent,
) {
    let observed_at = Instant::now();
    let _dispatch = lock(dispatch_gate);
    let mut sink_and_input = None;
    {
        let mut state = lock(shared);
        match event {
            GamepadInputEvent::Connected { device: _ } => {
                if state.binding.as_ref().is_some_and(binding_uses_gamepad) {
                    state.device_epoch = state.device_epoch.saturating_add(1);
                    invalidate_test(&mut state);
                }
                return;
            }
            GamepadInputEvent::Disconnected { device } => {
                let binding_uses_device = state.binding.as_ref().is_some_and(binding_uses_gamepad);
                if binding_uses_device {
                    state.device_epoch = state.device_epoch.saturating_add(1);
                    invalidate_test(&mut state);
                }
                if state.active_gamepad == Some(device) {
                    let active_attempt = state.run_authority_id.is_some()
                        && matches!(
                            state.phase,
                            NativeInputPhase::RunPrepared | NativeInputPhase::Running
                        );
                    if !active_attempt {
                        state.active_gamepad = None;
                    }
                    clear_held(&mut state);
                    if binding_uses_device && active_attempt {
                        if let Some(sink) = state.run_sink.clone() {
                            let observed_at = ordered_observed_at(&mut state, observed_at);
                            sink_and_input = Some((
                                sink,
                                NativeInputUpdate::AuthorityLost(NativeInputAuthorityLoss {
                                    reason_code: "native-gamepad-disconnected",
                                    observed_at,
                                }),
                            ));
                        }
                    }
                }
            }
            GamepadInputEvent::Button {
                device,
                button,
                pressed,
            } => {
                let accepts_button = state.phase == NativeInputPhase::Capturing
                    || state.binding.as_ref().is_some_and(binding_uses_gamepad);
                if !state.window_focused {
                    if !pressed && state.active_gamepad == Some(device) {
                        state
                            .held
                            .remove(&DigitalInputTokenV1::GamepadButton { button }.signature());
                    }
                    return;
                }
                if !accepts_button || !claim_gamepad(&mut state, device, pressed) {
                    return;
                }
                let observed_at = ordered_observed_at(&mut state, observed_at);
                sink_and_input = process_digital_locked(
                    &mut state,
                    DigitalInputTokenV1::GamepadButton { button },
                    pressed,
                    false,
                    observed_at,
                );
            }
            GamepadInputEvent::Axis {
                device,
                axis,
                value,
            } => {
                let accepts_analog = state
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.kind == InputKindV1::Analog);
                if !state.window_focused
                    || !accepts_analog
                    || !value.is_finite()
                    || !claim_gamepad(&mut state, device, value.abs() >= 0.2)
                    || usize::from(axis) >= state.gamepad_axes.len()
                {
                    return;
                }
                let Some(axes) = state.binding.as_ref().and_then(|binding| {
                    (binding.kind == InputKindV1::Analog)
                        .then(|| binding.axes.clone())
                        .flatten()
                }) else {
                    return;
                };
                state.gamepad_axes[usize::from(axis)] = if value.abs() < GAMEPAD_DEADZONE {
                    0.0
                } else {
                    value.clamp(-1.0, 1.0)
                };
                let Some(x) = gamepad_axis_value(&state.gamepad_axes, &axes.x) else {
                    return;
                };
                let Some(y) = gamepad_axis_value(&state.gamepad_axes, &axes.y) else {
                    return;
                };
                let observed_at = ordered_observed_at(&mut state, observed_at);
                sink_and_input = record_continuous(
                    &mut state,
                    x,
                    y,
                    "gamepad:analog",
                    x != 0.0 || y != 0.0,
                    observed_at,
                );
            }
        }
    }
    if let Some((sink, input)) = sink_and_input {
        dispatch_input(&sink, input);
    }
}

fn ordered_observed_at(state: &mut InputServiceState, captured_at: Instant) -> Instant {
    let ordered = state
        .last_ordered_observed_at
        .map_or(captured_at, |previous| previous.max(captured_at));
    state.last_ordered_observed_at = Some(ordered);
    ordered
}

fn claim_gamepad(state: &mut InputServiceState, device: u32, active_event: bool) -> bool {
    match state.active_gamepad {
        Some(active) => active == device,
        None if active_event => {
            state.active_gamepad = Some(device);
            true
        }
        None => false,
    }
}

fn gamepad_axis_value(values: &[f64; 4], token: &AxisInputTokenV1) -> Option<f64> {
    let AxisInputTokenV1::GamepadAxis { index, invert } = token else {
        return None;
    };
    let value = *values.get(usize::from(*index))?;
    let projected = if value == 0.0 {
        0.0
    } else if *invert {
        -value
    } else {
        value
    };
    Some(projected.clamp(-1.0, 1.0))
}

fn process_digital_locked(
    state: &mut InputServiceState,
    token: DigitalInputTokenV1,
    pressed: bool,
    impulse: bool,
    observed_at: Instant,
) -> Option<(RunInputSink, NativeInputUpdate)> {
    let signature = token.signature();
    if state.phase == NativeInputPhase::Capturing {
        if !pressed || (!impulse && state.held.contains(&signature)) {
            return None;
        }
        let direction = state.capture_direction?;
        let mut binding = state.binding.clone()?;
        let directions = binding.directions.as_mut()?;
        replace_direction(directions, direction, token.clone());
        binding.preset = InputPresetV1::Custom;
        match normalize_supported_binding(
            binding,
            state.pointer_backend_ready,
            state.gamepad_backend_ready,
        ) {
            Ok((binding, binding_sha256)) => {
                state.capture_result = Some(NativeCaptureResult {
                    capture_id: Uuid::new_v4().to_string(),
                    binding_sha256: binding_sha256.clone(),
                    device_epoch: state.device_epoch,
                    direction,
                    action: token,
                    binding: binding.clone(),
                });
                state.binding = Some(binding);
                state.binding_sha256 = Some(binding_sha256);
                state.capture_direction = None;
                state.capture_error = None;
                state.phase = NativeInputPhase::Idle;
            }
            Err(_) => {
                state.capture_error = Some(
                    "That physical action conflicts with another direction or is unsupported."
                        .to_owned(),
                );
            }
        }
        return None;
    }

    let direction = state
        .binding
        .as_ref()?
        .directions
        .as_ref()?
        .direction_for(&token)?;
    let (apply_step, input_active) = if impulse {
        (true, true)
    } else {
        held_transition(&mut state.held, signature, pressed)?
    };
    state.input_sequence = state.input_sequence.saturating_add(1);
    let input = NativeDigitalInput {
        direction,
        detail: token.detail_code(),
        apply_step,
        input_active,
        impulse,
        observed_at,
    };
    state.last_input = Some(NativeInputObservation {
        sequence: state.input_sequence,
        direction,
        detail: input.detail.clone(),
        apply_step,
        input_active,
        impulse,
        x: None,
        y: None,
    });
    match state.phase {
        NativeInputPhase::Testing | NativeInputPhase::Tested => {
            if apply_step {
                state.tested_directions.insert(direction);
            }
            issue_receipt_when_complete(state);
            None
        }
        NativeInputPhase::Running => state
            .run_sink
            .clone()
            .map(|sink| (sink, NativeInputUpdate::Digital(input))),
        NativeInputPhase::Idle | NativeInputPhase::Capturing | NativeInputPhase::RunPrepared => {
            None
        }
    }
}

fn record_continuous(
    state: &mut InputServiceState,
    x: f64,
    y: f64,
    detail: &str,
    input_active: bool,
    observed_at: Instant,
) -> Option<(RunInputSink, NativeInputUpdate)> {
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    let x = if x == 0.0 { 0.0 } else { x.clamp(-1.0, 1.0) };
    let y = if y == 0.0 { 0.0 } else { y.clamp(-1.0, 1.0) };
    if matches!(
        state.phase,
        NativeInputPhase::Testing | NativeInputPhase::Tested
    ) {
        if x <= -CONTINUOUS_TEST_THRESHOLD {
            state.tested_directions.insert(DirectionV1::Left);
        }
        if x >= CONTINUOUS_TEST_THRESHOLD {
            state.tested_directions.insert(DirectionV1::Right);
        }
        if y <= -CONTINUOUS_TEST_THRESHOLD {
            state.tested_directions.insert(DirectionV1::Down);
        }
        if y >= CONTINUOUS_TEST_THRESHOLD {
            state.tested_directions.insert(DirectionV1::Up);
        }
    }
    state.input_sequence = state.input_sequence.saturating_add(1);
    let direction = primary_direction(x, y);
    state.last_input = Some(NativeInputObservation {
        sequence: state.input_sequence,
        direction,
        detail: detail.to_owned(),
        apply_step: false,
        input_active,
        impulse: false,
        x: Some(x),
        y: Some(y),
    });
    if matches!(
        state.phase,
        NativeInputPhase::Testing | NativeInputPhase::Tested
    ) {
        issue_receipt_when_complete(state);
    }
    let update = NativeInputUpdate::Continuous(NativeContinuousInput {
        x,
        y,
        detail: detail.to_owned(),
        input_active,
        observed_at,
    });
    (state.phase == NativeInputPhase::Running)
        .then(|| state.run_sink.clone().map(|sink| (sink, update)))
        .flatten()
}

fn primary_direction(x: f64, y: f64) -> DirectionV1 {
    if x.abs() > y.abs() {
        if x < 0.0 {
            DirectionV1::Left
        } else {
            DirectionV1::Right
        }
    } else if y < 0.0 {
        DirectionV1::Down
    } else {
        DirectionV1::Up
    }
}

fn issue_receipt_when_complete(state: &mut InputServiceState) {
    if state.tested_directions.len() != 4 || state.receipt.is_some() {
        return;
    }
    if let Some(binding_sha256) = state.binding_sha256.clone() {
        state.receipt = Some(new_receipt(binding_sha256, state.device_epoch));
        state.phase = NativeInputPhase::Tested;
    }
}

fn dispatch_input(sink: &RunInputSink, input: NativeInputUpdate) {
    input.assert_internal_contract();
    sink(input);
}

fn active_region(state: &InputServiceState) -> Option<PhysicalRegion> {
    let purpose = match state.phase {
        NativeInputPhase::Capturing => InputRegionPurpose::SetupCapture,
        NativeInputPhase::Testing | NativeInputPhase::Tested => InputRegionPurpose::SetupTest,
        NativeInputPhase::RunPrepared | NativeInputPhase::Running => {
            InputRegionPurpose::RunFeedback
        }
        NativeInputPhase::Idle => return None,
    };
    state.regions.get(&purpose).copied()
}

fn replace_direction(
    directions: &mut DigitalDirectionsV1,
    direction: DirectionV1,
    token: DigitalInputTokenV1,
) {
    match direction {
        DirectionV1::Up => directions.up = token,
        DirectionV1::Down => directions.down = token,
        DirectionV1::Left => directions.left = token,
        DirectionV1::Right => directions.right = token,
    }
}

fn held_transition(
    held: &mut HashSet<String>,
    signature: String,
    pressed: bool,
) -> Option<(bool, bool)> {
    if pressed {
        held.insert(signature).then_some((true, true))
    } else {
        held.remove(&signature).then_some((false, !held.is_empty()))
    }
}

fn event_token(event: &Event) -> Option<NativeEventToken> {
    match event.event_type {
        EventType::KeyPressed | EventType::KeyReleased => event.keyboard.as_ref().map(|keyboard| {
            (
                DigitalInputTokenV1::Keyboard {
                    code: format!("{:?}", keyboard.key),
                },
                event.event_type == EventType::KeyPressed,
                false,
                None,
            )
        }),
        EventType::MousePressed | EventType::MouseReleased => event
            .mouse
            .as_ref()
            .and_then(|mouse| mouse.button.map(|button| (mouse, button)))
            .and_then(|(mouse, button)| browser_button(button).map(|button| (mouse, button)))
            .map(|(mouse, button)| {
                (
                    DigitalInputTokenV1::MouseButton { button },
                    event.event_type == EventType::MousePressed,
                    false,
                    Some((mouse.x, mouse.y)),
                )
            }),
        EventType::MouseWheel => event.wheel.as_ref().map(|wheel| {
            (
                DigitalInputTokenV1::Wheel {
                    direction: match wheel.direction {
                        ScrollDirection::Up => DirectionV1::Up,
                        ScrollDirection::Down => DirectionV1::Down,
                        ScrollDirection::Left => DirectionV1::Left,
                        ScrollDirection::Right => DirectionV1::Right,
                    },
                },
                true,
                true,
                Some((wheel.x, wheel.y)),
            )
        }),
        EventType::HookEnabled
        | EventType::HookDisabled
        | EventType::KeyTyped
        | EventType::MouseClicked
        | EventType::MouseMoved
        | EventType::MouseDragged => None,
    }
}

fn browser_button(button: Button) -> Option<u8> {
    match button {
        Button::Left => Some(0),
        Button::Middle => Some(1),
        Button::Right => Some(2),
        Button::Button4 => Some(3),
        Button::Button5 => Some(4),
        Button::Unknown(_) => None,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::research_contracts::{AxisNameV1, InputAxesV1, INPUT_BINDING_SCHEMA};
    use monio::Key;
    use std::sync::Barrier;

    fn arrow_binding() -> InputBindingV1 {
        InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.to_owned(),
            version: 1,
            preset: InputPresetV1::ArrowKeys,
            kind: InputKindV1::Digital,
            step_size: Some(0.1),
            directions: Some(DigitalDirectionsV1 {
                up: DigitalInputTokenV1::Keyboard {
                    code: "ArrowUp".to_owned(),
                },
                down: DigitalInputTokenV1::Keyboard {
                    code: "ArrowDown".to_owned(),
                },
                left: DigitalInputTokenV1::Keyboard {
                    code: "ArrowLeft".to_owned(),
                },
                right: DigitalInputTokenV1::Keyboard {
                    code: "ArrowRight".to_owned(),
                },
            }),
            axes: None,
        }
    }

    fn pointer_binding() -> InputBindingV1 {
        InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.to_owned(),
            version: 1,
            preset: InputPresetV1::PointerGrid,
            kind: InputKindV1::Absolute,
            step_size: None,
            directions: None,
            axes: Some(InputAxesV1 {
                x: AxisInputTokenV1::PointerAxis {
                    axis: AxisNameV1::X,
                    invert: false,
                },
                y: AxisInputTokenV1::PointerAxis {
                    axis: AxisNameV1::Y,
                    invert: true,
                },
            }),
        }
    }

    fn left_stick_binding() -> InputBindingV1 {
        InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.to_owned(),
            version: 1,
            preset: InputPresetV1::GamepadLeftStick,
            kind: InputKindV1::Analog,
            step_size: None,
            directions: None,
            axes: Some(InputAxesV1 {
                x: AxisInputTokenV1::GamepadAxis {
                    index: 0,
                    invert: false,
                },
                y: AxisInputTokenV1::GamepadAxis {
                    index: 1,
                    invert: true,
                },
            }),
        }
    }

    fn dpad_binding() -> InputBindingV1 {
        InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.to_owned(),
            version: 1,
            preset: InputPresetV1::GamepadDpad,
            kind: InputKindV1::Digital,
            step_size: Some(0.1),
            directions: Some(DigitalDirectionsV1 {
                up: DigitalInputTokenV1::GamepadButton { button: 12 },
                down: DigitalInputTokenV1::GamepadButton { button: 13 },
                left: DigitalInputTokenV1::GamepadButton { button: 14 },
                right: DigitalInputTokenV1::GamepadButton { button: 15 },
            }),
            axes: None,
        }
    }

    #[test]
    fn physical_keys_use_browser_code_names() {
        let event = Event::key_pressed(Key::ArrowUp, 0);
        let (token, pressed, impulse, position) = event_token(&event).unwrap();
        assert_eq!(
            token,
            DigitalInputTokenV1::Keyboard {
                code: "ArrowUp".into()
            }
        );
        assert!(pressed);
        assert!(!impulse);
        assert_eq!(position, None);
    }

    #[test]
    fn digital_observation_json_keeps_the_v1_shape_without_null_axis_fields() {
        let service = ResearchInputService::for_tests();
        service.begin_test(arrow_binding()).unwrap();
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::key_pressed(Key::ArrowUp, 0),
        );
        let observation = serde_json::to_value(service.status().last_input.unwrap()).unwrap();
        assert!(observation.get("x").is_none());
        assert!(observation.get("y").is_none());
        assert_eq!(observation["detail"], "keyboard:arrowup");
    }

    #[test]
    fn mouse_indices_match_the_browser_contract() {
        assert_eq!(browser_button(Button::Left), Some(0));
        assert_eq!(browser_button(Button::Middle), Some(1));
        assert_eq!(browser_button(Button::Right), Some(2));
    }

    #[test]
    fn character_typed_events_are_never_recorded() {
        assert!(event_token(&Event::key_typed(Key::KeyA, 0, 'a')).is_none());
    }

    #[test]
    fn repeats_are_ignored_and_release_never_requests_a_step() {
        let mut held = HashSet::new();
        assert_eq!(
            held_transition(&mut held, "key:up".into(), true),
            Some((true, true))
        );
        assert_eq!(held_transition(&mut held, "key:up".into(), true), None);
        assert_eq!(
            held_transition(&mut held, "key:up".into(), false),
            Some((false, false))
        );
        assert_eq!(held_transition(&mut held, "key:up".into(), false), None);
    }

    #[test]
    fn receipt_is_bound_to_canonical_binding_hash_and_device_epoch() {
        let service = ResearchInputService::for_tests();
        service.begin_test(arrow_binding()).unwrap();
        for key in [
            Key::ArrowUp,
            Key::ArrowDown,
            Key::ArrowLeft,
            Key::ArrowRight,
        ] {
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_pressed(key, 0),
            );
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_released(key, 0),
            );
        }
        let status = service.status();
        let receipt = status.receipt.unwrap();
        assert_eq!(status.phase, NativeInputPhase::Tested);
        assert_eq!(
            receipt.binding_sha256,
            canonical_sha256(&arrow_binding(), &[]).unwrap()
        );
        assert_eq!(receipt.device_epoch, 1);
        service.set_window_focused(false);
        assert!(service.status().receipt.is_none());
        assert_eq!(service.status().device_epoch, 2);
    }

    #[test]
    fn conflicting_native_capture_is_rejected() {
        let service = ResearchInputService::for_tests();
        service
            .set_region(
                region(InputRegionPurpose::SetupCapture),
                0.0,
                0.0,
                500.0,
                500.0,
            )
            .unwrap();
        service
            .begin_capture(arrow_binding(), DirectionV1::Down)
            .unwrap();
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::key_pressed(Key::ArrowUp, 0),
        );
        let status = service.status();
        assert_eq!(status.phase, NativeInputPhase::Capturing);
        assert!(status.capture.is_none());
        assert!(status.capture_error.is_some());
    }

    #[test]
    fn custom_capture_accepts_a_gamepad_button_without_exposing_device_identity() {
        let service = ResearchInputService::for_tests();
        service
            .set_region(
                region(InputRegionPurpose::SetupCapture),
                0.0,
                0.0,
                500.0,
                500.0,
            )
            .unwrap();
        service
            .begin_capture(arrow_binding(), DirectionV1::Down)
            .unwrap();
        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Button {
                device: 41,
                button: 2,
                pressed: true,
            },
        );
        let capture = service.status().capture.unwrap();
        assert_eq!(
            capture.action,
            DigitalInputTokenV1::GamepadButton { button: 2 }
        );
        assert_eq!(capture.binding.preset, InputPresetV1::Custom);
        assert!(!serde_json::to_string(&capture)
            .unwrap()
            .contains("\"device\":41"));
    }

    #[test]
    fn mouse_input_is_rejected_outside_the_native_allow_region() {
        let service = ResearchInputService::for_tests();
        let mut binding = InputBindingV1 {
            schema: INPUT_BINDING_SCHEMA.to_owned(),
            version: 1,
            preset: InputPresetV1::Custom,
            kind: InputKindV1::Digital,
            step_size: Some(0.1),
            directions: Some(DigitalDirectionsV1 {
                up: DigitalInputTokenV1::MouseButton { button: 0 },
                down: DigitalInputTokenV1::Keyboard {
                    code: "ArrowDown".into(),
                },
                left: DigitalInputTokenV1::Keyboard {
                    code: "ArrowLeft".into(),
                },
                right: DigitalInputTokenV1::Keyboard {
                    code: "ArrowRight".into(),
                },
            }),
            axes: None,
        };
        binding.normalize_and_validate().unwrap();
        service
            .set_region(
                region(InputRegionPurpose::SetupTest),
                0.0,
                0.0,
                500.0,
                500.0,
            )
            .unwrap();
        service.begin_test(binding).unwrap();
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_pressed(Button::Left, 250.0, 250.0),
        );
        assert!(service.status().tested_directions.is_empty());
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_pressed(Button::Left, 50.0, 50.0),
        );
        assert_eq!(service.status().tested_directions, [DirectionV1::Up]);
    }

    #[test]
    fn capability_truthfully_advertises_pointer_and_gamepad_authority() {
        let capability = ResearchInputService::for_tests().capability();
        assert!(capability.native_authority_ready);
        assert!(capability.supports_gamepad);
        assert!(capability.supports_absolute_pointer);
        assert!(capability.supports_custom_gamepad_buttons);
        assert!(capability
            .supported_presets
            .contains(&InputPresetV1::PointerGrid));
        assert!(capability
            .supported_presets
            .contains(&InputPresetV1::GamepadDpad));
        assert!(capability.unavailable_presets.is_empty());
    }

    #[test]
    fn unavailable_service_never_advertises_a_preset_without_an_authority() {
        let capability = ResearchInputService::unavailable().capability();
        assert!(!capability.native_authority_ready);
        assert!(capability.supported_presets.is_empty());
        assert!(!capability.supports_absolute_pointer);
        assert!(!capability.supports_gamepad);
    }

    #[test]
    fn pointer_requires_an_inside_press_and_only_projects_normalized_coordinates() {
        let service = ResearchInputService::for_tests();
        service
            .set_region(
                region(InputRegionPurpose::SetupTest),
                0.0,
                0.0,
                500.0,
                500.0,
            )
            .unwrap();
        service.begin_test(pointer_binding()).unwrap();

        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_pressed(Button::Left, 250.0, 250.0),
        );
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_dragged(10.0, 60.0),
        );
        assert!(service.status().last_input.is_none());

        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_pressed(Button::Left, 60.0, 60.0),
        );
        for (x, y) in [(10.0, 60.0), (110.0, 60.0), (60.0, 110.0), (60.0, 10.0)] {
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::mouse_dragged(x, y),
            );
        }
        let tested = service.status();
        assert_eq!(tested.phase, NativeInputPhase::Tested);
        assert!(tested.receipt.is_some());
        assert_eq!(tested.tested_directions.len(), 4);

        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::mouse_released(Button::Left, 160.0, -25.0),
        );
        let observation = service.status().last_input.unwrap();
        assert_eq!(observation.detail, "pointer:absolute");
        assert_eq!((observation.x, observation.y), (Some(1.0), Some(1.0)));
        assert!(!observation.input_active);
    }

    #[test]
    fn non_finite_pointer_and_gamepad_values_fail_closed() {
        let pointer = ResearchInputService::for_tests();
        pointer
            .set_region(
                region(InputRegionPurpose::SetupTest),
                0.0,
                0.0,
                500.0,
                500.0,
            )
            .unwrap();
        pointer.begin_test(pointer_binding()).unwrap();
        process_event(
            &pointer.state,
            &pointer.dispatch_gate,
            &Event::mouse_pressed(Button::Left, 60.0, 60.0),
        );
        let pointer_sequence = pointer.status().last_input.unwrap().sequence;
        process_event(
            &pointer.state,
            &pointer.dispatch_gate,
            &Event::mouse_dragged(f64::NAN, 60.0),
        );
        assert_eq!(
            pointer.status().last_input.unwrap().sequence,
            pointer_sequence
        );

        let gamepad = ResearchInputService::for_tests();
        gamepad.begin_test(left_stick_binding()).unwrap();
        process_gamepad_event(
            &gamepad.state,
            &gamepad.dispatch_gate,
            GamepadInputEvent::Axis {
                device: 4,
                axis: 0,
                value: f64::INFINITY,
            },
        );
        assert!(gamepad.status().last_input.is_none());
        process_gamepad_event(
            &gamepad.state,
            &gamepad.dispatch_gate,
            GamepadInputEvent::Axis {
                device: 5,
                axis: 0,
                value: 0.8,
            },
        );
        assert_eq!(gamepad.status().last_input.unwrap().x, Some(0.8));
    }

    #[test]
    fn inverted_gamepad_neutral_is_canonical_positive_zero() {
        let values = [0.0; 4];
        let token = AxisInputTokenV1::GamepadAxis {
            index: 1,
            invert: true,
        };
        assert_eq!(gamepad_axis_value(&values, &token).unwrap().to_bits(), 0);
    }

    #[test]
    fn cross_source_reverse_arrival_cannot_regress_observation_time() {
        let mut state = InputServiceState::default();
        let earlier = Instant::now();
        let later = earlier + Duration::from_millis(2);
        assert_eq!(ordered_observed_at(&mut state, later), later);
        assert_eq!(ordered_observed_at(&mut state, earlier), later);
        assert_eq!(state.last_ordered_observed_at, Some(later));
    }

    #[test]
    fn analog_gamepad_test_is_direction_complete_and_first_device_is_exclusive() {
        let service = ResearchInputService::for_tests();
        service.begin_test(left_stick_binding()).unwrap();
        for (axis, value) in [(0, -1.0), (0, 1.0), (1, 1.0), (1, -1.0)] {
            process_gamepad_event(
                &service.state,
                &service.dispatch_gate,
                GamepadInputEvent::Axis {
                    device: 7,
                    axis,
                    value,
                },
            );
        }
        let tested = service.status();
        assert_eq!(tested.phase, NativeInputPhase::Tested);
        assert_eq!(tested.tested_directions.len(), 4);
        let sequence = tested.last_input.unwrap().sequence;

        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Axis {
                device: 9,
                axis: 0,
                value: 0.9,
            },
        );
        assert_eq!(service.status().last_input.unwrap().sequence, sequence);
    }

    #[test]
    fn dpad_edges_ignore_repeat_and_disconnect_revokes_run_authority() {
        let service = ResearchInputService::for_tests();
        service.begin_test(dpad_binding()).unwrap();
        for button in [12, 13, 14, 15] {
            process_gamepad_event(
                &service.state,
                &service.dispatch_gate,
                GamepadInputEvent::Button {
                    device: 3,
                    button,
                    pressed: true,
                },
            );
            let sequence = service.status().last_input.unwrap().sequence;
            process_gamepad_event(
                &service.state,
                &service.dispatch_gate,
                GamepadInputEvent::Button {
                    device: 3,
                    button,
                    pressed: true,
                },
            );
            assert_eq!(service.status().last_input.unwrap().sequence, sequence);
            process_gamepad_event(
                &service.state,
                &service.dispatch_gate,
                GamepadInputEvent::Button {
                    device: 3,
                    button,
                    pressed: false,
                },
            );
        }
        let receipt = service.status().receipt.unwrap();
        let updates = Arc::new(Mutex::new(Vec::new()));
        let callback_updates = Arc::clone(&updates);
        let authority = service
            .prepare_run_full(dpad_binding(), &receipt.receipt_id, move |update| {
                lock(&callback_updates).push(update);
            })
            .unwrap();
        service.set_run_accepting(&authority, true).unwrap();
        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Disconnected { device: 3 },
        );
        let received = lock(&updates);
        assert!(matches!(
            received.last(),
            Some(NativeInputUpdate::AuthorityLost(loss))
                if loss.reason_code == "native-gamepad-disconnected"
        ));
        assert!(service.status().receipt.is_none());
        assert_eq!(service.status().device_epoch, 2);
    }

    #[test]
    fn paused_gamepad_disconnect_revokes_authority_without_unlocking_the_attempt_device() {
        let service = ResearchInputService::for_tests();
        let receipt = service
            .issue_test_receipt_for_tests(dpad_binding())
            .unwrap();
        let updates = Arc::new(Mutex::new(Vec::new()));
        let callback_updates = Arc::clone(&updates);
        let authority = service
            .prepare_run_full(dpad_binding(), &receipt.receipt_id, move |update| {
                lock(&callback_updates).push(update);
            })
            .unwrap();
        service.set_run_accepting(&authority, true).unwrap();
        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Button {
                device: 3,
                button: 12,
                pressed: true,
            },
        );
        service.set_run_accepting(&authority, false).unwrap();
        lock(&updates).clear();

        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Disconnected { device: 3 },
        );
        assert!(matches!(
            lock(&updates).last(),
            Some(NativeInputUpdate::AuthorityLost(loss))
                if loss.reason_code == "native-gamepad-disconnected"
        ));
        assert_eq!(lock(&service.state).active_gamepad, Some(3));

        let update_count = lock(&updates).len();
        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Button {
                device: 9,
                button: 13,
                pressed: true,
            },
        );
        assert_eq!(lock(&updates).len(), update_count);
        assert_eq!(lock(&service.state).active_gamepad, Some(3));
    }

    #[test]
    fn analog_run_sink_receives_only_semantic_values_without_device_identity() {
        let service = ResearchInputService::for_tests();
        let receipt = service
            .issue_test_receipt_for_tests(left_stick_binding())
            .unwrap();
        let updates = Arc::new(Mutex::new(Vec::new()));
        let callback_updates = Arc::clone(&updates);
        let authority = service
            .prepare_run_full(left_stick_binding(), &receipt.receipt_id, move |update| {
                lock(&callback_updates).push(update)
            })
            .unwrap();
        service.set_run_accepting(&authority, true).unwrap();
        process_gamepad_event(
            &service.state,
            &service.dispatch_gate,
            GamepadInputEvent::Axis {
                device: 27,
                axis: 1,
                value: -0.8,
            },
        );
        let received = lock(&updates);
        let Some(NativeInputUpdate::Continuous(NativeContinuousInput {
            x,
            y,
            detail,
            input_active,
            observed_at: _,
        })) = received.last()
        else {
            panic!("expected one semantic continuous-input update");
        };
        assert_eq!(*x, 0.0);
        assert_eq!(*y, 0.8);
        assert_eq!(detail, "gamepad:analog");
        assert!(*input_active);
    }

    #[test]
    fn unfocused_window_cannot_feed_setup_or_run_input() {
        let service = ResearchInputService::for_tests();
        service.begin_test(arrow_binding()).unwrap();
        service.set_window_focused(false);
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::key_pressed(Key::ArrowUp, 0),
        );
        assert!(service.status().tested_directions.is_empty());
        assert_eq!(service.status().device_epoch, 2);

        service.set_window_focused(true);
        let receipt = service
            .issue_test_receipt_for_tests(arrow_binding())
            .unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let callback_received = Arc::clone(&received);
        let authority = service
            .prepare_run(arrow_binding(), &receipt.receipt_id, move |input| {
                lock(&callback_received).push(input.direction);
            })
            .unwrap();
        service.set_run_accepting(&authority, true).unwrap();
        service.set_window_focused(false);
        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::key_pressed(Key::ArrowUp, 0),
        );
        assert!(lock(&received).is_empty());
    }

    #[test]
    fn pause_focus_and_layout_barriers_release_without_rearming_a_held_key() {
        for barrier in ["pause", "focus", "layout"] {
            let service = ResearchInputService::for_tests();
            let receipt = service
                .issue_test_receipt_for_tests(arrow_binding())
                .unwrap();
            let updates = Arc::new(Mutex::new(Vec::new()));
            let callback_updates = Arc::clone(&updates);
            let authority = service
                .prepare_run_full(arrow_binding(), &receipt.receipt_id, move |update| {
                    lock(&callback_updates).push(update);
                })
                .unwrap();
            service.set_run_accepting(&authority, true).unwrap();
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_pressed(Key::ArrowUp, 0),
            );
            assert_eq!(lock(&updates).len(), 1, "barrier {barrier}");

            let expected_detail = match barrier {
                "pause" => {
                    service.set_run_accepting(&authority, false).unwrap();
                    service.set_run_accepting(&authority, true).unwrap();
                    "native:lifecycle-release"
                }
                "focus" => {
                    service.set_window_focused(false);
                    service.set_window_focused(true);
                    "native:focus-release"
                }
                "layout" => {
                    service.clear_regions_after_layout_change();
                    "native:layout-release"
                }
                _ => unreachable!(),
            };
            {
                let received = lock(&updates);
                assert_eq!(received.len(), 2, "barrier {barrier}");
                assert!(matches!(
                    received.last(),
                    Some(NativeInputUpdate::Digital(input))
                        if input.detail == expected_detail
                            && !input.apply_step
                            && !input.input_active
                ));
            }

            // A repeated press remains the same held physical action. Only its
            // release permits a subsequent press to become a fresh edge.
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_pressed(Key::ArrowUp, 0),
            );
            assert_eq!(lock(&updates).len(), 2, "barrier {barrier}");
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_released(Key::ArrowUp, 0),
            );
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::key_pressed(Key::ArrowUp, 0),
            );
            let received = lock(&updates);
            assert_eq!(received.len(), 4, "barrier {barrier}");
            assert!(matches!(
                received.last(),
                Some(NativeInputUpdate::Digital(input)) if input.apply_step && input.input_active
            ));
        }
    }

    #[test]
    fn lifecycle_barriers_preserve_absolute_rating_and_end_drag() {
        for barrier in ["pause", "focus", "layout"] {
            let service = ResearchInputService::for_tests();
            let receipt = service
                .issue_test_receipt_for_tests(pointer_binding())
                .unwrap();
            let updates = Arc::new(Mutex::new(Vec::new()));
            let callback_updates = Arc::clone(&updates);
            let authority = service
                .prepare_run_full(pointer_binding(), &receipt.receipt_id, move |update| {
                    lock(&callback_updates).push(update);
                })
                .unwrap();
            service
                .set_region(
                    region(InputRegionPurpose::RunFeedback),
                    0.0,
                    0.0,
                    500.0,
                    500.0,
                )
                .unwrap();
            service.set_run_accepting(&authority, true).unwrap();
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::mouse_pressed(Button::Left, 100.0, 20.0),
            );
            let (rating_x, rating_y) = match lock(&updates).last() {
                Some(NativeInputUpdate::Continuous(input)) if input.input_active => {
                    (input.x, input.y)
                }
                _ => panic!("expected an active absolute update for barrier {barrier}"),
            };
            assert_ne!((rating_x, rating_y), (0.0, 0.0));

            match barrier {
                "pause" => {
                    service.set_run_accepting(&authority, false).unwrap();
                    service.set_run_accepting(&authority, true).unwrap();
                }
                "focus" => service.set_window_focused(false),
                "layout" => service.clear_regions_after_layout_change(),
                _ => unreachable!(),
            }
            let count_after_barrier = lock(&updates).len();
            assert!(matches!(
                lock(&updates).last(),
                Some(NativeInputUpdate::Continuous(input))
                    if input.x == rating_x && input.y == rating_y && !input.input_active
            ));

            if barrier == "focus" {
                service.set_window_focused(true);
            }
            process_event(
                &service.state,
                &service.dispatch_gate,
                &Event::mouse_dragged(95.0, 25.0),
            );
            assert_eq!(lock(&updates).len(), count_after_barrier);
        }
    }

    #[test]
    fn acceptance_barrier_waits_for_an_accepted_callback_before_freezing() {
        let service = Arc::new(ResearchInputService::for_tests());
        let receipt = service
            .issue_test_receipt_for_tests(arrow_binding())
            .unwrap();
        let callback_release = Arc::new(Barrier::new(2));
        let sink_release = Arc::clone(&callback_release);
        let (entered_sender, entered_receiver) = std::sync::mpsc::channel();
        let authority = service
            .prepare_run_full(arrow_binding(), &receipt.receipt_id, move |update| {
                if matches!(
                    update,
                    NativeInputUpdate::Digital(NativeDigitalInput {
                        apply_step: true,
                        ..
                    })
                ) {
                    entered_sender.send(()).unwrap();
                    sink_release.wait();
                }
            })
            .unwrap();
        service.set_run_accepting(&authority, true).unwrap();

        let callback_state = Arc::clone(&service.state);
        let callback_gate = Arc::clone(&service.dispatch_gate);
        let callback = std::thread::spawn(move || {
            process_event(
                &callback_state,
                &callback_gate,
                &Event::key_pressed(Key::ArrowUp, 0),
            );
        });
        entered_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let transition_service = Arc::clone(&service);
        let transition_authority = authority.clone();
        let (frozen_sender, frozen_receiver) = std::sync::mpsc::channel();
        let transition = std::thread::spawn(move || {
            transition_service
                .set_run_accepting(&transition_authority, false)
                .unwrap();
            frozen_sender.send(()).unwrap();
        });
        assert!(matches!(
            frozen_receiver.recv_timeout(Duration::from_millis(25)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));

        callback_release.wait();
        callback.join().unwrap();
        frozen_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        transition.join().unwrap();

        process_event(
            &service.state,
            &service.dispatch_gate,
            &Event::key_pressed(Key::ArrowDown, 0),
        );
        assert!(matches!(
            entered_receiver.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
    }

    fn region(purpose: InputRegionPurpose) -> NativeInputRegionRequest {
        NativeInputRegionRequest {
            purpose,
            layout_epoch: 1,
            left: 10.0,
            top: 10.0,
            width: 100.0,
            height: 100.0,
            viewport_width: 500.0,
            viewport_height: 500.0,
        }
    }
}
