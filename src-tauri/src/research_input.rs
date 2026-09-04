use crate::research_contracts::{
    canonical_sha256, DigitalDirectionsV1, DigitalInputTokenV1, DirectionV1, InputBindingV1,
    InputKindV1, InputPresetV1,
};
use crate::research_error::{CommandError, ResearchResult};
use monio::{Button, Event, EventType, Hook, ScrollDirection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const INPUT_TEST_RECEIPT_TTL: Duration = Duration::from_secs(15 * 60);
const INPUT_SERVICE_SCHEMA: &str = "affect-research-native-input";
type RunInputSink = Arc<dyn Fn(NativeDigitalInput) + Send + Sync>;
type NativeEventToken = (DigitalInputTokenV1, bool, bool, Option<(f64, f64)>);

/// Single native authority for Setup capture/testing and Run rating input.
/// The WebView may render these receipts but cannot manufacture them.
pub struct ResearchInputService {
    hook: Option<Hook>,
    state: Arc<Mutex<InputServiceState>>,
    test_backend: bool,
}

#[derive(Debug, Clone)]
pub struct NativeDigitalInput {
    pub direction: DirectionV1,
    pub detail: String,
    pub apply_step: bool,
    pub input_active: bool,
    pub impulse: bool,
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
    last_input: Option<NativeInputObservation>,
    input_sequence: u64,
    run_authority_id: Option<String>,
    run_sink: Option<RunInputSink>,
    window_focused: bool,
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
            last_input: None,
            input_sequence: 0,
            run_authority_id: None,
            run_sink: None,
            window_focused: false,
        }
    }
}

impl ResearchInputService {
    pub fn start() -> ResearchResult<Self> {
        let state = Arc::new(Mutex::new(InputServiceState::default()));
        let callback_state = Arc::clone(&state);
        let hook = Hook::new();
        hook.run_async(move |event: &Event| process_event(&callback_state, event))
            .map_err(|_| {
                CommandError::new(
                    "native_input_unavailable",
                    "The safe native keyboard and mouse input authority could not start.",
                )
            })?;
        Ok(Self {
            hook: Some(hook),
            state,
            test_backend: false,
        })
    }

    pub fn unavailable() -> Self {
        Self {
            hook: None,
            state: Arc::new(Mutex::new(InputServiceState::default())),
            test_backend: false,
        }
    }

    #[cfg(test)]
    pub fn for_tests() -> Self {
        let state = InputServiceState {
            window_focused: true,
            ..InputServiceState::default()
        };
        Self {
            hook: None,
            state: Arc::new(Mutex::new(state)),
            test_backend: true,
        }
    }

    fn backend_ready(&self) -> bool {
        self.test_backend || self.hook.as_ref().is_some_and(Hook::is_running)
    }

    pub fn capability(&self) -> NativeInputCapability {
        let device_epoch = lock(&self.state).device_epoch;
        NativeInputCapability {
            schema: INPUT_SERVICE_SCHEMA,
            version: 1,
            backend: "monio-listen-only",
            native_authority_ready: self.backend_ready(),
            reason_code: (!self.backend_ready()).then_some("native-hook-unavailable"),
            supported_presets: vec![
                InputPresetV1::ArrowKeys,
                InputPresetV1::Wasd,
                InputPresetV1::Ijkl,
                InputPresetV1::Numpad,
                InputPresetV1::MouseButtonsWheel,
                InputPresetV1::Custom,
            ],
            unavailable_presets: vec![
                UnavailableInputPreset {
                    preset: InputPresetV1::PointerGrid,
                    reason_code: "native-absolute-pointer-not-implemented",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadDpad,
                    reason_code: "native-gamepad-not-implemented",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadLeftStick,
                    reason_code: "native-gamepad-not-implemented",
                },
                UnavailableInputPreset {
                    preset: InputPresetV1::GamepadRightStick,
                    reason_code: "native-gamepad-not-implemented",
                },
            ],
            supports_custom_keyboard: true,
            supports_custom_mouse_buttons: true,
            supports_custom_wheel: true,
            supports_absolute_pointer: false,
            supports_gamepad: false,
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
        if changed && request.purpose == InputRegionPurpose::RunFeedback {
            clear_held(&mut state);
        }
        Ok(status_from_state(&state))
    }

    pub fn rebase_window_origin(&self, window_left: f64, window_top: f64) {
        if !window_left.is_finite() || !window_top.is_finite() {
            return;
        }
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
        let mut state = lock(&self.state);
        state.regions.clear();
        state.window_origin = None;
        clear_held(&mut state);
        if matches!(
            state.phase,
            NativeInputPhase::Testing | NativeInputPhase::Tested
        ) {
            invalidate_test(&mut state);
            state.phase = NativeInputPhase::Testing;
        }
    }

    pub fn set_window_focused(&self, focused: bool) {
        let mut state = lock(&self.state);
        state.window_focused = focused;
        clear_held(&mut state);
        if !focused
            && !matches!(
                state.phase,
                NativeInputPhase::Running | NativeInputPhase::RunPrepared
            )
        {
            state.device_epoch = state.device_epoch.saturating_add(1);
            state.phase = NativeInputPhase::Idle;
            state.binding = None;
            state.binding_sha256 = None;
            state.capture_direction = None;
            state.capture_result = None;
            state.capture_error = None;
            invalidate_test(&mut state);
        }
    }

    pub fn begin_test(&self, binding: InputBindingV1) -> ResearchResult<NativeInputStatus> {
        self.ensure_backend()?;
        let (binding, binding_sha256) = normalize_supported_binding(binding)?;
        let mut state = lock(&self.state);
        if matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            return Err(CommandError::run_active());
        }
        if binding_uses_mouse_or_wheel(&binding)
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
        invalidate_test(&mut state);
        clear_held(&mut state);
        Ok(status_from_state(&state))
    }

