use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use uuid::Uuid;

pub const AFFECT_MATRIX_SIZE: u8 = 11;
pub const DEFAULT_MATRIX_STEPS_PER_SECOND: f32 = 5.0;
pub const MIN_MATRIX_STEPS_PER_SECOND: f32 = 0.5;
pub const MAX_MATRIX_STEPS_PER_SECOND: f32 = 10.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AffectPalette {
    pub up: String,
    pub down: String,
    pub left: String,
    pub right: String,
}

impl Default for AffectPalette {
    fn default() -> Self {
        Self {
            up: "#ffd166".into(),
            down: "#5c7cfa".into(),
            left: "#ff5b68".into(),
            right: "#5dffb0".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    IncreaseValence,
    DecreaseValence,
    IncreaseArousal,
    DecreaseArousal,
    Reset,
    TogglePause,
    ShowSettings,
    ToggleOverlayEditing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeatureAction {
    IncreaseAnimationSpeed,
    DecreaseAnimationSpeed,
    IncreaseAmplitude,
    DecreaseAmplitude,
    IncreaseDisorder,
    DecreaseDisorder,
    IncreaseTransparency,
    DecreaseTransparency,
    IncreaseSize,
    DecreaseSize,
}

impl FeatureAction {
    pub fn marker_name(self) -> &'static str {
        match self {
            Self::IncreaseAnimationSpeed => "increase_animation_speed",
            Self::DecreaseAnimationSpeed => "decrease_animation_speed",
            Self::IncreaseAmplitude => "increase_amplitude",
            Self::DecreaseAmplitude => "decrease_amplitude",
            Self::IncreaseDisorder => "increase_disorder",
            Self::DecreaseDisorder => "decrease_disorder",
            Self::IncreaseTransparency => "increase_transparency",
            Self::DecreaseTransparency => "decrease_transparency",
            Self::IncreaseSize => "increase_size",
            Self::DecreaseSize => "decrease_size",
        }
    }

    pub fn changes_size(self) -> bool {
        matches!(self, Self::IncreaseSize | Self::DecreaseSize)
    }
}

impl Action {
    pub fn is_directional(self) -> bool {
        matches!(
            self,
            Self::IncreaseValence
                | Self::DecreaseValence
                | Self::IncreaseArousal
                | Self::DecreaseArousal
        )
    }

    pub fn marker_name(self) -> &'static str {
        match self {
            Self::IncreaseValence => "increase_valence",
            Self::DecreaseValence => "decrease_valence",
            Self::IncreaseArousal => "increase_arousal",
            Self::DecreaseArousal => "decrease_arousal",
            Self::Reset => "reset",
            Self::TogglePause => "toggle_pause",
            Self::ShowSettings => "show_settings",
            Self::ToggleOverlayEditing => "toggle_overlay_editing",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputMode {
    Continuous,
    Step,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AffectTraversalMode {
    #[default]
    Continuous,
    Matrix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectMatrixCell {
    pub column: u8,
    pub row: u8,
}

impl AffectMatrixCell {
    pub fn new(column: u8, row: u8) -> Option<Self> {
        (column < AFFECT_MATRIX_SIZE && row < AFFECT_MATRIX_SIZE).then_some(Self { column, row })
    }

    fn step_toward(self, target: Self) -> Self {
        Self {
            column: step_index_toward(self.column, target.column),
            row: step_index_toward(self.row, target.row),
        }
    }

    fn coordinates(self) -> (f32, f32) {
        (matrix_coordinate(self.column), matrix_coordinate(self.row))
    }
}

fn step_index_toward(value: u8, target: u8) -> u8 {
    match value.cmp(&target) {
        std::cmp::Ordering::Less => value + 1,
        std::cmp::Ordering::Greater => value - 1,
        std::cmp::Ordering::Equal => value,
    }
}

fn matrix_coordinate(index: u8) -> f32 {
    -1.0 + 2.0 * index as f32 / (AFFECT_MATRIX_SIZE - 1) as f32
}

fn nearest_matrix_index(value: f32, target: u8) -> u8 {
    let scaled = ((value.clamp(-1.0, 1.0) + 1.0) * 0.5 * (AFFECT_MATRIX_SIZE - 1) as f32)
        .clamp(0.0, (AFFECT_MATRIX_SIZE - 1) as f32);
    let lower = scaled.floor() as u8;
    let upper = scaled.ceil() as u8;
    let lower_distance = scaled - lower as f32;
    let upper_distance = upper as f32 - scaled;
    if (lower_distance - upper_distance).abs() <= f32::EPSILON {
        if target as f32 >= scaled {
            upper
        } else {
            lower
        }
    } else if lower_distance < upper_distance {
        lower
    } else {
        upper
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlubberBaseShape {
    #[default]
    Circle,
    Heart,
    Triangle,
    Square,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub current_x: f32,
    pub current_y: f32,
    pub target_x: f32,
    pub target_y: f32,
    pub phase: f32,
    pub animation_active: bool,
    pub input_active: bool,
    pub radius: f32,
    pub angle_degrees: f32,
    pub overlay_visible: bool,
    pub overlay_editing: bool,
    pub overlay_opacity: f32,
    pub overlay_size: u32,
    pub animation_speed: f32,
    pub amplitude_scale: f32,
    pub disorder_scale: f32,
    pub base_shape: FlubberBaseShape,
    pub palette: AffectPalette,
    pub lsl_state: String,
    pub lsl_message: String,
    pub traversal_mode: AffectTraversalMode,
    pub matrix_size: u8,
    pub matrix_current: Option<AffectMatrixCell>,
    pub matrix_target: Option<AffectMatrixCell>,
    pub matrix_traversing: bool,
    pub matrix_steps_per_second: f32,
}

pub(crate) struct SnapshotContext<'a> {
    pub overlay_visible: bool,
    pub overlay_editing: bool,
    pub overlay_opacity: f32,
    pub overlay_size: u32,
    pub animation_speed: f32,
    pub amplitude_scale: f32,
    pub disorder_scale: f32,
    pub base_shape: FlubberBaseShape,
    pub palette: AffectPalette,
    pub lsl_state: &'a str,
    pub lsl_message: &'a str,
}

#[derive(Debug)]
pub struct AffectEngine {
    current_x: f32,
    current_y: f32,
    target_x: f32,
    target_y: f32,
    phase: f32,
    animation_active: bool,
    held: HashSet<Action>,
    input_mode: InputMode,
    step_size: f32,
    continuous_speed: f32,
    animation_speed: f32,
    response: f32,
    traversal_mode: AffectTraversalMode,
    matrix_current: Option<AffectMatrixCell>,
    matrix_target: Option<AffectMatrixCell>,
    matrix_path: VecDeque<AffectMatrixCell>,
    matrix_elapsed: f32,
    matrix_steps_per_second: f32,
    session_id: Uuid,
    sequence: u64,
}

impl AffectEngine {
    pub fn new(
        input_mode: InputMode,
        step_size: f32,
        continuous_speed: f32,
        response: f32,
        animation_speed: f32,
    ) -> Self {
        Self {
            current_x: 0.0,
            current_y: 0.0,
            target_x: 0.0,
            target_y: 0.0,
            phase: 0.0,
            animation_active: true,
            held: HashSet::new(),
            input_mode,
            step_size,
            continuous_speed,
            animation_speed,
            response,
            traversal_mode: AffectTraversalMode::Continuous,
            matrix_current: None,
            matrix_target: None,
            matrix_path: VecDeque::new(),
            matrix_elapsed: 0.0,
            matrix_steps_per_second: DEFAULT_MATRIX_STEPS_PER_SECOND,
            session_id: Uuid::new_v4(),
            sequence: 0,
        }
    }

    pub fn configure(
        &mut self,
        input_mode: InputMode,
        step_size: f32,
        continuous_speed: f32,
        response: f32,
        animation_speed: f32,
    ) {
        self.input_mode = input_mode;
        self.step_size = step_size;
        self.continuous_speed = continuous_speed;
        self.animation_speed = animation_speed;
        self.response = response;
        self.held.clear();
        self.set_traversal_mode(AffectTraversalMode::Continuous);
    }

    pub fn set_traversal_mode(&mut self, mode: AffectTraversalMode) {
        self.traversal_mode = mode;
        self.matrix_current = if mode == AffectTraversalMode::Matrix
            && self.current_x.abs() < 0.0001
            && self.current_y.abs() < 0.0001
        {
            AffectMatrixCell::new(AFFECT_MATRIX_SIZE / 2, AFFECT_MATRIX_SIZE / 2)
        } else {
            None
        };
        self.matrix_target = self.matrix_current;
        self.matrix_path.clear();
        self.matrix_elapsed = 0.0;
        self.held.clear();
        self.target_x = self.current_x;
        self.target_y = self.current_y;
    }

    fn enter_continuous_control(&mut self) {
        if self.traversal_mode != AffectTraversalMode::Continuous {
            self.set_traversal_mode(AffectTraversalMode::Continuous);
        }
    }

    pub fn set_action(&mut self, action: Action, pressed: bool) {
        if !action.is_directional() {
            return;
        }
        if pressed {
            self.enter_continuous_control();
        }
        match self.input_mode {
            InputMode::Step if pressed => self.apply_direction(action, self.step_size),
            InputMode::Step => {}
            InputMode::Continuous if pressed => {
                self.held.insert(action);
            }
            InputMode::Continuous => {
                self.held.remove(&action);
            }
        }
    }

    pub fn nudge(&mut self, action: Action) {
        if action.is_directional() {
            self.enter_continuous_control();
            self.apply_direction(action, self.step_size);
        }
    }

    pub fn reset(&mut self) {
        self.target_x = 0.0;
        self.target_y = 0.0;
        self.held.clear();
        self.matrix_path.clear();
        self.matrix_elapsed = 0.0;
        self.matrix_current = None;
        self.matrix_target = None;
        if self.traversal_mode == AffectTraversalMode::Matrix {
            self.current_x = 0.0;
            self.current_y = 0.0;
            self.matrix_current =
                AffectMatrixCell::new(AFFECT_MATRIX_SIZE / 2, AFFECT_MATRIX_SIZE / 2);
            self.matrix_target = self.matrix_current;
        }
    }

    pub fn set_target(&mut self, x: f32, y: f32) {
        self.enter_continuous_control();
        self.target_x = x.clamp(-1.0, 1.0);
        self.target_y = y.clamp(-1.0, 1.0);
        self.held.clear();
    }

    pub fn toggle_pause(&mut self) {
        self.animation_active = !self.animation_active;
    }

    pub fn set_animation_speed(&mut self, animation_speed: f32) {
        self.animation_speed = animation_speed.clamp(0.25, 4.0);
    }

    pub fn start_matrix_traversal(
        &mut self,
        target: AffectMatrixCell,
        steps_per_second: f32,
    ) -> bool {
        if !steps_per_second.is_finite()
            || !(MIN_MATRIX_STEPS_PER_SECOND..=MAX_MATRIX_STEPS_PER_SECOND)
                .contains(&steps_per_second)
        {
            return false;
        }
        if self.traversal_mode != AffectTraversalMode::Matrix {
            self.set_traversal_mode(AffectTraversalMode::Matrix);
        }
        self.matrix_steps_per_second = steps_per_second;
        self.matrix_target = Some(target);
        self.matrix_path.clear();
        self.matrix_elapsed = 0.0;
        self.held.clear();

        let start = self.matrix_current.unwrap_or_else(|| AffectMatrixCell {
            column: nearest_matrix_index(self.current_x, target.column),
            row: nearest_matrix_index(self.current_y, target.row),
        });
        self.apply_matrix_cell(start);
        let mut cursor = start;
        while cursor != target {
            cursor = cursor.step_toward(target);
            self.matrix_path.push_back(cursor);
        }
        let (target_x, target_y) = target.coordinates();
        self.target_x = target_x;
        self.target_y = target_y;
        true
    }

    pub fn stop_matrix_traversal(&mut self) {
        self.matrix_path.clear();
        self.matrix_elapsed = 0.0;
        self.matrix_target = self.matrix_current;
        self.target_x = self.current_x;
        self.target_y = self.current_y;
    }

    fn apply_matrix_cell(&mut self, cell: AffectMatrixCell) {
        let (x, y) = cell.coordinates();
        self.current_x = x;
        self.current_y = y;
        self.matrix_current = Some(cell);
    }

    fn apply_direction(&mut self, action: Action, amount: f32) {
        match action {
            Action::IncreaseValence => self.target_x += amount,
            Action::DecreaseValence => self.target_x -= amount,
            Action::IncreaseArousal => self.target_y += amount,
            Action::DecreaseArousal => self.target_y -= amount,
            _ => {}
        }
        self.target_x = self.target_x.clamp(-1.0, 1.0);
        self.target_y = self.target_y.clamp(-1.0, 1.0);
    }

    pub fn tick(&mut self, delta_seconds: f32) {
        let dt = delta_seconds.clamp(0.0, 0.05);
        if self.traversal_mode == AffectTraversalMode::Matrix {
            if !self.matrix_path.is_empty() {
                self.matrix_elapsed += dt;
                let step_interval = 1.0 / self.matrix_steps_per_second;
                if self.matrix_elapsed >= step_interval {
                    self.matrix_elapsed %= step_interval;
                    if let Some(cell) = self.matrix_path.pop_front() {
                        self.apply_matrix_cell(cell);
                    }
                }
            }
        } else {
            let horizontal = i8::from(self.held.contains(&Action::IncreaseValence))
                - i8::from(self.held.contains(&Action::DecreaseValence));
            let vertical = i8::from(self.held.contains(&Action::IncreaseArousal))
                - i8::from(self.held.contains(&Action::DecreaseArousal));
            self.target_x =
                (self.target_x + horizontal as f32 * self.continuous_speed * dt).clamp(-1.0, 1.0);
            self.target_y =
                (self.target_y + vertical as f32 * self.continuous_speed * dt).clamp(-1.0, 1.0);

            let smoothing = 1.0 - (-self.response * dt).exp();
            self.current_x =
                (self.current_x + (self.target_x - self.current_x) * smoothing).clamp(-1.0, 1.0);
            self.current_y =
                (self.current_y + (self.target_y - self.current_y) * smoothing).clamp(-1.0, 1.0);
        }

        if self.animation_active {
            let frequency = 1.5 + self.current_y;
            self.phase = (self.phase
                + dt * std::f32::consts::TAU * frequency * self.animation_speed)
                .rem_euclid(std::f32::consts::TAU);
        }
        self.sequence = self.sequence.wrapping_add(1);
    }

    pub(crate) fn snapshot(&self, context: SnapshotContext<'_>) -> AffectSnapshot {
        let radius = self.current_x.hypot(self.current_y).min(1.0);
        let angle_degrees = if self.current_x.abs() < 0.005 && self.current_y.abs() < 0.005 {
            0.0
        } else {
            (self.current_x.atan2(self.current_y) + std::f32::consts::PI)
                .rem_euclid(std::f32::consts::TAU)
                .to_degrees()
        };
        AffectSnapshot {
            session_id: self.session_id.to_string(),
            sequence: self.sequence,
            current_x: self.current_x,
            current_y: self.current_y,
            target_x: self.target_x,
            target_y: self.target_y,
            phase: self.phase,
            animation_active: self.animation_active,
            input_active: !self.held.is_empty(),
            radius,
            angle_degrees,
            overlay_visible: context.overlay_visible,
            overlay_editing: context.overlay_editing,
            overlay_opacity: context.overlay_opacity,
            overlay_size: context.overlay_size,
            animation_speed: context.animation_speed,
            amplitude_scale: context.amplitude_scale,
            disorder_scale: context.disorder_scale,
            base_shape: context.base_shape,
            palette: context.palette,
            lsl_state: context.lsl_state.to_owned(),
            lsl_message: context.lsl_message.to_owned(),
            traversal_mode: self.traversal_mode,
            matrix_size: AFFECT_MATRIX_SIZE,
            matrix_current: self.matrix_current,
            matrix_target: self.matrix_target,
            matrix_traversing: !self.matrix_path.is_empty(),
            matrix_steps_per_second: self.matrix_steps_per_second,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> AffectEngine {
        AffectEngine::new(InputMode::Continuous, 0.1, 0.8, 8.0, 1.0)
    }

    #[test]
    fn continuous_input_is_frame_rate_independent() {
        let mut fine = engine();
        fine.set_action(Action::IncreaseValence, true);
        for _ in 0..100 {
            fine.tick(0.01);
        }
        let mut coarse = engine();
        coarse.set_action(Action::IncreaseValence, true);
        for _ in 0..20 {
            coarse.tick(0.05);
        }
        assert!((fine.target_x - coarse.target_x).abs() < 0.0001);
    }

    #[test]
    fn opposite_actions_cancel() {
        let mut value = engine();
        value.set_action(Action::IncreaseValence, true);
        value.set_action(Action::DecreaseValence, true);
        value.tick(0.05);
        assert_eq!(value.target_x, 0.0);
    }

    #[test]
    fn nudge_and_reset_clamp_targets() {
        let mut value = engine();
        for _ in 0..30 {
            value.nudge(Action::IncreaseArousal);
        }
        assert_eq!(value.target_y, 1.0);
        value.reset();
        assert_eq!(value.target_y, 0.0);
    }

    #[test]
    fn reset_returns_smoothly_not_instantly() {
        let mut value = engine();
        value.nudge(Action::IncreaseValence);
        value.tick(0.05);
        let before = value.current_x;
        value.reset();
        assert_eq!(value.target_x, 0.0);
        assert_eq!(value.current_x, before);
        value.tick(0.05);
        assert!(value.current_x < before);
    }

    #[test]
    fn direct_target_selection_clamps_coordinates() {
        let mut value = engine();
        value.set_target(2.0, -3.0);
        assert_eq!(value.target_x, 1.0);
        assert_eq!(value.target_y, -1.0);
    }

    #[test]
    fn animation_speed_multiplier_changes_phase_rate() {
        let mut normal = engine();
        let mut fast = engine();
        fast.set_animation_speed(2.0);
        normal.tick(0.05);
        fast.tick(0.05);
        assert!((fast.phase - normal.phase * 2.0).abs() < 0.0001);
    }

    #[test]
    fn matrix_coordinates_cover_one_hundred_twenty_one_symmetric_states() {
        assert_eq!(AFFECT_MATRIX_SIZE, 11);
        assert_eq!(matrix_coordinate(0), -1.0);
        assert_eq!(matrix_coordinate(AFFECT_MATRIX_SIZE - 1), 1.0);
        for index in 0..AFFECT_MATRIX_SIZE {
            let opposite = AFFECT_MATRIX_SIZE - 1 - index;
            assert!((matrix_coordinate(index) + matrix_coordinate(opposite)).abs() < 0.0001);
        }
        assert_eq!(matrix_coordinate(5), 0.0);
    }

    #[test]
    fn neutral_matrix_start_chooses_the_center_cell_toward_the_destination() {
        let mut value = engine();
        value.set_traversal_mode(AffectTraversalMode::Matrix);
        let target = AffectMatrixCell::new(0, 10).unwrap();
        assert!(value.start_matrix_traversal(target, 5.0));
        assert_eq!(value.matrix_current, AffectMatrixCell::new(5, 5));
        assert_eq!(value.current_x, matrix_coordinate(5));
        assert_eq!(value.current_y, matrix_coordinate(5));
    }

    #[test]
    fn matrix_path_uses_diagonals_before_cardinal_steps() {
        let mut value = engine();
        value.set_traversal_mode(AffectTraversalMode::Matrix);
        value.apply_matrix_cell(AffectMatrixCell::new(0, 0).unwrap());
        let target = AffectMatrixCell::new(3, 8).unwrap();
        assert!(value.start_matrix_traversal(target, 5.0));
        let path = value.matrix_path.iter().copied().collect::<Vec<_>>();
        assert_eq!(path.len(), 8);
        assert_eq!(path[0], AffectMatrixCell::new(1, 1).unwrap());
        assert_eq!(path[2], AffectMatrixCell::new(3, 3).unwrap());
        assert_eq!(path[3], AffectMatrixCell::new(3, 4).unwrap());
        assert_eq!(path.last().copied(), Some(target));
    }

    #[test]
    fn matrix_motion_holds_then_jumps_to_an_exact_neighbor() {
        let mut value = engine();
        value.set_traversal_mode(AffectTraversalMode::Matrix);
        let start = AffectMatrixCell::new(0, 0).unwrap();
        value.apply_matrix_cell(start);
        assert!(value.start_matrix_traversal(AffectMatrixCell::new(2, 2).unwrap(), 5.0));
        for _ in 0..3 {
            value.tick(0.05);
        }
        assert_eq!(value.matrix_current, Some(start));
        value.tick(0.05);
        assert_eq!(value.matrix_current, AffectMatrixCell::new(1, 1));
        assert_eq!(value.current_x, matrix_coordinate(1));
        assert_eq!(value.current_y, matrix_coordinate(1));
    }

    #[test]
    fn matrix_reset_is_the_exact_central_neutral_state() {
        let mut value = engine();
        value.set_traversal_mode(AffectTraversalMode::Matrix);
        assert!(value.start_matrix_traversal(AffectMatrixCell::new(10, 10).unwrap(), 5.0));
        value.reset();
        assert_eq!(value.traversal_mode, AffectTraversalMode::Matrix);
        assert_eq!(value.current_x, 0.0);
        assert_eq!(value.current_y, 0.0);
        assert_eq!(value.matrix_current, AffectMatrixCell::new(5, 5));
        assert_eq!(value.matrix_target, AffectMatrixCell::new(5, 5));
        assert!(value.matrix_path.is_empty());
    }

    #[test]
    fn direct_continuous_input_cancels_matrix_traversal() {
        let mut value = engine();
        value.set_traversal_mode(AffectTraversalMode::Matrix);
        assert!(value.start_matrix_traversal(AffectMatrixCell::new(10, 10).unwrap(), 5.0));
        value.set_target(-0.25, 0.5);
        assert_eq!(value.traversal_mode, AffectTraversalMode::Continuous);
        assert!(value.matrix_path.is_empty());
        assert_eq!(value.target_x, -0.25);
        assert_eq!(value.target_y, 0.5);
    }

    #[test]
    fn matrix_rate_is_validated_before_mutation() {
        let mut value = engine();
        let target = AffectMatrixCell::new(10, 10).unwrap();
        assert!(!value.start_matrix_traversal(target, f32::NAN));
        assert!(!value.start_matrix_traversal(target, 20.0));
        assert_eq!(value.traversal_mode, AffectTraversalMode::Continuous);
    }
}