    pub fn begin_capture(
        &self,
        binding: InputBindingV1,
        direction: DirectionV1,
    ) -> ResearchResult<NativeInputStatus> {
        self.ensure_backend()?;
        let (binding, binding_sha256) = normalize_supported_binding(binding)?;
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
        invalidate_test(&mut state);
        clear_held(&mut state);
        Ok(status_from_state(&state))
    }

    pub fn cancel_setup(&self) -> NativeInputStatus {
        let mut state = lock(&self.state);
        if !matches!(
            state.phase,
            NativeInputPhase::Running | NativeInputPhase::RunPrepared
        ) {
            state.phase = NativeInputPhase::Idle;
            state.capture_direction = None;
            state.capture_error = None;
            clear_held(&mut state);
        }
        status_from_state(&state)
    }

    pub fn status(&self) -> NativeInputStatus {
        let mut state = lock(&self.state);
        expire_receipt(&mut state);
        status_from_state(&state)
    }

    pub fn prepare_run(
        &self,
        binding: InputBindingV1,
        receipt_id: &str,
        on_input: impl Fn(NativeDigitalInput) + Send + Sync + 'static,
    ) -> ResearchResult<String> {
        self.ensure_backend()?;
        let (binding, binding_sha256) = normalize_supported_binding(binding)?;
        if Uuid::parse_str(receipt_id).is_err() {
            return Err(CommandError::invalid_contract(
                "The native input-test receipt ID is invalid.",
            ));
        }
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
        clear_held(&mut state);
        Ok(authority_id)
    }

    pub fn set_run_accepting(&self, authority_id: &str, accepting: bool) -> ResearchResult<()> {
        let mut state = lock(&self.state);
        validate_run_ready(&state, authority_id, accepting)?;
        if accepting {
            state.phase = NativeInputPhase::Running;
        } else {
            state.phase = NativeInputPhase::RunPrepared;
        }
        clear_held(&mut state);
        Ok(())
    }

    pub fn ensure_run_ready(&self, authority_id: &str) -> ResearchResult<()> {
        validate_run_ready(&lock(&self.state), authority_id, true)
    }

    pub fn end_run(&self, authority_id: &str) {
        let mut state = lock(&self.state);
        if state.run_authority_id.as_deref() != Some(authority_id) {
            return;
        }
        state.phase = NativeInputPhase::Idle;
        state.binding = None;
        state.binding_sha256 = None;
        state.run_authority_id = None;
        state.run_sink = None;
        state.regions.remove(&InputRegionPurpose::RunFeedback);
        clear_held(&mut state);
    }

    pub fn shutdown(&self) {
        {
            let mut state = lock(&self.state);
            state.phase = NativeInputPhase::Idle;
            state.run_authority_id = None;
            state.run_sink = None;
            clear_held(&mut state);
        }
        if let Some(hook) = &self.hook {
            if hook.is_running() {
                let _ = hook.stop();
            }
        }
    }

    fn ensure_backend(&self) -> ResearchResult<()> {
        if self.backend_ready() {
            Ok(())
        } else {
            Err(CommandError::new(
                "native_input_unavailable",
                "The safe native keyboard and mouse input authority is not running.",
            ))
        }
    }

    #[cfg(test)]
    pub fn issue_test_receipt_for_tests(
        &self,
        binding: InputBindingV1,
    ) -> ResearchResult<InputTestReceipt> {
        let (binding, binding_sha256) = normalize_supported_binding(binding)?;
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
        if binding_uses_mouse_or_wheel(binding)
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
) -> ResearchResult<(InputBindingV1, String)> {
    binding.normalize_and_validate()?;
    if binding.kind != InputKindV1::Digital {
        return Err(CommandError::new(
            "native_input_preset_unavailable",
            "This Tauri build supports only native digital keyboard, mouse-button, and wheel bindings.",
        ));
    }
    let contains_gamepad = binding.directions.as_ref().is_some_and(|directions| {
        direction_tokens(directions)
            .into_iter()
            .any(|token| matches!(token, DigitalInputTokenV1::GamepadButton { .. }))
    });
    if !matches!(
        binding.preset,
        InputPresetV1::ArrowKeys
            | InputPresetV1::Wasd
            | InputPresetV1::Ijkl
            | InputPresetV1::Numpad
            | InputPresetV1::MouseButtonsWheel
            | InputPresetV1::Custom
    ) || contains_gamepad
    {
        return Err(CommandError::new(
            "native_input_preset_unavailable",
            "This input preset has no safe native authority in the current Tauri build.",
        ));
    }
    let binding_sha256 = canonical_sha256(&binding, &[])?;
    Ok((binding, binding_sha256))
}

fn binding_uses_mouse_or_wheel(binding: &InputBindingV1) -> bool {
    binding.directions.as_ref().is_some_and(|directions| {
        direction_tokens(directions).into_iter().any(|token| {
            matches!(
                token,
                DigitalInputTokenV1::MouseButton { .. } | DigitalInputTokenV1::Wheel { .. }
            )
        })
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
                !binding_uses_mouse_or_wheel(binding)
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

fn process_event(shared: &Arc<Mutex<InputServiceState>>, event: &Event) {
    let Some((token, pressed, impulse, screen_position)) = event_token(event) else {
        return;
    };
    let signature = token.signature();
    let mut sink_and_input = None;
    {
        let mut state = lock(shared);
        if !state.window_focused {
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

        if state.phase == NativeInputPhase::Capturing {
            if !pressed || (!impulse && state.held.contains(&signature)) {
                return;
            }
            let Some(direction) = state.capture_direction else {
                return;
            };
            let Some(mut binding) = state.binding.clone() else {
                return;
            };
            let Some(directions) = binding.directions.as_mut() else {
                return;
            };
            replace_direction(directions, direction, token.clone());
            binding.preset = InputPresetV1::Custom;
            match normalize_supported_binding(binding) {
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
            return;
        }

        let Some(direction) = state
            .binding
            .as_ref()
            .and_then(|binding| binding.directions.as_ref())
            .and_then(|directions| directions.direction_for(&token))
        else {
            return;
        };
        let transition = if impulse {
            Some((true, true))
        } else {
            held_transition(&mut state.held, signature, pressed)
        };
        let Some((apply_step, input_active)) = transition else {
            return;
        };
        state.input_sequence = state.input_sequence.saturating_add(1);
        let input = NativeDigitalInput {
            direction,
            detail: token.detail_code(),
            apply_step,
            input_active,
            impulse,
        };
        state.last_input = Some(NativeInputObservation {
            sequence: state.input_sequence,
            direction,
            detail: input.detail.clone(),
            apply_step,
            input_active,
            impulse,
        });
        match state.phase {
            NativeInputPhase::Testing | NativeInputPhase::Tested => {
                if apply_step {
                    state.tested_directions.insert(direction);
                }
                if state.tested_directions.len() == 4 {
                    let Some(binding_sha256) = state.binding_sha256.clone() else {
                        return;
                    };
                    state.receipt = Some(new_receipt(binding_sha256, state.device_epoch));
                    state.phase = NativeInputPhase::Tested;
                }
            }
            NativeInputPhase::Running => {
                if let Some(sink) = state.run_sink.clone() {
                    sink_and_input = Some((sink, input));
                }
            }
            NativeInputPhase::Idle
            | NativeInputPhase::Capturing
            | NativeInputPhase::RunPrepared => {}
        }
    }
    if let Some((sink, input)) = sink_and_input {
        sink(input);
    }
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
    use crate::research_contracts::INPUT_BINDING_SCHEMA;
    use monio::Key;

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
            process_event(&service.state, &Event::key_pressed(key, 0));
            process_event(&service.state, &Event::key_released(key, 0));
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
        process_event(&service.state, &Event::key_pressed(Key::ArrowUp, 0));
        let status = service.status();
        assert_eq!(status.phase, NativeInputPhase::Capturing);
        assert!(status.capture.is_none());
        assert!(status.capture_error.is_some());
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
            &Event::mouse_pressed(Button::Left, 250.0, 250.0),
        );
        assert!(service.status().tested_directions.is_empty());
        process_event(
            &service.state,
            &Event::mouse_pressed(Button::Left, 50.0, 50.0),
        );
        assert_eq!(service.status().tested_directions, [DirectionV1::Up]);
    }

    #[test]
    fn capability_does_not_claim_gamepad_or_absolute_pointer_authority() {
        let capability = ResearchInputService::for_tests().capability();
        assert!(!capability.supports_gamepad);
        assert!(!capability.supports_absolute_pointer);
        assert!(!capability
            .supported_presets
            .contains(&InputPresetV1::PointerGrid));
        assert!(!capability
            .supported_presets
            .contains(&InputPresetV1::GamepadDpad));
    }

    #[test]
    fn unfocused_window_cannot_feed_setup_or_run_input() {
        let service = ResearchInputService::for_tests();
        service.begin_test(arrow_binding()).unwrap();
        service.set_window_focused(false);
        process_event(&service.state, &Event::key_pressed(Key::ArrowUp, 0));
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
        process_event(&service.state, &Event::key_pressed(Key::ArrowUp, 0));
        assert!(lock(&received).is_empty());
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
